#!/usr/bin/env python3
"""Meshing service for nuke-cad.

Turns a canonical STEP file into FEM-ready volume meshes:

    <stem>.msh              gmsh native mesh
    <stem>.e                ExodusII (via custom netCDF4 writer)
    <stem>.inp              CalculiX/Abaqus (via meshio)
    <stem>.vtk              VTK unstructured grid (via meshio)
    <stem>.mesh.report.json mesh quality report

The gmsh backend is the primary engine and uses the HXT 3D tetrahedral
algorithm. Netgen is accepted as an ``engine`` value but is only wired
when the optional ``netgen``/``ngsolve`` stack is available.

Progress and diagnostics are emitted on stderr. One final JSON object is
printed on stdout (stdout-JSON protocol used across NukeIDE backends).
"""

from __future__ import annotations

import argparse
import json
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

try:
    import meshio

    HAS_MESHIO = True
except ImportError:
    meshio = None  # type: ignore
    HAS_MESHIO = False

try:
    import netCDF4

    HAS_NETCDF4 = True
except ImportError:
    netCDF4 = None  # type: ignore
    HAS_NETCDF4 = False

try:
    import netgen

    HAS_NETGEN = True
except ImportError:
    netgen = None  # type: ignore
    HAS_NETGEN = False


# ExodusII uses 1-based element/side IDs and fixed-width strings.
_EXODUS_STRING_LEN = 33


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
    if not HAS_MESHIO:
        missing.append("meshio")
    if not HAS_NETCDF4:
        missing.append("netCDF4")
    if missing:
        raise RuntimeError(f"Meshing service requires: {', '.join(missing)}")


def _derive_output_paths(
    step_path: str,
    output_dir: str | None,
    output_stem: str | None,
) -> dict[str, Path]:
    """Return the artifact paths derived from the STEP input."""
    step_file = Path(step_path).resolve()
    out_dir = Path(output_dir).resolve() if output_dir else step_file.parent
    stem = output_stem or step_file.stem
    return {
        "msh": out_dir / f"{stem}.msh",
        "e": out_dir / f"{stem}.e",
        "inp": out_dir / f"{stem}.inp",
        "vtk": out_dir / f"{stem}.vtk",
        "report": out_dir / f"{stem}.mesh.report.json",
    }


def _load_step_into_gmsh(step_path: str) -> None:
    """Open a STEP file in the gmsh OpenCASCADE kernel.

    An ``occ.fragment`` imprint/merge is applied to all volumes so that
    touching solids remain distinct volumes while sharing exact coincident
    faces. This mirrors the DAGMC export pipeline.
    """
    if gmsh is None:
        raise RuntimeError("gmsh is required")
    gmsh.open(step_path)
    gmsh.model.occ.synchronize()
    volumes = gmsh.model.getEntities(3)
    if len(volumes) > 1:
        gmsh.model.occ.fragment(volumes, volumes)
        gmsh.model.occ.synchronize()


def _gmsh_volume_tags() -> list[int]:
    """Return all 3D volume tags in the current gmsh model."""
    if gmsh is None:
        return []
    return [int(tag) for _, tag in gmsh.model.getEntities(3)]


