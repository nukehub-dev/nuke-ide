#!/usr/bin/env python3
"""FEM service for nuke-cad.

Builds a CalculiX input deck from a gmsh volume mesh, runs ccx, and converts the
resulting FRD file to a legacy VTK unstructured grid for visualization in
nuke-visualizer.

Progress and diagnostics are emitted on stderr. One final JSON object is
printed on stdout (stdout-JSON protocol used across NukeIDE backends).
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import traceback
from pathlib import Path
from typing import Any

# Ensure sibling modules are importable when run as a script.
_SCRIPT_DIR = Path(__file__).parent.resolve()
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from material_data import BUILTIN_MATERIAL_CARDS, builtin_card  # noqa: E402

# Optional heavy dependencies. The module must remain importable without them.
try:
    import numpy as np

    HAS_NUMPY = True
except ImportError:
    np = None  # type: ignore
    HAS_NUMPY = False

try:
    import gmsh

    HAS_GMSH = True
except ImportError:
    gmsh = None  # type: ignore
    HAS_GMSH = False


class MeshData:
    """Simple container for a gmsh volume mesh and its named sets."""

    def __init__(
        self,
        points: Any,
        elements: Any,
        blocks: dict[str, Any],
        surface_sets: dict[str, Any],
    ) -> None:
        self.points = points
        self.elements = elements
        self.blocks = blocks
        self.surface_sets = surface_sets


def _print_progress(message: str) -> None:
    """Emit a progress line on stderr."""
    print(message, file=sys.stderr, flush=True)


def _require_deps() -> None:
    """Raise a clear error if any required heavy dependency is missing."""
    missing: list[str] = []
    if not HAS_NUMPY:
        missing.append("numpy")
    if not HAS_GMSH:
        missing.append("gmsh")
    if missing:
        raise RuntimeError(f"FEM service requires: {', '.join(missing)}")


# Display names for the built-in cards (deck ``*Material`` labels). The
# numeric payload lives in the versioned ``material_data`` table.
_BUILTIN_DISPLAY_NAMES: dict[str, str] = {
    "structural_steel": "Structural Steel",
    "aluminum": "Aluminum",
    "copper": "Copper",
    "uo2": "UO2",
    "zircaloy": "Zircaloy-4",
    "concrete": "Concrete",
}


def _card_to_fem_material(material_key: str, card: dict[str, Any]) -> dict[str, Any]:
    """Convert an ``{E, nu, rho, k, cp, alpha[, yield]}`` card to deck properties.

    Field units are documented in ``material_data.MATERIAL_UNITS``. Missing
    fields stay absent (the ``*Material`` writer skips them); ``cp`` is
    stored on the card for future coupled-physics use and is not emitted.
    ``yield`` (yield strength) is carried as ``yieldStrength`` for the
    safety-factor result pipeline; like ``cp`` it is never written to the
    deck. Cards without ``yield`` simply omit the safety factor downstream
    (reported, never defaulted).
    """
    converted = {
        "name": _BUILTIN_DISPLAY_NAMES.get(material_key, material_key),
        "youngsModulus": float(card.get("E", 0.0)),
        "poissonsRatio": float(card.get("nu", 0.0)),
        "density": float(card.get("rho", 0.0)),
        "conductivity": float(card.get("k", 0.0)),
        "specificHeat": float(card.get("cp", 0.0)),
        "expansion": float(card.get("alpha", 0.0)),
    }
    if card.get("yield") is not None:
        converted["yieldStrength"] = float(card["yield"])
    return converted


def _builtin_materials() -> dict[str, dict[str, Any]]:
    """Return the built-in materials as deck property dicts.

    Derived from the versioned ``material_data`` table; the key set always
    matches ``material_data.builtin_material_names()``.
    """
    return {key: _card_to_fem_material(key, builtin_card(key)) for key in BUILTIN_MATERIAL_CARDS}


def _resolve_materials(
    materials_input: dict[str, Any] | None,
    material_cards: dict[str, Any] | None = None,
) -> dict[str, dict[str, Any]]:
    """Resolve a user material map against manifest cards and the built-ins.

    ``materials_input`` maps a CalculiX element-set name to either a material
    name or a complete material property dict. Name references resolve
    manifest-first: a card in ``material_cards`` (the region manifest's
    additive ``materials`` block) wins for that name, built-in cards fill the
    rest. Unknown names raise ``ValueError`` loudly — never a silent default.
    Complete property dicts pass through unchanged.
    """
    result: dict[str, dict[str, Any]] = {}
    if materials_input is None:
        return result
    cards = material_cards or {}
    for block_name, value in materials_input.items():
        if isinstance(value, str):
            card = cards.get(value)
            if isinstance(card, dict):
                result[block_name] = _card_to_fem_material(value, card)
            elif value in BUILTIN_MATERIAL_CARDS:
                result[block_name] = _card_to_fem_material(value, builtin_card(value))
            else:
                raise ValueError(f"Unknown material reference for block '{block_name}': {value}")
        elif isinstance(value, dict):
            result[block_name] = value
        else:
            raise ValueError(f"Unknown material reference for block '{block_name}': {value}")
    return result


def _element_type_name(num_nodes: int) -> str:
    """Return the CalculiX element type for a tetrahedron node count."""
    if num_nodes == 4:
        return "C3D4"
    if num_nodes == 10:
        return "C3D10"
    raise ValueError(f"Unsupported tetrahedron node count: {num_nodes}")


def _read_gmsh_mesh(msh_path: str) -> MeshData:
    """Read a gmsh .msh file and return dense mesh data plus named sets."""
    if gmsh is None or np is None:
        raise RuntimeError("gmsh and numpy are required")

    gmsh_initialized = False
    try:
        gmsh.initialize()
        gmsh_initialized = True
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.open(msh_path)
        gmsh.model.occ.synchronize()

        node_tags, coords, _ = gmsh.model.mesh.getNodes()
        gmsh_to_dense: dict[int, int] = {}
        points: list[list[float]] = []
        for tag, x, y, z in zip(node_tags, coords[0::3], coords[1::3], coords[2::3], strict=True):
            gmsh_to_dense[int(tag)] = len(points)
            points.append([float(x), float(y), float(z)])

        # Read all 3D elements into a flat list.  Each element stores a block
        # name (initially empty) and dense node indices.
        elements: list[dict[str, Any]] = []
        elem_tag_to_index: dict[int, int] = {}
        for _, vol_tag in gmsh.model.getEntities(3):
            elem_types, elem_tags, elem_node_tags = gmsh.model.mesh.getElements(3, vol_tag)
            for etype, tags, nodes in zip(elem_types, elem_tags, elem_node_tags, strict=True):
                npe = gmsh.model.mesh.getElementProperties(etype)[3]
                for i, tag in enumerate(tags):
                    tag = int(tag)
                    elem_tag_to_index[tag] = len(elements)
                    conn = [gmsh_to_dense[int(n)] for n in nodes[i * npe : (i + 1) * npe]]
                    elements.append(
                        {
                            "tag": tag,
                            "dim": 3,
                            "parentTag": int(vol_tag),
                            "nodes": conn,
                            "block": "",
                        }
                    )

        # Read all 2D surface elements.  These are used for boundary sets.
        surface_elems: list[dict[str, Any]] = []
        for _, surf_tag in gmsh.model.getEntities(2):
            elem_types, elem_tags, elem_node_tags = gmsh.model.mesh.getElements(2, surf_tag)
            for etype, tags, nodes in zip(elem_types, elem_tags, elem_node_tags, strict=True):
                npe = gmsh.model.mesh.getElementProperties(etype)[3]
                for i, tag in enumerate(tags):
                    tag = int(tag)
                    conn = [gmsh_to_dense[int(n)] for n in nodes[i * npe : (i + 1) * npe]]
                    surface_elems.append(
                        {
                            "tag": tag,
                            "dim": 2,
                            "parentTag": int(surf_tag),
                            "nodes": conn[:3],  # corner nodes for face matching
                            "block": "",
                        }
                    )

        # Bucket element indices by parent entity tag once, so physical-group
        # assignment is O(entities + elements) instead of O(entities x elements).
        volume_by_parent: dict[int, list[int]] = {}
        for idx, elem in enumerate(elements):
            volume_by_parent.setdefault(elem["parentTag"], []).append(idx)
        surface_by_parent: dict[int, list[int]] = {}
        for idx, elem in enumerate(surface_elems):
            surface_by_parent.setdefault(elem["parentTag"], []).append(idx)

        # Assign physical-group names to volume and surface blocks.
        blocks: dict[str, Any] = {}
        surface_sets: dict[str, Any] = {}
        for dim, ptag in gmsh.model.getPhysicalGroups():
            name = gmsh.model.getPhysicalName(dim, ptag)
            entities = gmsh.model.getEntitiesForPhysicalGroup(dim, ptag)
            if dim == 3:
                indices: list[int] = []
                for ent in entities:
                    for idx in volume_by_parent.get(int(ent), []):
                        elements[idx]["block"] = name
                        indices.append(idx)
                if indices:
                    blocks[name] = np.array(indices, dtype=int)
            elif dim == 2:
                indices = []
                for ent in entities:
                    for idx in surface_by_parent.get(int(ent), []):
                        surface_elems[idx]["block"] = name
                        indices.append(idx)
                if indices:
                    surface_sets[name] = {
                        "indices": np.array(indices, dtype=int),
                        "elements": surface_elems,
                    }

        # Unnamed elements share a single fallback block (not one block each).
        unnamed = [idx for idx, elem in enumerate(elements) if not elem["block"]]
        if unnamed:
            fallback = "block_1" if "block_1" not in blocks else "unnamed"
            for idx in unnamed:
                elements[idx]["block"] = fallback
            blocks[fallback] = np.array(unnamed, dtype=int)

        return MeshData(np.array(points, dtype=np.float64), elements, blocks, surface_sets)
    finally:
        if gmsh_initialized:
            try:
                gmsh.finalize()
            except Exception:
                pass


def _surface_node_set(mesh: MeshData, surface_name: str) -> set[int]:
    """Return the set of 0-based node indices belonging to a named surface."""
    surf = mesh.surface_sets.get(surface_name)
    if surf is None:
        return set()
    nodes: set[int] = set()
    for idx in surf["indices"]:
        nodes.update(int(n) for n in surf["elements"][idx]["nodes"])
    return nodes


def _surface_area_and_normal(mesh: MeshData, surface_name: str) -> tuple[float, list[float]]:
    """Return ``(total_area, average_unit_normal)`` for a surface set."""
    if np is None:
        return 0.0, [0.0, 0.0, 1.0]
    surf = mesh.surface_sets.get(surface_name)
    if surf is None or len(surf["indices"]) == 0:
        return 0.0, [0.0, 0.0, 1.0]

    total_area = 0.0
    normal = np.zeros(3)
    for idx in surf["indices"]:
        tri = surf["elements"][idx]["nodes"]
        a = mesh.points[int(tri[0])]
        b = mesh.points[int(tri[1])]
        c = mesh.points[int(tri[2])]
        ab = b - a
        ac = c - a
        n = np.cross(ab, ac)
        area = 0.5 * float(np.linalg.norm(n))
        total_area += area
        if area > 0:
            normal += n / np.linalg.norm(n) * area

    norm = float(np.linalg.norm(normal))
    if norm > 0:
        avg_normal = [float(v) for v in normal / norm]
    else:
        avg_normal = [0.0, 0.0, 1.0]
    return total_area, avg_normal


#: Tetrahedral element face table from the CalculiX manual (``*DLOAD``
#: page): face number -> corner-node positions (0-based) in deck
#: connectivity order. Applies to C3D4 and to the corner nodes (the first
#: four entries) of C3D10. Faces are matched as order-independent node
#: triples, so surface winding never matters.
_TET_FACES: tuple[tuple[int, int, int], ...] = (
    (0, 1, 2),  # face 1
    (0, 3, 1),  # face 2
    (1, 3, 2),  # face 3
    (2, 3, 0),  # face 4
)


def _deck_element_ids(mesh: MeshData) -> dict[int, int]:
    """Map volume-element list index to the deck element id.

    Mirrors ``_write_element_sections`` exactly (sequential ids across blocks
    in ``mesh.blocks`` order, empty blocks skipped) so face loads target the
    same ids CalculiX will read.
    """
    ids: dict[int, int] = {}
    next_id = 1
    for _block_name, indices in mesh.blocks.items():
        if len(indices) == 0:
            continue
        for idx in indices:
            ids[int(idx)] = next_id
            next_id += 1
    return ids


def _pressure_face_loads(mesh: MeshData, surface_name: str) -> tuple[list[tuple[int, int]], int]:
    """Return ``((deck_element_id, face_number), ...)`` pairs for a surface set.

    Each surface corner triangle is matched (order-independent) against the
    corner nodes of the volume elements; the face whose corner triple equals
    the triangle is the loaded face. A triangle on an internal (shared) face
    loads every adjacent volume face. The second return value counts surface
    triangles with no containing volume element (non-conforming sets), which
    the caller reports instead of silently dropping.
    """
    surf = mesh.surface_sets.get(surface_name)
    if surf is None or len(surf["indices"]) == 0:
        return [], 0
    deck_ids = _deck_element_ids(mesh)
    # Node -> volume element indices (corner nodes only) for fast lookup.
    node_to_elems: dict[int, list[int]] = {}
    for idx, elem in enumerate(mesh.elements):
        corners = elem["nodes"][:4] if len(elem["nodes"]) > 4 else elem["nodes"]
        for n in corners:
            node_to_elems.setdefault(int(n), []).append(idx)
    pairs: list[tuple[int, int]] = []
    seen: set[tuple[int, int]] = set()
    unmatched = 0
    for s_idx in surf["indices"]:
        tri = {int(n) for n in surf["elements"][int(s_idx)]["nodes"][:3]}
        matched = False
        for e_idx in node_to_elems.get(next(iter(tri)), []):
            elem = mesh.elements[e_idx]
            corners = [
                int(n) for n in (elem["nodes"][:4] if len(elem["nodes"]) > 4 else elem["nodes"])
            ]
            if not tri.issubset(corners):
                continue
            for face_no, face in enumerate(_TET_FACES, start=1):
                if {corners[i] for i in face} == tri:
                    deck_id = deck_ids.get(e_idx)
                    if deck_id is not None and (deck_id, face_no) not in seen:
                        seen.add((deck_id, face_no))
                        pairs.append((deck_id, face_no))
                    matched = True
                    break
        if not matched:
            unmatched += 1
    return pairs, unmatched


def _write_node_section(mesh: MeshData, f: Any) -> None:
    """Write the *Node section."""
    f.write("*Node\n")
    for i, p in enumerate(mesh.points, start=1):
        f.write(f"{i}, {p[0]:.12g}, {p[1]:.12g}, {p[2]:.12g}\n")


def _write_element_sections(mesh: MeshData, f: Any) -> None:
    """Write *Element sections grouped by block."""
    global_elem_id = 1
    for block_name, indices in mesh.blocks.items():
        if len(indices) == 0:
            continue
        sample = mesh.elements[int(indices[0])]
        etype = _element_type_name(len(sample["nodes"]))
        f.write(f"*Element, type={etype}, elset={block_name}\n")
        for idx in indices:
            elem = mesh.elements[int(idx)]
            nodes = ",".join(str(int(n) + 1) for n in elem["nodes"])
            f.write(f"{global_elem_id}, {nodes}\n")
            global_elem_id += 1


def _write_nsets_for_surfaces(mesh: MeshData, f: Any) -> None:
    """Write *Nset sections for every named surface."""
    for name in mesh.surface_sets:
        nodes = sorted(_surface_node_set(mesh, name))
        if not nodes:
            continue
        f.write(f"*Nset, nset={name}\n")
        for node_id in nodes:
            f.write(f"{node_id + 1}\n")


def _write_materials(materials: dict[str, dict[str, Any]], step_type: str, f: Any) -> None:
    """Write *Material blocks."""
    seen: set[str] = set()
    for block_name, mat in materials.items():
        mat_name = mat.get("name") or block_name
        if mat_name in seen:
            continue
        seen.add(mat_name)
        f.write(f"*Material, name={mat_name}\n")
        if step_type != "heatTransfer":
            e = float(mat.get("youngsModulus", 0))
            nu = float(mat.get("poissonsRatio", 0))
            if e > 0:
                f.write(f"*Elastic\n{e:.12g}, {nu:.12g}\n")
        if step_type in ("heatTransfer", "static"):
            k = float(mat.get("conductivity", 0))
            if k > 0:
                f.write(f"*Conductivity\n{k:.12g}\n")
        rho = float(mat.get("density", 0))
        if rho > 0:
            f.write(f"*Density\n{rho:.12g}\n")
        alpha = float(mat.get("expansion", 0))
        if alpha != 0 and step_type != "heatTransfer":
            f.write(f"*Expansion\n{alpha:.12g}\n")


def _write_sections(mesh: MeshData, materials: dict[str, dict[str, Any]], f: Any) -> None:
    """Write *Solid Section for each block that has a material."""
    for block_name, indices in mesh.blocks.items():
        if len(indices) == 0:
            continue
        mat = materials.get(block_name)
        if mat is None:
            continue
        mat_name = mat.get("name") or block_name
        f.write(f"*Solid Section, elset={block_name}, material={mat_name}\n")


def _write_boundary_conditions(
    mesh: MeshData,
    boundary_conditions: list[dict[str, Any]],
    f: Any,
) -> list[str]:
    """Write *Boundary, *Temperature, *Dload, and *Cflux cards for BCs.

    - ``fixed`` pins translational dofs 1-3 through the surface node set
      (CalculiX does not accept Abaqus predefined labels like ENCASTRE).
    - ``displacement`` prescribes dof values per surface node.
    - ``pressure`` applies a uniform normal traction as element-face
      ``*DLOAD`` ``P<face>`` loads (positive = compressive pressure,
      negative = tension, per the CalculiX ``*DLOAD`` convention). Faces
      are resolved from the surface set's corner triangles against the
      volume elements, so the load is mesh-independent; unlike the other
      BCs it needs no node set and ignores any ``vector`` field (traction
      acts along the face normal).
    - ``temperature`` prescribes nodal temperatures via ``*TEMPERATURE``
      (valid in static thermomechanical and heat-transfer steps alike).
    - ``heatFlux`` distributes a total flux over the surface nodes.

    Returns warnings (unknown surfaces are skipped quietly as before; only
    non-conforming pressure faces are reported).
    """
    warnings: list[str] = []
    fixed_lines: list[str] = []
    disp_lines: list[str] = []
    temp_lines: list[str] = []
    dload_lines: list[str] = []
    cflux_lines: list[str] = []

    for bc in boundary_conditions:
        bc_type = bc.get("type")
        surf = bc.get("surfaceName")

        if bc_type == "pressure":
            # Element-face loads need no node set; resolve faces directly.
            magnitude = float(bc.get("magnitude", 0))
            pairs, unmatched = _pressure_face_loads(mesh, surf)
            for deck_id, face_no in pairs:
                dload_lines.append(f"{deck_id}, P{face_no}, {magnitude:.12g}")
            if unmatched:
                warnings.append(
                    f"Pressure on surface '{surf}': {unmatched} triangle(s) "
                    "match no volume element face and were skipped."
                )
            continue

        nodes = sorted(_surface_node_set(mesh, surf))
        if not nodes:
            continue

        if bc_type == "fixed":
            # CalculiX does not accept Abaqus predefined labels (ENCASTRE & co.);
            # pin translational dofs 1-3 through the surface node set instead.
            fixed_lines.append(f"{surf}, 1, 3")
        elif bc_type == "displacement":
            vector = bc.get("vector") or [0.0, 0.0, 1.0]
            magnitude = float(bc.get("magnitude", 0))
            for n in nodes:
                for dof, v in enumerate(vector, start=1):
                    value = magnitude * float(v)
                    if abs(value) > 0:
                        disp_lines.append(f"{n + 1}, {dof}, {dof}, {value:.12g}")
        elif bc_type == "temperature":
            temp = float(bc.get("temperature", 0))
            for n in nodes:
                temp_lines.append(f"{n + 1}, {temp:.12g}")
        elif bc_type == "heatFlux":
            magnitude = float(bc.get("magnitude", 0))
            area, _ = _surface_area_and_normal(mesh, surf)
            if area <= 0:
                continue
            heat = magnitude * area / len(nodes)
            for n in nodes:
                cflux_lines.append(f"{n + 1}, 11, {heat:.12g}")

    if fixed_lines:
        f.write("*Boundary\n")
        for line in fixed_lines:
            f.write(line + "\n")
    if disp_lines:
        f.write("*Boundary\n")
        for line in disp_lines:
            f.write(line + "\n")
    if temp_lines:
        f.write("*Temperature\n")
        for line in temp_lines:
            f.write(line + "\n")
    if dload_lines:
        f.write("*Dload\n")
        for line in dload_lines:
            f.write(line + "\n")
    if cflux_lines:
        f.write("*Cflux\n")
        for line in cflux_lines:
            f.write(line + "\n")
    return warnings


def _write_step(
    mesh: MeshData,
    step: dict[str, Any],
    boundary_conditions: list[dict[str, Any]],
    f: Any,
) -> list[str]:
    """Write the *Step block including BCs, loads, and output requests.

    ``stepType`` selects ``*Static`` (default — an absent or unknown value
    stays static), ``*Heat Transfer``, or ``*Frequency``. Returns warnings
    forwarded from the boundary-condition writer.
    """
    step_type = step.get("stepType", "static")
    f.write("*Step, name=Step-1, nlgeom=NO\n")
    if step_type == "heatTransfer":
        f.write("*Heat Transfer, steady state\n")
        time = float(step.get("time", 1))
        inc = float(step.get("initialTimeIncrement", time))
        f.write(f"{time:.12g}, {inc:.12g}\n")
    elif step_type == "frequency":
        f.write("*Frequency\n")
        f.write("1\n")
    else:
        f.write("*Static\n")
        time = float(step.get("time", 1))
        inc = float(step.get("initialTimeIncrement", time))
        f.write(f"{time:.12g}, {inc:.12g}\n")

    bc_warnings = _write_boundary_conditions(mesh, boundary_conditions, f)

    gravity = step.get("gravity")
    if gravity and step_type != "heatTransfer":
        gvec = gravity.get("vector") or [0.0, 0.0, -1.0]
        gmag = float(gravity.get("magnitude", 9.81))
        f.write("*Dload\n")
        f.write(f"AllElements, GRAV, {gmag:.12g}, {gvec[0]:.12g}, {gvec[1]:.12g}, {gvec[2]:.12g}\n")

    if step_type == "heatTransfer":
        f.write("*Node File\n")
        f.write("NT\n")
        f.write("*El File\n")
        f.write("HFL\n")
    else:
        f.write("*Node File\n")
        f.write("U\n")
        f.write("*El File\n")
        f.write("S, E\n")
    f.write("*End Step\n")
    return bc_warnings


def _write_all_elements_nset(mesh: MeshData, f: Any) -> None:
    """Write an element set containing every volume element."""
    total = sum(len(v) for v in mesh.blocks.values())
    if total > 0:
        f.write("*Elset, elset=AllElements, generate\n")
        f.write(f"1, {total}, 1\n")


def write_inp(
    mesh: MeshData,
    output_path: Path,
    materials: dict[str, dict[str, Any]],
    boundary_conditions: list[dict[str, Any]],
    step: dict[str, Any],
) -> list[str]:
    """Write a CalculiX .inp file for the given mesh and configuration.

    Returns a list of warnings (e.g. blocks that fell back to the default
    material).
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Ensure every block has a material so CalculiX does not error out.
    warnings: list[str] = []
    builtins = _builtin_materials()
    default_mat = builtins["structural_steel"]
    for block_name in mesh.blocks:
        if block_name not in materials:
            materials[block_name] = default_mat
            warnings.append(
                f"Block '{block_name}' had no material; using default structural steel."
            )

    with output_path.open("w", encoding="utf-8") as f:
        f.write("*Heading\n")
        f.write(f"Generated by nuke-cad fem_service: {output_path.name}\n")
        _write_node_section(mesh, f)
        _write_element_sections(mesh, f)
        _write_nsets_for_surfaces(mesh, f)
        _write_all_elements_nset(mesh, f)
        _write_materials(materials, step.get("stepType", "static"), f)
        _write_sections(mesh, materials, f)
        warnings.extend(_write_step(mesh, step, boundary_conditions, f))

    return warnings


