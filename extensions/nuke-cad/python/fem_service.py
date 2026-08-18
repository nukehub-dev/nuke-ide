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


# CalculiX face labels for a C3D4 tetrahedron using gmsh node ordering.
_C3D4_FACES = [
    ("S1", (1, 2, 3)),  # opposite node 0
    ("S2", (0, 3, 2)),  # opposite node 1
    ("S3", (0, 1, 3)),  # opposite node 2
    ("S4", (0, 2, 1)),  # opposite node 3
]


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


def _builtin_materials() -> dict[str, dict[str, Any]]:
    """Return a small built-in structural/thermal material database."""
    return {
        "structural_steel": {
            "name": "Structural Steel",
            "youngsModulus": 210e9,
            "poissonsRatio": 0.3,
            "density": 7850.0,
            "conductivity": 50.0,
            "expansion": 12e-6,
        },
        "aluminum": {
            "name": "Aluminum",
            "youngsModulus": 70e9,
            "poissonsRatio": 0.33,
            "density": 2700.0,
            "conductivity": 205.0,
            "expansion": 23e-6,
        },
        "copper": {
            "name": "Copper",
            "youngsModulus": 110e9,
            "poissonsRatio": 0.34,
            "density": 8960.0,
            "conductivity": 400.0,
            "expansion": 17e-6,
        },
        "uo2": {
            "name": "UO2",
            "youngsModulus": 220e9,
            "poissonsRatio": 0.316,
            "density": 10960.0,
            "conductivity": 3.5,
            "expansion": 10e-6,
        },
        "zircaloy": {
            "name": "Zircaloy-4",
            "youngsModulus": 99e9,
            "poissonsRatio": 0.37,
            "density": 6550.0,
            "conductivity": 13.0,
            "expansion": 6e-6,
        },
        "concrete": {
            "name": "Concrete",
            "youngsModulus": 30e9,
            "poissonsRatio": 0.2,
            "density": 2400.0,
            "conductivity": 1.5,
            "expansion": 10e-6,
        },
    }


def _resolve_materials(materials_input: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    """Resolve a user material map against the built-in database.

    ``materials_input`` maps a CalculiX element-set name to either a built-in
    material key or a complete material property dict.
    """
    builtins = _builtin_materials()
    result: dict[str, dict[str, Any]] = {}
    if materials_input is None:
        return result
    for block_name, value in materials_input.items():
        if isinstance(value, str) and value in builtins:
            result[block_name] = builtins[value]
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

        # Assign physical-group names to volume and surface blocks.
        blocks: dict[str, Any] = {}
        surface_sets: dict[str, Any] = {}
        for dim, ptag in gmsh.model.getPhysicalGroups():
            name = gmsh.model.getPhysicalName(dim, ptag)
            entities = gmsh.model.getEntitiesForPhysicalGroup(dim, ptag)
            if dim == 3:
                indices: list[int] = []
                for ent in entities:
                    for idx, elem in enumerate(elements):
                        if elem["parentTag"] == ent:
                            elem["block"] = name
                            indices.append(idx)
                if indices:
                    blocks[name] = np.array(indices, dtype=int)
            elif dim == 2:
                indices = []
                for ent in entities:
                    for idx, elem in enumerate(surface_elems):
                        if elem["parentTag"] == ent:
                            elem["block"] = name
                            indices.append(idx)
                if indices:
                    surface_sets[name] = {
                        "indices": np.array(indices, dtype=int),
                        "elements": surface_elems,
                    }

        # Any unnamed volume gets a default block so it still has a section.
        for idx, elem in enumerate(elements):
            if not elem["block"]:
                elem["block"] = f"block_{idx}"
                blocks.setdefault(elem["block"], np.array([], dtype=int))
                blocks[elem["block"]] = np.append(blocks[elem["block"]], idx)

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
) -> None:
    """Write *Boundary, *Cload, and *Cflux cards for boundary conditions."""
    fixed_lines: list[str] = []
    disp_lines: list[str] = []
    temp_lines: list[str] = []
    cload_lines: list[str] = []
    cflux_lines: list[str] = []

    for bc in boundary_conditions:
        bc_type = bc.get("type")
        surf = bc.get("surfaceName")
        nodes = sorted(_surface_node_set(mesh, surf))
        if not nodes:
            continue

        if bc_type == "fixed":
            for n in nodes:
                fixed_lines.append(f"{n + 1}, ENCASTRE")
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
                temp_lines.append(f"{n + 1}, 11, 11, {temp:.12g}")
        elif bc_type == "pressure":
            magnitude = float(bc.get("magnitude", 0))
            vector = bc.get("vector")
            if vector is None:
                _, vector = _surface_area_and_normal(mesh, surf)
            area, _ = _surface_area_and_normal(mesh, surf)
            if area <= 0:
                continue
            n_nodes = len(nodes)
            fx = magnitude * area * float(vector[0]) / n_nodes
            fy = magnitude * area * float(vector[1]) / n_nodes
            fz = magnitude * area * float(vector[2]) / n_nodes
            for n in nodes:
                if abs(fx) > 0:
                    cload_lines.append(f"{n + 1}, 1, {fx:.12g}")
                if abs(fy) > 0:
                    cload_lines.append(f"{n + 1}, 2, {fy:.12g}")
                if abs(fz) > 0:
                    cload_lines.append(f"{n + 1}, 3, {fz:.12g}")
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
        f.write("*Boundary\n")
        for line in temp_lines:
            f.write(line + "\n")
    if cload_lines:
        f.write("*Cload\n")
        for line in cload_lines:
            f.write(line + "\n")
    if cflux_lines:
        f.write("*Cflux\n")
        for line in cflux_lines:
            f.write(line + "\n")