def _apply_size_fields(
    manifest: Any | None,
    selector_map: dict[str, list[int]] | None,
    mesh_size: float | None,
    min_size: float | None,
    max_size: float | None,
    warnings: list[str],
) -> None:
    """Apply global and per-region gmsh size constraints."""
    if gmsh is None:
        return

    if min_size is not None:
        gmsh.option.setNumber("Mesh.CharacteristicLengthMin", min_size)
    if max_size is not None:
        gmsh.option.setNumber("Mesh.CharacteristicLengthMax", max_size)
    if mesh_size is not None:
        gmsh.option.setNumber("Mesh.CharacteristicLengthMax", mesh_size)
        if min_size is None:
            gmsh.option.setNumber("Mesh.CharacteristicLengthMin", mesh_size * 0.1)

    if manifest is None or selector_map is None:
        return

    restrict_fields: list[int] = []
    for entry in manifest.volumes:
        size = entry.get("meshSize")
        if size is None:
            continue
        selector = entry.get("selector")
        tags = selector_map.get(selector, [])
        if not tags:
            warnings.append(
                f"Manifest volume '{entry.get('name') or selector}' has meshSize "
                f"but selector '{selector}' is not present in the selector map."
            )
            continue

        try:
            # Use a MathEval field restricted to the target volumes. This is
            # more robust than setSize for driving HXT refinement.
            size_field = gmsh.model.mesh.field.add("MathEval")
            gmsh.model.mesh.field.setString(size_field, "F", str(float(size)))
            restrict = gmsh.model.mesh.field.add("Restrict")
            gmsh.model.mesh.field.setNumber(restrict, "IField", size_field)
            gmsh.model.mesh.field.setNumbers(restrict, "VolumesList", [int(t) for t in tags])
            restrict_fields.append(restrict)
        except Exception as exc:
            warnings.append(
                f"Could not create size field for selector '{selector}' with size {size}: {exc}"
            )

    if restrict_fields:
        try:
            combined = gmsh.model.mesh.field.add("Min")
            gmsh.model.mesh.field.setNumbers(combined, "FieldsList", restrict_fields)
            gmsh.model.mesh.field.setAsBackgroundMesh(combined)
        except Exception as exc:
            warnings.append(f"Could not apply background size field: {exc}")


def _assign_physical_groups(
    manifest: Any | None,
    selector_map: dict[str, list[int]] | None,
    warnings: list[str],
) -> tuple[dict[str, set[int]], dict[str, set[int]]]:
    """Map manifest selectors to gmsh physical groups (blocks and sidesets).

    Returns ``(volume_tag_groups, surface_tag_groups)`` where each maps a
    physical-group name to the set of gmsh entity tags it contains.
    """
    if gmsh is None:
        return {}, {}

    volume_groups: dict[str, set[int]] = {}
    surface_groups: dict[str, set[int]] = {}

    if manifest is not None and selector_map is not None:
        for entry in manifest.volumes:
            selector = entry.get("selector")
            name = entry.get("name") or selector
            tags = selector_map.get(selector, [])
            if not tags:
                warnings.append(
                    f"Manifest volume selector '{selector}' not found in selector map; "
                    f"block '{name}' will be empty unless defaults are used."
                )
            volume_groups.setdefault(name, set()).update(int(t) for t in tags)

        for entry in manifest.surfaces:
            selector = entry.get("selector")
            name = entry.get("name") or selector
            tags = selector_map.get(selector, [])
            if not tags:
                warnings.append(
                    f"Manifest surface selector '{selector}' not found in selector map; "
                    f"sideset '{name}' will be skipped."
                )
            surface_groups.setdefault(name, set()).update(int(t) for t in tags)

    # Any volume not covered by the manifest gets a default block name.
    assigned_volumes = {tag for tags in volume_groups.values() for tag in tags}
    for tag in _gmsh_volume_tags():
        if tag not in assigned_volumes:
            default_name = f"block_{tag}"
            volume_groups.setdefault(default_name, set()).add(tag)

    # Create gmsh physical groups so the names survive into the .msh file.
    for name, tags in volume_groups.items():
        if not tags:
            continue
        ptag = gmsh.model.addPhysicalGroup(3, list(tags))
        gmsh.model.setPhysicalName(3, ptag, name)

    for name, tags in surface_groups.items():
        if not tags:
            continue
        ptag = gmsh.model.addPhysicalGroup(2, list(tags))
        gmsh.model.setPhysicalName(2, ptag, name)

    return volume_groups, surface_groups