def _find_ccx(ccx_path: str | None = None) -> str:
    """Resolve the CalculiX executable path."""
    if ccx_path:
        return ccx_path
    if os.environ.get("NUKE_CCX"):
        return os.environ.get("NUKE_CCX")  # type: ignore
    resolved = shutil.which("ccx")
    if resolved:
        return resolved
    resolved = shutil.which("ccx_2.22")
    if resolved:
        return resolved
    resolved = shutil.which("ccx_2.21")
    if resolved:
        return resolved
    resolved = shutil.which("ccx_2.20")
    if resolved:
        return resolved
    raise RuntimeError("CalculiX executable 'ccx' not found. Set NUKE_CCX or pass --ccx.")


def _run_ccx(
    inp_path: Path,
    ccx_path: str,
    timeout: float = 3600.0,
    max_output_bytes: int = 1_048_576,
) -> dict[str, Any]:
    """Run CalculiX on the input deck and return file paths and output.

    stdout/stderr are streamed to ``<stem>.ccx.log`` so memory stays bounded
    no matter how chatty ccx gets; only a tail of at most
    ``max_output_bytes`` (default 1 MB) is kept in the returned JSON dict.
    """
    working_dir = inp_path.parent
    stem = inp_path.stem
    log_path = working_dir / f"{stem}.ccx.log"

    result: dict[str, Any] = {
        "success": False,
        "frdPath": str(working_dir / f"{stem}.frd"),
        "datPath": str(working_dir / f"{stem}.dat"),
        "logPath": str(log_path),
        "stdout": "",
        "stderr": "",
        "error": None,
    }

    def _log_tail() -> str:
        if not log_path.exists():
            return ""
        size = log_path.stat().st_size
        with log_path.open("rb") as f:
            if size > max_output_bytes:
                f.seek(size - max_output_bytes)
            return f.read().decode("utf-8", errors="replace")

    _print_progress(f"Running CalculiX: {ccx_path} -i {stem}")
    try:
        with log_path.open("w", encoding="utf-8") as log:
            proc = subprocess.run(
                [ccx_path, "-i", stem],
                cwd=str(working_dir),
                stdout=log,
                stderr=subprocess.STDOUT,
                check=False,
                timeout=timeout,
            )
        result["stdout"] = _log_tail()
        if proc.returncode != 0:
            result["error"] = f"CalculiX exited with code {proc.returncode}"
            return result
        result["success"] = True
    except subprocess.TimeoutExpired:
        result["stdout"] = _log_tail()
        result["error"] = f"CalculiX timed out after {timeout:.0f} s"
    except Exception as exc:
        result["error"] = f"Failed to run CalculiX: {exc}"
        result["traceback"] = traceback.format_exc()

    return result