def _write_step(
    mesh: MeshData,
    step: dict[str, Any],
    boundary_conditions: list[dict[str, Any]],
    f: Any,
) -> None:
    """Write the *Step block including BCs, loads, and output requests."""
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

    _write_boundary_conditions(mesh, boundary_conditions, f)

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
        _write_step(mesh, step, boundary_conditions, f)

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
) -> dict[str, Any]:
    """Run CalculiX on the input deck and return file paths and output."""
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

    _print_progress(f"Running CalculiX: {ccx_path} -i {stem}")
    try:
        proc = subprocess.run(
            [ccx_path, "-i", stem],
            cwd=str(working_dir),
            capture_output=True,
            text=True,
            check=False,
        )
        result["stdout"] = proc.stdout
        result["stderr"] = proc.stderr
        log_path.write_text(proc.stdout + "\n" + proc.stderr, encoding="utf-8")
        if proc.returncode != 0:
            result["error"] = f"CalculiX exited with code {proc.returncode}"
            return result
        result["success"] = True
    except Exception as exc:
        result["error"] = f"Failed to run CalculiX: {exc}"
        result["traceback"] = traceback.format_exc()

    return result


def _parse_frd_results(frd_path: Path) -> dict[str, dict[int, list[float]]]:
    """Parse nodal results from a CalculiX FRD file.

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
            stripped = line.strip()
            if stripped.startswith("-4"):
                # New result block name.
                if current_name is not None and ncomps > 0:
                    results[current_name] = current_values
                current_name = stripped[2:].strip()
                current_values = {}
                ncomps = 0
            elif stripped.startswith("-5") and current_name is not None:
                # Result type record.  The integer after the token is the
                # number of components per node.
                parts = stripped.split()
                if len(parts) >= 3:
                    try:
                        ncomps = int(parts[2])
                    except ValueError:
                        ncomps = 1
                else:
                    ncomps = 1
            elif stripped.startswith("-1") and current_name is not None and ncomps > 0:
                parts = stripped.split()
                if len(parts) < 2 + ncomps:
                    continue
                try:
                    node_id = int(parts[1])
                    values = [float(p) for p in parts[2 : 2 + ncomps]]
                    current_values[node_id] = values
                except ValueError:
                    continue
            elif stripped.startswith("-3") and current_name is not None and ncomps > 0:
                results[current_name] = current_values
                current_name = None
                current_values = {}
                ncomps = 0

    return results


def _vtk_cell_type(num_nodes: int) -> int:
    """Return the legacy VTK cell type for a tetrahedron."""
    if num_nodes == 4:
        return 10  # VTK_TETRA
    if num_nodes == 10:
        return 24  # VTK_QUADRATIC_TETRA
    raise ValueError(f"Unsupported node count for VTK: {num_nodes}")


def _write_vtk_legacy(
    mesh: MeshData,
    frd_results: dict[str, dict[int, list[float]]],
    vtk_path: Path,
) -> None:
    """Write a legacy ASCII VTK unstructured grid with optional nodal results."""
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
    has_temp = "TEMP" in frd_results
    if has_temp:
        for i in range(n_points):
            temp[i] = frd_results["TEMP"].get(i + 1, [0.0])[0]

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


def run_fem(
    msh_path: str,
    output_dir: str | None = None,
    output_stem: str | None = None,
    materials: dict[str, Any] | None = None,
    boundary_conditions: list[dict[str, Any]] | None = None,
    step: dict[str, Any] | None = None,
    run: bool = False,
    ccx_path: str | None = None,
    write_vtk: bool = True,
) -> dict[str, Any]:
    """Generate a CalculiX input deck and optionally run the analysis.

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

    resolved_materials = _resolve_materials(materials)
    bcs = boundary_conditions or []
    step_cfg = step or {"stepType": "static"}
    warnings: list[str] = []

    try:
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
            ccx_result = _run_ccx(inp_path, ccx)
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
                _write_vtk_legacy(mesh, frd_results, vtk_path)
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
            boundary_conditions=request.get("boundaryConditions"),
            step=request.get("step"),
            run=request.get("run", False),
            ccx_path=request.get("ccxPath", args.ccx),
            write_vtk=not args.no_vtk,
        )
        print(json.dumps(result))
        sys.stdout.flush()
        sys.exit(0 if result.get("success") else 1)

    if args.msh is None:
        parser.error("the following arguments are required: msh")

    materials = None
    if args.materials:
        materials = json.loads(Path(args.materials).read_text(encoding="utf-8"))
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