def _mesh_with_gmsh(
    step_path: str,
    output_msh: Path,
    manifest: Any | None,
    selector_map: dict[str, list[int]] | None,
    mesh_size: float | None,
    min_size: float | None,
    max_size: float | None,
    order: int,
    warnings: list[str],
) -> None:
    """Generate a 3D volume mesh with gmsh and write the native .msh file."""
    if gmsh is None or np is None:
        raise RuntimeError("gmsh and numpy are required")

    gmsh_initialized = False
    try:
        gmsh.initialize()
        gmsh_initialized = True
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.option.setNumber("Mesh.Algorithm3D", 10)  # HXT
        gmsh.option.setNumber("General.NumThreads", 0)  # use all cores

        _load_step_into_gmsh(step_path)
        _apply_size_fields(manifest, selector_map, mesh_size, min_size, max_size, warnings)
        _assign_physical_groups(manifest, selector_map, warnings)

        gmsh.model.mesh.generate(3)
        if order > 1:
            gmsh.model.mesh.setOrder(order)

        output_msh.parent.mkdir(parents=True, exist_ok=True)
        gmsh.write(str(output_msh))
    finally:
        if gmsh_initialized:
            try:
                gmsh.finalize()
            except Exception:
                pass


def _mesh_with_netgen(
    step_path: str,
    output_msh: Path,
    manifest: Any | None,
    selector_map: dict[str, list[int]] | None,
    mesh_size: float | None,
    min_size: float | None,
    max_size: float | None,
    order: int,
    warnings: list[str],
) -> None:
    """Netgen fallback placeholder.

    The interface matches ``_mesh_with_gmsh`` but Netgen is not wired yet;
    it is accepted as an engine value for forward compatibility.
    """
    raise NotImplementedError(
        "Netgen engine is accepted but not yet implemented. "
        "Use engine='gmsh' or install a future nuke-cad update."
    )


def _cell_set_indices(mask: Any) -> np.ndarray:
    """Convert a meshio cell-set entry to a dense array of cell indices."""
    if mask is None or len(mask) == 0:
        return np.array([], dtype=int)
    if mask.dtype == bool:
        return np.nonzero(mask)[0].astype(int)
    return np.asarray(mask, dtype=int)


def _is_tetra_type(cell_type: str) -> bool:
    """Return True if ``cell_type`` is a tetrahedral element."""
    return cell_type in {"tetra", "tetra4", "tetra10"}


def _is_triangle_type(cell_type: str) -> bool:
    """Return True if ``cell_type`` is a triangular face element."""
    return cell_type in {"triangle", "triangle3", "triangle6"}


def _extract_tetra_blocks(mesh: Any) -> tuple[np.ndarray, dict[str, np.ndarray]]:
    """Return ``(tetrahedra, blocks)`` from a meshio mesh.

    ``tetrahedra`` is an ``(M, N)`` int32 array of 0-based node indices where
    ``N`` is 4 for linear and 10 for quadratic tets. ``blocks`` maps a block
    name to a 0-based index array into ``tetrahedra``.
    """
    if np is None or meshio is None:
        raise RuntimeError("numpy and meshio are required")

    tet_blocks: list[tuple[int, np.ndarray, int]] = []
    global_offset = 0
    for idx, block in enumerate(mesh.cells):
        if _is_tetra_type(block.type):
            arr = np.asarray(block.data, dtype=np.int32)
            tet_blocks.append((idx, arr, global_offset))
            global_offset += len(arr)

    if not tet_blocks:
        raise RuntimeError("No tetrahedral elements found in the volume mesh")

    combined = np.concatenate([arr for _, arr, _ in tet_blocks], axis=0)
    blocks: dict[str, np.ndarray] = {}

    for name, sets in mesh.cell_sets.items():
        if name.startswith("gmsh:"):
            continue
        if len(sets) != len(mesh.cells):
            continue
        indices: list[int] = []
        for block_idx, arr, offset in tet_blocks:
            local = _cell_set_indices(sets[block_idx])
            local = local[(local >= 0) & (local < len(arr))]
            if len(local) == 0:
                continue
            indices.extend((local + offset).tolist())
        if indices:
            blocks[name] = np.array(indices, dtype=int)

    if not blocks:
        blocks["block_1"] = np.arange(len(combined), dtype=int)

    return combined, blocks