def _parse_frd_results(frd_path: Path) -> dict[str, dict[int, list[float]]]:
    """Parse nodal results from a CalculiX FRD file.

    Follows the real cgx/ccx fixed-width format (cgx manual "Result Format"
    section; ccx ``frd.c``):

    - ``-4`` record: result name in a fixed 8-char field after the key,
      followed by bookkeeping integers. The name may be padded
      (`` -4  NDTEMP      1    1``) or glued to the key (``-4DISP ...``).
    - ``-5`` records: one per result component, plus a trailing ``ALL``
      magnitude pseudo-component for vector/tensor results.
    - ``-1`` records: 10-char node id, then one 12-char fixed-width float per
      component; values may be concatenated without separating blanks
      (e.g. ``-1.23456E-03-2.34567E-04``).

    Returns a mapping ``result_name -> {node_id -> [values]}``. Only the last
    increment is retained for each result name.
    """
    results: dict[str, dict[int, list[float]]] = {}
    if not frd_path.exists():
        return results

    current_name: str | None = None
    current_values: dict[int, list[float]] = {}
    ncomps = 0

    with frd_path.open("r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            stripped = line.lstrip()
            if stripped.startswith("-4"):
                # Store the previous block; only the last increment survives.
                if current_name is not None and current_values:
                    results[current_name] = current_values
                current_name = stripped[2:10].strip()
                current_values = {}
                ncomps = 0
            elif stripped.startswith("-5") and current_name is not None:
                # One -5 record per component; "ALL" is a magnitude
                # pseudo-component that carries no data column.
                if stripped[2:10].strip() != "ALL":
                    ncomps += 1
            elif stripped.startswith("-1") and current_name is not None:
                body = stripped[2:].rstrip()
                count = ncomps
                if count <= 0:
                    # No -5 records seen: infer the component count from the
                    # fixed 12-char value columns.
                    count = max(0, (len(body) - 10) // 12)
                if count <= 0:
                    continue
                try:
                    node_id = int(body[:10])
                    values = [float(body[10 + 12 * i : 22 + 12 * i]) for i in range(count)]
                except ValueError:
                    # Lenient fallback for space-separated values.
                    parts = body.split()
                    if len(parts) < 1 + count:
                        continue
                    try:
                        node_id = int(parts[0])
                        values = [float(p) for p in parts[1 : 1 + count]]
                    except ValueError:
                        continue
                current_values[node_id] = values
            elif stripped.startswith("-3") and current_name is not None:
                results[current_name] = current_values
                current_name = None
                current_values = {}
                ncomps = 0

    # Tolerate a final block without a closing -3 record.
    if current_name is not None and current_values:
        results[current_name] = current_values

    results.update(_derive_stress_quantities(results))

    return results


def _derive_stress_quantities(
    results: dict[str, dict[int, list[float]]],
) -> dict[str, dict[int, list[float]]]:
    """Derive von Mises and max-principal stresses from nodal STRESS.

    Expects the CalculiX six-component order (SXX, SYY, SZZ, SXY, SYZ, SXZ)
    per node, as written for ``*EL FILE, S`` output. Returns
    ``{"MISES": ..., "MAXPRIN": ...}`` in the same
    ``{node_id -> [value]}`` shape as the parsed blocks, so downstream
    writers treat them like any other scalar result. Nodes whose STRESS
    entry does not carry exactly six components are skipped. Empty when no
    six-component STRESS block is present, or when numpy is unavailable
    (the module stays importable and parsable without it).
    """
    derived: dict[str, dict[int, list[float]]] = {}
    stress = results.get("STRESS")
    if not stress or np is None:
        return derived
    nodes = sorted(n for n, v in stress.items() if len(v) == 6)
    if not nodes:
        return derived
    s = np.array([stress[n] for n in nodes], dtype=np.float64)
    sxx, syy, szz, sxy, syz, sxz = (s[:, i] for i in range(6))
    mises = np.sqrt(
        0.5 * ((sxx - syy) ** 2 + (syy - szz) ** 2 + (szz - sxx) ** 2)
        + 3.0 * (sxy**2 + syz**2 + sxz**2)
    )
    tri = np.empty((len(nodes), 3, 3), dtype=np.float64)
    tri[:, 0, 0] = sxx
    tri[:, 1, 1] = syy
    tri[:, 2, 2] = szz
    tri[:, 0, 1] = tri[:, 1, 0] = sxy
    tri[:, 1, 2] = tri[:, 2, 1] = syz
    tri[:, 0, 2] = tri[:, 2, 0] = sxz
    pmax = np.linalg.eigvalsh(tri)[:, -1]
    derived["MISES"] = {n: [float(v)] for n, v in zip(nodes, mises, strict=True)}
    derived["MAXPRIN"] = {n: [float(v)] for n, v in zip(nodes, pmax, strict=True)}
    return derived


def _vtk_cell_type(num_nodes: int) -> int:
    """Return the legacy VTK cell type for a tetrahedron."""
    if num_nodes == 4:
        return 10  # VTK_TETRA
    if num_nodes == 10:
        return 24  # VTK_QUADRATIC_TETRA
    raise ValueError(f"Unsupported node count for VTK: {num_nodes}")


def _node_yield_map(
    mesh: MeshData, materials: dict[str, dict[str, Any]]
) -> tuple[dict[int, float], list[str]]:
    """Map 1-based node ids to yield strengths from block materials.

    Yield strengths arrive as ``yieldStrength`` on the resolved material
    dicts (carried from the ``yield`` card field, or set directly on custom
    property dicts). A node shared by blocks with different yields takes the
    minimum (conservative for safety factors). The second return value names
    the mesh blocks whose material carries no ``yieldStrength``, so callers
    can report the omission instead of silently defaulting it. Pure Python.
    """
    node_yield: dict[int, float] = {}
    missing: set[str] = set()
    for block_name, indices in mesh.blocks.items():
        mat = materials.get(block_name) or {}
        strength = mat.get("yieldStrength")
        if strength is None:
            if len(indices) > 0:
                missing.add(str(mat.get("name") or block_name))
            continue
        strength = float(strength)
        for idx in indices:
            for n in mesh.elements[int(idx)]["nodes"]:
                node_id = int(n) + 1
                prev = node_yield.get(node_id)
                node_yield[node_id] = strength if prev is None else min(prev, strength)
    return node_yield, sorted(missing)


def _write_vtk_legacy(
    mesh: MeshData,
    frd_results: dict[str, dict[int, list[float]]],
    vtk_path: Path,
    node_yield: dict[int, float] | None = None,
) -> None:
    """Write a legacy ASCII VTK unstructured grid with optional nodal results.

    Besides displacement (``DISP``) and temperature (``NDTEMP``/``TEMP``),
    the derived ``MISES``/``MAXPRIN`` scalars are emitted as ``von_mises``
    and ``max_principal`` color-by arrays. When ``node_yield`` maps 1-based
    node ids to yield strengths (see ``_node_yield_map``), a
    ``safety_factor`` array (``yield / mises``) is emitted alongside: nodes
    without a known yield read NaN (omitted, never defaulted) and zero
    von Mises reads +inf.
    """
    if np is None:
        raise RuntimeError("numpy is required")

    vtk_path.parent.mkdir(parents=True, exist_ok=True)
    n_points = len(mesh.points)

    # Build result arrays aligned with points.  Point i corresponds to node id i+1.
    disp = np.zeros((n_points, 3), dtype=np.float64)
    has_disp = "DISP" in frd_results
    if has_disp:
        for i in range(n_points):
            disp[i] = frd_results["DISP"].get(i + 1, [0.0, 0.0, 0.0])[:3]

    temp = np.zeros(n_points, dtype=np.float64)
    # ccx writes nodal temperatures under the NDTEMP result name.
    temp_result = frd_results.get("NDTEMP") or frd_results.get("TEMP")
    has_temp = temp_result is not None
    if has_temp:
        for i in range(n_points):
            temp[i] = temp_result.get(i + 1, [0.0])[0]

    mises = np.zeros(n_points, dtype=np.float64)
    has_mises = "MISES" in frd_results
    if has_mises:
        for i in range(n_points):
            mises[i] = frd_results["MISES"].get(i + 1, [0.0])[0]

    pmax = np.zeros(n_points, dtype=np.float64)
    has_pmax = "MAXPRIN" in frd_results
    if has_pmax:
        for i in range(n_points):
            pmax[i] = frd_results["MAXPRIN"].get(i + 1, [0.0])[0]

    has_safety = has_mises and node_yield is not None
    safety = np.full(n_points, np.nan, dtype=np.float64)
    if has_safety:
        assert node_yield is not None
        with np.errstate(divide="ignore", invalid="ignore"):
            for i in range(n_points):
                strength = node_yield.get(i + 1)
                if strength is not None:
                    safety[i] = strength / mises[i]

    n_cells = sum(len(v) for v in mesh.blocks.values())
    total_conn = sum(
        len(mesh.elements[int(idx)]["nodes"]) for indices in mesh.blocks.values() for idx in indices
    )

    with vtk_path.open("w", encoding="utf-8") as f:
        f.write("# vtk DataFile Version 2.0\n")
        f.write("nuke-cad FEM results\n")
        f.write("ASCII\n")
        f.write("DATASET UNSTRUCTURED_GRID\n")

        f.write(f"POINTS {n_points} float\n")
        for p in mesh.points:
            f.write(f"{p[0]:.12g} {p[1]:.12g} {p[2]:.12g}\n")

        f.write(f"CELLS {n_cells} {n_cells + total_conn}\n")
        for _block_name, indices in mesh.blocks.items():
            for idx in indices:
                elem = mesh.elements[int(idx)]
                nodes = [int(n) for n in elem["nodes"]]
                f.write(str(len(nodes)))
                for n in nodes:
                    f.write(f" {n}")
                f.write("\n")

        f.write(f"CELL_TYPES {n_cells}\n")
        for _block_name, indices in mesh.blocks.items():
            for idx in indices:
                elem = mesh.elements[int(idx)]
                f.write(f"{_vtk_cell_type(len(elem['nodes']))}\n")

        f.write(f"POINT_DATA {n_points}\n")
        if has_disp:
            f.write("VECTORS displacement float\n")
            for v in disp:
                f.write(f"{v[0]:.12g} {v[1]:.12g} {v[2]:.12g}\n")
        if has_temp:
            f.write("SCALARS temperature float 1\n")
            f.write("LOOKUP_TABLE default\n")
            for t in temp:
                f.write(f"{t:.12g}\n")
        if has_mises:
            f.write("SCALARS von_mises float 1\n")
            f.write("LOOKUP_TABLE default\n")
            for v in mises:
                f.write(f"{v:.12g}\n")
        if has_pmax:
            f.write("SCALARS max_principal float 1\n")
            f.write("LOOKUP_TABLE default\n")
            for v in pmax:
                f.write(f"{v:.12g}\n")
        if has_safety:
            f.write("SCALARS safety_factor float 1\n")
            f.write("LOOKUP_TABLE default\n")
            for v in safety:
                f.write(f"{v:.12g}\n")


def run_fem(
    msh_path: str,
    output_dir: str | None = None,
    output_stem: str | None = None,
    materials: dict[str, Any] | None = None,
    material_cards: dict[str, Any] | None = None,
    boundary_conditions: list[dict[str, Any]] | None = None,
    step: dict[str, Any] | None = None,
    run: bool = False,
    ccx_path: str | None = None,
    write_vtk: bool = True,
    ccx_timeout: float | None = None,
) -> dict[str, Any]:
    """Generate a CalculiX input deck and optionally run the analysis.

    ``material_cards`` carries the region manifest's additive ``materials``
    block (pass ``RegionManifest(...).materials``); name references in
    ``materials`` resolve against it first, then the built-ins. Unknown
    names fail loudly via the returned error — never a silent default.

    Returns the stdout-JSON result dict.
    """
    result: dict[str, Any] = {
        "success": False,
        "inpPath": None,
        "frdPath": None,
        "datPath": None,
        "vtkPath": None,
        "logPath": None,
        "stdout": "",
        "stderr": "",
        "error": None,
        "warnings": [],
    }

    try:
        _require_deps()
    except RuntimeError as exc:
        result["error"] = str(exc)
        return result

    msh_file = Path(msh_path).resolve()
    if not msh_file.exists():
        result["error"] = f"Mesh file not found: {msh_path}"
        return result

    out_dir = Path(output_dir).resolve() if output_dir else msh_file.parent
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = output_stem or msh_file.stem
    inp_path = out_dir / f"{stem}.fem.inp"
    vtk_path = out_dir / f"{stem}.fem.vtk"

    resolved_materials: dict[str, dict[str, Any]] = {}
    bcs = boundary_conditions or []
    step_cfg = step or {"stepType": "static"}
    warnings: list[str] = []

    try:
        # Card resolution runs inside the guarded block so an unknown name
        # surfaces as a structured error, never a traceback.
        resolved_materials = _resolve_materials(materials, material_cards)
        _print_progress(f"Reading gmsh mesh: {msh_file}")
        mesh = _read_gmsh_mesh(str(msh_file))

        _print_progress(f"Writing CalculiX input: {inp_path}")
        warnings = write_inp(mesh, inp_path, resolved_materials, bcs, step_cfg)

        result.update(
            {
                "inpPath": str(inp_path),
                "warnings": warnings,
            }
        )

        if run:
            ccx = _find_ccx(ccx_path)
            if ccx_timeout is None:
                ccx_result = _run_ccx(inp_path, ccx)
            else:
                ccx_result = _run_ccx(inp_path, ccx, timeout=ccx_timeout)
            result.update(
                {
                    "success": ccx_result["success"],
                    "error": ccx_result.get("error"),
                    "frdPath": ccx_result.get("frdPath"),
                    "datPath": ccx_result.get("datPath"),
                    "logPath": ccx_result.get("logPath"),
                    "stdout": ccx_result.get("stdout", ""),
                    "stderr": ccx_result.get("stderr", ""),
                }
            )
            if warnings:
                result["warnings"] = warnings

            if ccx_result["success"] and write_vtk:
                frd_path = Path(ccx_result["frdPath"])
                _print_progress(f"Converting FRD to VTK: {vtk_path}")
                frd_results = _parse_frd_results(frd_path)
                yields, missing_yield = _node_yield_map(mesh, resolved_materials)
                if "MISES" in frd_results and missing_yield:
                    warnings.append(
                        "Safety factor omitted for material(s) without "
                        f"yield strength: {', '.join(missing_yield)}."
                    )
                _write_vtk_legacy(mesh, frd_results, vtk_path, node_yield=yields or None)
                result["vtkPath"] = str(vtk_path)
        else:
            result["success"] = True

    except Exception as exc:
        result["error"] = f"FEM setup failed: {exc}"
        result["traceback"] = traceback.format_exc()
        result["warnings"] = warnings

    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="nuke-cad FEM service")
    parser.add_argument("msh", nargs="?", default=None, help="Path to the gmsh .msh file")
    parser.add_argument("--output-dir", default=None, help="Directory for output files")
    parser.add_argument("--output-stem", default=None, help="Base file name for outputs")
    parser.add_argument(
        "--materials",
        default=None,
        help="JSON file mapping block names to materials",
    )
    parser.add_argument(
        "--material-cards",
        default=None,
        help="JSON file with the region manifest 'materials' block (custom cards)",
    )
    parser.add_argument(
        "--bcs",
        default=None,
        help="JSON file with a list of boundary condition objects",
    )
    parser.add_argument(
        "--step",
        default=None,
        help="JSON file with step settings",
    )
    parser.add_argument(
        "--ccx",
        default=None,
        help="Path to the CalculiX executable (default: ccx on PATH or NUKE_CCX)",
    )
    parser.add_argument(
        "--run",
        action="store_true",
        help="Run the CalculiX analysis after writing the input deck",
    )
    parser.add_argument(
        "--no-vtk",
        action="store_true",
        help="Skip FRD to VTK conversion",
    )
    parser.add_argument(
        "--list-materials",
        action="store_true",
        help="Print the built-in material database as JSON and exit",
    )
    parser.add_argument(
        "--request",
        default=None,
        help="JSON request file (overrides other options)",
    )
    args = parser.parse_args()

    if args.list_materials:
        print(json.dumps(_builtin_materials(), indent=2))
        sys.exit(0)

    if args.request:
        request = json.loads(Path(args.request).read_text(encoding="utf-8"))
        result = run_fem(
            request["mshPath"],
            output_dir=request.get("outputDir", args.output_dir),
            output_stem=request.get("outputStem", args.output_stem),
            materials=request.get("materials"),
            material_cards=request.get("materialCards"),
            boundary_conditions=request.get("boundaryConditions"),
            step=request.get("step"),
            run=request.get("run", False),
            ccx_path=request.get("ccxPath", args.ccx),
            write_vtk=not args.no_vtk,
            ccx_timeout=request.get("ccxTimeout"),
        )
        print(json.dumps(result))
        sys.stdout.flush()
        sys.exit(0 if result.get("success") else 1)

    if args.msh is None:
        parser.error("the following arguments are required: msh")

    materials = None
    if args.materials:
        materials = json.loads(Path(args.materials).read_text(encoding="utf-8"))
    material_cards = None
    if args.material_cards:
        material_cards = json.loads(Path(args.material_cards).read_text(encoding="utf-8"))
    boundary_conditions = None
    if args.bcs:
        boundary_conditions = json.loads(Path(args.bcs).read_text(encoding="utf-8"))
    step = None
    if args.step:
        step = json.loads(Path(args.step).read_text(encoding="utf-8"))

    result = run_fem(
        args.msh,
        output_dir=args.output_dir,
        output_stem=args.output_stem,
        materials=materials,
        material_cards=material_cards,
        boundary_conditions=boundary_conditions,
        step=step,
        run=args.run,
        ccx_path=args.ccx,
        write_vtk=not args.no_vtk,
    )
    print(json.dumps(result))
    sys.stdout.flush()
    sys.exit(0 if result.get("success") else 1)


if __name__ == "__main__":
    main()