def _extract_sidesets(mesh: Any, tets: np.ndarray) -> dict[str, list[tuple[int, int]]]:
    """Map gmsh surface physical groups to Exodus-style side sets.

    Returns a dict mapping sideset name to a list of ``(tet_index, side_index)``
    pairs. Internal surfaces are shared by two tetrahedra, so both adjacent
    faces are included.
    """
    if np is None:
        raise RuntimeError("numpy is required")

    tri_blocks: list[tuple[int, np.ndarray, int]] = []
    global_offset = 0
    for idx, block in enumerate(mesh.cells):
        if _is_triangle_type(block.type):
            arr = np.asarray(block.data, dtype=np.int32)
            tri_blocks.append((idx, arr, global_offset))
            global_offset += len(arr)

    if not tri_blocks:
        return {}

    all_triangles = np.concatenate([arr for _, arr, _ in tri_blocks], axis=0)

    # Map each triangular face (corner nodes only) to owning tetrahedra.
    face_owners: dict[frozenset[int], list[tuple[int, int]]] = {}
    for tet_idx, tet in enumerate(tets):
        faces = [
            frozenset([int(tet[0]), int(tet[1]), int(tet[2])]),
            frozenset([int(tet[0]), int(tet[1]), int(tet[3])]),
            frozenset([int(tet[1]), int(tet[2]), int(tet[3])]),
            frozenset([int(tet[0]), int(tet[2]), int(tet[3])]),
        ]
        for side_idx, face in enumerate(faces):
            face_owners.setdefault(face, []).append((tet_idx, side_idx))

    sidesets: dict[str, list[tuple[int, int]]] = {}
    for name, sets in mesh.cell_sets.items():
        if name.startswith("gmsh:"):
            continue
        if len(sets) != len(mesh.cells):
            continue

        entries: list[tuple[int, int]] = []
        for block_idx, arr, offset in tri_blocks:
            local = _cell_set_indices(sets[block_idx])
            local = local[(local >= 0) & (local < len(arr))]
            for li in local:
                tri = all_triangles[offset + li]
                # For quadratic triangles, use corner nodes for face matching.
                face = frozenset(int(n) for n in tri[:3])
                for owner in face_owners.get(face, []):
                    entries.append(owner)
        if entries:
            sidesets[name] = entries

    return sidesets


def _write_string_variable(var: Any, row: int, text: str) -> None:
    """Write a short string into an ExodusII fixed-width char variable."""
    encoded = text.encode("utf-8")[: var.shape[1]]
    for col, byte in enumerate(encoded):
        var[row, col] = bytes([byte])


def _write_exodus(
    points: np.ndarray,
    tets: np.ndarray,
    blocks: dict[str, np.ndarray],
    sidesets: dict[str, list[tuple[int, int]]],
    path: Path,
) -> None:
    """Write a minimal ExodusII file with named element blocks and side sets."""
    if netCDF4 is None or np is None:
        raise RuntimeError("netCDF4 and numpy are required")

    path.parent.mkdir(parents=True, exist_ok=True)
    block_names = list(blocks.keys())
    block_indices = [np.asarray(blocks[name]) for name in block_names]
    total_elems = sum(len(idx) for idx in block_indices)

    with netCDF4.Dataset(str(path), "w") as root:
        root.title = f"nuke-cad mesh {path.name}"
        root.version = np.float32(5.1)
        root.api_version = np.float32(5.1)
        root.floating_point_word_size = 8

        root.createDimension("num_nodes", len(points))
        root.createDimension("num_dim", points.shape[1])
        root.createDimension("num_elem", total_elems)
        root.createDimension("num_el_blk", len(block_names))
        root.createDimension("num_side_sets", len(sidesets))
        root.createDimension("len_string", _EXODUS_STRING_LEN)
        root.createDimension("len_line", 81)
        root.createDimension("four", 4)
        root.createDimension("time_step", None)

        root.createVariable("time_whole", "f4", ("time_step",))[:] = 0.0

        coor_names = root.createVariable("coor_names", "S1", ("num_dim", "len_string"))
        coor_names.set_auto_mask(False)
        coor_names[0, 0] = b"X"
        coor_names[1, 0] = b"Y"
        if points.shape[1] == 3:
            coor_names[2, 0] = b"Z"

        coord = root.createVariable("coord", "f8", ("num_dim", "num_nodes"))
        coord[:] = points.T

        eb_prop1 = root.createVariable("eb_prop1", "i4", ("num_el_blk",))
        eb_names = root.createVariable("eb_names", "S1", ("num_el_blk", "len_string"))
        eb_names.set_auto_mask(False)

        elem_type = "TETRA" if tets.shape[1] == 4 else "TETRA10"
        nodes_per_elem = tets.shape[1]

        for bidx, name in enumerate(block_names):
            eb_prop1[bidx] = bidx + 1
            _write_string_variable(eb_names, bidx, name)
            idx = block_indices[bidx]

            dim1 = f"num_el_in_blk{bidx + 1}"
            dim2 = f"num_nod_per_el{bidx + 1}"
            root.createDimension(dim1, len(idx))
            root.createDimension(dim2, nodes_per_elem)

            conn = root.createVariable(f"connect{bidx + 1}", "i4", (dim1, dim2))
            conn.elem_type = elem_type
            conn[:] = tets[idx] + 1  # Exodus uses 1-based IDs.

        if sidesets:
            ss_prop1 = root.createVariable("ss_prop1", "i4", ("num_side_sets",))
            ss_names = root.createVariable("ss_names", "S1", ("num_side_sets", "len_string"))
            ss_names.set_auto_mask(False)
            for sidx, (name, entries) in enumerate(sidesets.items()):
                ss_prop1[sidx] = sidx + 1
                _write_string_variable(ss_names, sidx, name)

                elems = [int(tet_idx) + 1 for tet_idx, _ in entries]
                sides = [int(side_idx) + 1 for _, side_idx in entries]

                dim = f"num_side_ss{sidx + 1}"
                root.createDimension(dim, len(entries))
                elem_var = root.createVariable(f"elem_ss{sidx + 1}", "i4", (dim,))
                side_var = root.createVariable(f"side_ss{sidx + 1}", "i4", (dim,))
                elem_var[:] = elems
                side_var[:] = sides


def _write_inp(mesh: Any, path: Path) -> None:
    """Write a CalculiX/Abaqus .inp file via meshio."""
    if meshio is None:
        raise RuntimeError("meshio is required")
    path.parent.mkdir(parents=True, exist_ok=True)
    meshio.write(str(path), mesh, file_format="abaqus")


def _write_vtk(mesh: Any, path: Path) -> None:
    """Write a VTK unstructured grid file via meshio."""
    if meshio is None:
        raise RuntimeError("meshio is required")
    path.parent.mkdir(parents=True, exist_ok=True)
    meshio.write(str(path), mesh, file_format="vtk")


def _tet_dihedral_angles(points: np.ndarray, tet: np.ndarray) -> tuple[float, float]:
    """Return ``(min_interior_dihedral_deg, max_interior_dihedral_deg)`` for one tet."""
    if np is None:
        return 0.0, 0.0

    verts = points[tet]
    # For each of the six edges, the two faces that share it.
    face_pairs = [
        ((0, 1, 2), (0, 1, 3)),
        ((0, 1, 2), (0, 2, 3)),
        ((0, 1, 3), (0, 2, 3)),
        ((0, 1, 2), (1, 2, 3)),
        ((0, 1, 3), (1, 2, 3)),
        ((0, 2, 3), (1, 2, 3)),
    ]

    angles: list[float] = []
    for f1, f2 in face_pairs:
        # used to flip the normal so it points outward.
        def outward_normal(face: tuple[int, int, int], opposite: int) -> np.ndarray:
            a, b, c = verts[face[0]], verts[face[1]], verts[face[2]]
            n = np.cross(b - a, c - a)
            if np.dot(n, verts[opposite] - a) > 0:
                n = -n
            norm = np.linalg.norm(n)
            return n / norm if norm > 0 else n

        n1 = outward_normal(f1, opposite=(set(range(4)) - set(f1)).pop())
        n2 = outward_normal(f2, opposite=(set(range(4)) - set(f2)).pop())

        dot = float(np.clip(np.dot(n1, n2), -1.0, 1.0))
        plane_angle = float(np.arccos(-dot))  # angle between outward normals
        interior = float(np.pi - plane_angle)
        angles.append(np.degrees(interior))

    return float(min(angles)), float(max(angles))


def _tet_edge_ratio(points: np.ndarray, tet: np.ndarray) -> float:
    """Return the longest / shortest edge ratio for one tet."""
    if np is None:
        return 1.0
    verts = points[tet]
    edges = [np.linalg.norm(verts[i] - verts[j]) for i in range(4) for j in range(i + 1, 4)]
    edges = [e for e in edges if e > 0]
    if not edges:
        return 1.0
    return float(max(edges) / min(edges))


def _compute_mesh_report(
    points: np.ndarray,
    tets: np.ndarray,
    blocks: dict[str, np.ndarray],
    sidesets: dict[str, list[tuple[int, int]]] | None = None,
) -> dict[str, Any]:
    """Compute element counts and tetrahedral quality metrics."""
    if np is None:
        raise RuntimeError("numpy is required")

    points = np.asarray(points)
    tets = np.asarray(tets, dtype=np.int32)

    if len(tets) == 0:
        return {"error": "No tetrahedral elements found in the volume mesh"}

    # Global quality metrics.
    min_dihedral = 180.0
    max_dihedral = 0.0
    min_aspect = float("inf")
    max_aspect = 0.0
    total_aspect = 0.0

    for tet in tets:
        dmin, dmax = _tet_dihedral_angles(points, tet)
        min_dihedral = min(min_dihedral, dmin)
        max_dihedral = max(max_dihedral, dmax)
        aspect = _tet_edge_ratio(points, tet)
        min_aspect = min(min_aspect, aspect)
        max_aspect = max(max_aspect, aspect)
        total_aspect += aspect

    block_reports: list[dict[str, Any]] = []
    for name, indices in blocks.items():
        block_reports.append(
            {
                "name": name,
                "elementCount": int(len(indices)),
                "dimension": 3,
            }
        )

    sideset_reports: list[dict[str, Any]] = []
    for name, entries in (sidesets or {}).items():
        sideset_reports.append(
            {
                "name": name,
                "elementCount": int(len(entries)),
            }
        )

    return {
        "elementCount": int(len(tets)),
        "nodeCount": int(len(points)),
        "elementTypes": {"tetra": int(len(tets))},
        "blocks": block_reports,
        "sidesets": sideset_reports,
        "quality": {
            "minDihedralDeg": float(min_dihedral),
            "maxDihedralDeg": float(max_dihedral),
            "minAspectRatio": float(min_aspect),
            "maxAspectRatio": float(max_aspect),
            "meanAspectRatio": float(total_aspect / len(tets)),
        },
    }


def mesh_step(
    step_path: str,
    output_dir: str | None = None,
    output_stem: str | None = None,
    manifest: Any | None = None,
    selector_map: dict[str, list[int]] | None = None,
    engine: str = "gmsh",
    mesh_size: float | None = None,
    min_size: float | None = None,
    max_size: float | None = None,
    order: int = 1,
    write_exodus: bool = True,
    write_inp: bool = True,
    write_vtk: bool = True,
) -> dict[str, Any]:
    """Generate FEM volume meshes from a canonical STEP file.

    Args:
        step_path: Input STEP file path.
        output_dir: Directory for output files; defaults to the STEP directory.
        output_stem: Base file name; defaults to the STEP stem.
        manifest: Optional ``RegionManifest`` for block/sideset names and sizes.
        selector_map: Maps selectors to lists of 1-based gmsh volume/surface tags.
        engine: ``"gmsh"`` (primary) or ``"netgen"`` (placeholder).
        mesh_size: Global target element size (sets max characteristic length).
        min_size: Minimum allowed element size.
        max_size: Maximum allowed element size.
        order: Element order (1 = linear, 2 = quadratic).
        write_exodus: Whether to write ``<stem>.e``.
        write_inp: Whether to write ``<stem>.inp``.
        write_vtk: Whether to write ``<stem>.vtk``.

    Returns:
        Dict with ``success``, ``paths``, ``warnings``, ``error``, ``report``.
    """
    result: dict[str, Any] = {
        "success": False,
        "paths": {},
        "warnings": [],
        "error": None,
        "report": None,
    }

    try:
        _require_deps()
    except RuntimeError as exc:
        result["error"] = str(exc)
        return result

    step_file = Path(step_path).resolve()
    if not step_file.exists():
        result["error"] = f"STEP file not found: {step_path}"
        return result

    paths = _derive_output_paths(step_path, output_dir, output_stem)
    result["paths"] = {key: str(path) for key, path in paths.items()}

    if selector_map is None:
        selector_map = {}

    warnings: list[str] = []

    try:
        _print_progress(f"Meshing STEP: {step_file} with engine={engine}")
        if engine == "gmsh":
            _mesh_with_gmsh(
                str(step_file),
                paths["msh"],
                manifest,
                selector_map,
                mesh_size,
                min_size,
                max_size,
                order,
                warnings,
            )
        elif engine == "netgen":
            _mesh_with_netgen(
                str(step_file),
                paths["msh"],
                manifest,
                selector_map,
                mesh_size,
                min_size,
                max_size,
                order,
                warnings,
            )
        else:
            raise ValueError(f"Unknown mesh engine: {engine}")

        _print_progress(f"Reading gmsh mesh for conversion: {paths['msh']}")
        mesh = meshio.read(str(paths["msh"]))

        tets, blocks = _extract_tetra_blocks(mesh)
        sidesets = _extract_sidesets(mesh, tets)

        if write_exodus:
            _print_progress(f"Writing ExodusII: {paths['e']}")
            _write_exodus(mesh.points, tets, blocks, sidesets, paths["e"])

        if write_inp:
            _print_progress(f"Writing CalculiX/Abaqus: {paths['inp']}")
            _write_inp(mesh, paths["inp"])

        if write_vtk:
            _print_progress(f"Writing VTK: {paths['vtk']}")
            _write_vtk(mesh, paths["vtk"])

        report = _compute_mesh_report(mesh.points, tets, blocks, sidesets)
        paths["report"].write_text(json.dumps(report, indent=2), encoding="utf-8")
        result["report"] = report

        result.update(
            {
                "success": True,
                "warnings": warnings,
            }
        )
        _print_progress(
            f"Done: {report['elementCount']} tetrahedra, "
            f"{report['nodeCount']} nodes, {len(blocks)} block(s)"
        )
    except Exception as exc:
        result["error"] = f"Meshing failed: {exc}"
        result["traceback"] = traceback.format_exc()
        result["warnings"] = warnings

    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="nuke-cad meshing service")
    parser.add_argument("step", help="Path to the input STEP file")
    parser.add_argument("--output-dir", default=None, help="Directory for output files")
    parser.add_argument("--output-stem", default=None, help="Base file name for outputs")
    parser.add_argument(
        "--engine",
        default="gmsh",
        choices=["gmsh", "netgen"],
        help="Meshing engine (default: gmsh)",
    )
    parser.add_argument("--mesh-size", type=float, default=None, help="Global target element size")
    parser.add_argument("--min-size", type=float, default=None, help="Minimum element size")
    parser.add_argument("--max-size", type=float, default=None, help="Maximum element size")
    parser.add_argument("--order", type=int, default=1, help="Element order (1 or 2)")
    parser.add_argument("--no-exodus", action="store_true", help="Skip ExodusII output")
    parser.add_argument("--no-inp", action="store_true", help="Skip CalculiX/Abaqus output")
    parser.add_argument("--no-vtk", action="store_true", help="Skip VTK output")
    args = parser.parse_args()

    result = mesh_step(
        args.step,
        output_dir=args.output_dir,
        output_stem=args.output_stem,
        engine=args.engine,
        mesh_size=args.mesh_size,
        min_size=args.min_size,
        max_size=args.max_size,
        order=args.order,
        write_exodus=not args.no_exodus,
        write_inp=not args.no_inp,
        write_vtk=not args.no_vtk,
    )
    print(json.dumps(result))
    sys.stdout.flush()
    sys.exit(0 if result.get("success") else 1)


if __name__ == "__main__":
    main()
