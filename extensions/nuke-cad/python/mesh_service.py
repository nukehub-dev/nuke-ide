#!/usr/bin/env python3
"""Meshing service for nuke-cad.

Turns a canonical STEP file into FEM-ready volume meshes:

    <stem>.msh              gmsh-compatible mesh (native for gmsh, via meshio for netgen)
    <stem>.e                ExodusII (via custom netCDF4 writer)
    <stem>.inp              CalculiX/Abaqus (via meshio)
    <stem>.vtk              VTK unstructured grid (via meshio)
    <stem>.mesh.report.json mesh quality report

The gmsh backend is the primary engine and uses the HXT 3D tetrahedral
algorithm. Netgen is available as a fallback engine when the optional
``netgen``/``ngsolve`` stack is installed; it imprints the geometry first
(gmsh OCC fragment + duplicate removal, mirroring the DAGMC pipeline),
supports linear and quadratic tetrahedra, and converts its mesh into the
same meshio representation as the gmsh path, so quality reports and exports
are engine-agnostic.

Progress and diagnostics are emitted on stderr. One final JSON object is
printed on stdout (stdout-JSON protocol used across NukeIDE backends).
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import tempfile
import traceback
from pathlib import Path
from typing import Any

# Ensure sibling modules are importable when run as a script.
_SCRIPT_DIR = Path(__file__).parent.resolve()
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

import mesh_repair

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
    from netgen.occ import OCCGeometry

    HAS_NETGEN = True
except ImportError:
    OCCGeometry = None  # type: ignore
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


def _load_step_into_gmsh(step_path: str, remove_duplicates: bool = False) -> None:
    """Open a STEP file in the gmsh OpenCASCADE kernel and imprint it.

    An ``occ.fragment`` imprint/merge is applied to all volumes so that
    touching solids remain distinct volumes while sharing exact coincident
    faces. With ``remove_duplicates`` the ``occ.removeAllDuplicates`` merge
    stage also runs, unifying the coincident duplicate faces fragment leaves
    behind — the same imprint/merge sequence as the DAGMC export pipeline.
    """
    if gmsh is None:
        raise RuntimeError("gmsh is required")
    gmsh.open(step_path)
    gmsh.model.occ.synchronize()
    volumes = gmsh.model.getEntities(3)
    if len(volumes) > 1:
        gmsh.model.occ.fragment(volumes, volumes)
        gmsh.model.occ.synchronize()
        if remove_duplicates:
            gmsh.model.occ.removeAllDuplicates()
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
    # An explicit max_size wins over the looser mesh_size target.
    if max_size is not None:
        gmsh.option.setNumber("Mesh.CharacteristicLengthMax", max_size)
    elif mesh_size is not None:
        gmsh.option.setNumber("Mesh.CharacteristicLengthMax", mesh_size)
    if mesh_size is not None and min_size is None:
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


def _imprint_and_resolve_coms_via_gmsh(
    step_path: str,
    imprinted_path: Path,
    manifest: Any | None,
    selector_map: dict[str, list[int]],
    warnings: list[str],
) -> tuple[
    list[tuple[str, tuple[float, ...], float | None]],
    list[tuple[str, tuple[float, ...]]],
    list[tuple[int, tuple[float, ...]]],
]:
    """Imprint a STEP model and resolve manifest selectors, in one gmsh pass.

    Loads the STEP file into the gmsh OCC kernel, runs the fragment +
    removeAllDuplicates imprint/merge sequence (shared with the gmsh engine
    path via ``_load_step_into_gmsh``), and writes the imprinted model to
    ``imprinted_path`` as a BREP file. BREP is used instead of STEP because a
    STEP round trip re-instances each solid's shell separately and loses the
    shared coincident faces; BREP preserves them.

    Selector maps hold 1-based gmsh entity tags, so selector centers of mass
    are resolved against the same imprinted model the netgen engine will
    mesh: both sides of a shared face have already collapsed into a single
    face entity here, and will be a single face in the netgen shape too.
    Returns ``(named_volumes, named_surfaces, all_volumes)`` where
    ``named_volumes`` holds ``(name, com, meshSize)`` triples,
    ``named_surfaces`` holds ``(name, com)`` pairs, and ``all_volumes`` holds
    ``(tag, com)`` for every volume (used for default block naming).
    """
    if gmsh is None:
        raise RuntimeError("gmsh is required")

    named_volumes: list[tuple[str, tuple[float, ...], float | None]] = []
    named_surfaces: list[tuple[str, tuple[float, ...]]] = []
    all_volumes: list[tuple[int, tuple[float, ...]]] = []

    gmsh_initialized = False
    try:
        gmsh.initialize()
        gmsh_initialized = True
        gmsh.option.setNumber("General.Terminal", 0)
        _load_step_into_gmsh(step_path, remove_duplicates=True)
        gmsh.write(str(imprinted_path))

        for tag in _gmsh_volume_tags():
            com = tuple(float(c) for c in gmsh.model.occ.getCenterOfMass(3, tag))
            all_volumes.append((tag, com))

        if manifest is not None:
            for entry in manifest.volumes:
                selector = entry.get("selector")
                name = entry.get("name") or selector
                size = entry.get("meshSize")
                tags = selector_map.get(selector, [])
                if not tags:
                    warnings.append(
                        f"Manifest volume '{name}' selector '{selector}' is not present "
                        "in the selector map; netgen per-region sizing skipped."
                    )
                    continue
                for tag in tags:
                    com = tuple(float(c) for c in gmsh.model.occ.getCenterOfMass(3, int(tag)))
                    named_volumes.append((name, com, float(size) if size is not None else None))

            for entry in manifest.surfaces:
                selector = entry.get("selector")
                name = entry.get("name") or selector
                tags = selector_map.get(selector, [])
                if not tags:
                    warnings.append(
                        f"Manifest surface '{name}' selector '{selector}' is not present "
                        "in the selector map; netgen sideset skipped."
                    )
                    continue
                for tag in tags:
                    com = tuple(float(c) for c in gmsh.model.occ.getCenterOfMass(2, int(tag)))
                    named_surfaces.append((name, com))
    finally:
        if gmsh_initialized:
            try:
                gmsh.finalize()
            except Exception:
                pass

    return named_volumes, named_surfaces, all_volumes


def _closest_com(
    point: tuple[float, ...],
    candidates: list[tuple[float, ...]],
    tol: float,
) -> int | None:
    """Return the index of the closest candidate COM within ``tol``, else None."""
    best: int | None = None
    best_dist = tol
    for idx, candidate in enumerate(candidates):
        dist = math.dist(point, candidate)
        if dist <= best_dist:
            best = idx
            best_dist = dist
    return best


# Netgen node ordering differs from the meshio/VTK canonical ordering for
# quadratic cells (verified empirically against netgen 6.2.2606 and against a
# gmsh order-2 mesh read through meshio):
#   netgen tet10 mid-edge slots 4..9: edges (0,1) (0,2) (0,3) (1,2) (1,3) (2,3)
#   meshio tetra10 slots 4..9:        edges (0,1) (1,2) (0,2) (0,3) (1,3) (2,3)
#   netgen tri6 mid-edge slots 3..5:  edges (1,2) (0,2) (0,1)
#   meshio triangle6 slots 3..5:      edges (0,1) (1,2) (0,2)
_NETGEN_TETRA10_TO_MESHIO = [0, 1, 2, 3, 4, 7, 5, 6, 8, 9]
_NETGEN_TRIANGLE6_TO_MESHIO = [0, 1, 2, 5, 3, 4]


def _netgen_to_meshio(ng_mesh: Any, warnings: list[str]) -> Any:
    """Convert a netgen volume mesh into the meshio form the gmsh path yields.

    Builds one ``tetra``/``tetra10`` cell block plus one
    ``triangle``/``triangle6`` block for boundary faces, named cell sets from
    netgen's material (volume) and boundary-condition (surface) names, and
    gmsh physical tags so the written .msh artifact keeps the same named
    groups. Quadratic meshes (after ``Mesh.SecondOrder()``) are reordered
    from netgen's node numbering into the meshio/VTK canonical one.
    """
    if np is None or meshio is None:
        raise RuntimeError("numpy and meshio are required")

    elements3d = list(ng_mesh.Elements3D())
    if not elements3d:
        raise RuntimeError("netgen produced no tetrahedral elements")
    elements2d = list(ng_mesh.Elements2D())

    # el.points holds corners + high-order nodes (corners first); for linear
    # meshes it coincides with el.vertices.
    tet_rows = [[p.nr - 1 for p in el.points] for el in elements3d]
    tet_sizes = {len(row) for row in tet_rows}
    if tet_sizes == {10}:
        tet_type = "tetra10"
        tets = np.array(
            [[row[i] for i in _NETGEN_TETRA10_TO_MESHIO] for row in tet_rows], dtype=np.int32
        )
    elif tet_sizes == {4}:
        tet_type = "tetra"
        tets = np.array(tet_rows, dtype=np.int32)
    else:
        raise RuntimeError(
            f"netgen produced unsupported tetrahedral elements (node counts: {sorted(tet_sizes)})"
        )

    tri_rows: list[list[int]] = []
    tri_bc_values: list[int] = []
    dropped = 0
    tri_type = "triangle"
    for el in elements2d:
        row = [p.nr - 1 for p in el.points]
        if len(row) == 3:
            tri_rows.append(row)
        elif len(row) == 6:
            tri_rows.append([row[i] for i in _NETGEN_TRIANGLE6_TO_MESHIO])
            tri_type = "triangle6"
        else:
            dropped += 1
            continue
        tri_bc_values.append(el.index)
    if dropped:
        warnings.append(f"netgen engine: dropping {dropped} non-triangular boundary elements.")

    points = np.array(ng_mesh.Coordinates(), dtype=float)
    tris = np.array(tri_rows, dtype=np.int32) if tri_rows else np.empty((0, 3), dtype=np.int32)
    tet_domain = np.array([el.index for el in elements3d], dtype=int)
    tri_bc = np.array(tri_bc_values, dtype=int)

    # Element indices are 1-based domain/BC numbers; GetBCName is 0-based.
    materials = [ng_mesh.GetMaterial(i) for i in range(1, ng_mesh.GetNDomains() + 1)]
    bc_names = {i: ng_mesh.GetBCName(i - 1) for i in sorted(set(tri_bc.tolist()))}

    cells: list[tuple[str, np.ndarray]] = [(tet_type, tets)]
    if len(tris) > 0:
        cells.append((tri_type, tris))

    field_data: dict[str, np.ndarray] = {}
    phys_tet = np.zeros(len(tets), dtype=np.int32)
    phys_tri = np.zeros(len(tris), dtype=np.int32)
    cell_sets: dict[str, list[np.ndarray]] = {}
    tag = 0
    for domain, name in enumerate(materials, start=1):
        tag += 1
        field_data[name] = np.array([tag, 3])
        mask = np.nonzero(tet_domain == domain)[0]
        phys_tet[mask] = tag
        cell_sets.setdefault(name, [np.array([], dtype=int) for _ in cells])[0] = mask
    if len(tris) > 0:
        for bc_index, name in bc_names.items():
            if name == "default":
                continue
            tag += 1
            field_data[name] = np.array([tag, 2])
            mask = np.nonzero(tri_bc == bc_index)[0]
            phys_tri[mask] = tag
            cell_sets.setdefault(name, [np.array([], dtype=int) for _ in cells])[1] = mask

    cell_data = {"gmsh:physical": [phys_tet], "gmsh:geometrical": [np.zeros(len(tets), np.int32)]}
    if len(tris) > 0:
        cell_data["gmsh:physical"].append(phys_tri)
        cell_data["gmsh:geometrical"].append(np.zeros(len(tris), np.int32))

    return meshio.Mesh(
        points=points,
        cells=cells,
        cell_sets=cell_sets,
        cell_data=cell_data,
        field_data=field_data,
    )


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
) -> Any:
    """Generate a 3D volume mesh with netgen and write a gmsh-compatible .msh file.

    The STEP file is first imprinted via a gmsh OCC pass (fragment +
    removeAllDuplicates, mirroring the DAGMC export pipeline) and written to
    a temporary BREP file, which netgen then meshes with its own OCC kernel.
    This gives touching solids a single shared interface face instead of
    coincident duplicates, so sidesets and BC names are not double-counted.
    The same gmsh pass resolves selector centers of mass against the
    imprinted entity numbering, so tags are matched only once.

    The netgen mesh is converted in-memory to the same meshio representation
    the gmsh engine produces via ``meshio.read``: a ``tetra``/``tetra10``
    cell block, a ``triangle``/``triangle6`` boundary block, and named cell
    sets for blocks and sidesets. The returned mesh feeds the shared
    report/ExodusII/INP/VTK pipeline unchanged.

    Manifest volume names become netgen material names (block names) and a
    volume's ``meshSize`` maps to that solid's ``maxh``; manifest surface
    names become boundary-condition names (sidesets). Selectors are matched
    to netgen solids/faces by center of mass against the imprinted gmsh OCC
    numbering the selector map refers to. Unmatched selectors produce
    warnings and unnamed solids fall back to ``block_<tag>`` names.

    Element order: 1 (linear) and 2 (quadratic, via ``Mesh.SecondOrder()``)
    are supported; ``order`` > 2 clamps to 2 with a warning. Netgen projects
    boundary mid-edge nodes onto the geometry where it can, but this is
    best-effort: correctness of the converted pipeline is only guaranteed
    for straight-edged elements — curved quadratic boundaries are netgen's
    own approximation. ``min_size`` maps to netgen's ``minh`` hint rather
    than a hard characteristic-length bound.
    """
    if not HAS_NETGEN or OCCGeometry is None or np is None or meshio is None:
        raise RuntimeError("netgen, numpy, and meshio are required")
    if order > 2:
        warnings.append(
            f"netgen engine: element order {order} is not supported; clamping to order 2."
        )
        order = 2

    with tempfile.TemporaryDirectory() as tmpdir:
        imprinted_path = Path(tmpdir) / "imprinted.brep"
        named_volumes, named_surfaces, all_volumes = _imprint_and_resolve_coms_via_gmsh(
            step_path, imprinted_path, manifest, selector_map or {}, warnings
        )

        # Load the imprinted shape, tag it with names/sizes, then hand the
        # tagged shape to a fresh OCCGeometry: sub-shape meshing attributes
        # are only honored when present before the OCCGeometry is constructed.
        shape = OCCGeometry(str(imprinted_path)).shape
        bb_min, bb_max = shape.bounding_box
        tol = 1e-6 * max(math.dist(bb_min, bb_max), 1.0)

        volume_coms = [com for _, com, _ in named_volumes]
        default_coms = [com for _, com in all_volumes]
        for idx, solid in enumerate(shape.solids):
            center = tuple(float(c) for c in solid.center)
            named_idx = _closest_com(center, volume_coms, tol) if volume_coms else None
            if named_idx is not None:
                name, _, region_size = named_volumes[named_idx]
                if region_size is not None:
                    solid.maxh = region_size
            else:
                tag_idx = _closest_com(center, default_coms, tol) if default_coms else None
                if tag_idx is not None:
                    name = f"block_{all_volumes[tag_idx][0]}"
                else:
                    name = f"block_{idx + 1}"
                    warnings.append(
                        f"netgen engine: could not match solid {idx + 1} to a gmsh volume "
                        f"by center of mass; using fallback block name '{name}'."
                    )
            solid.mat(name)

        faces = list(shape.faces)
        for name, com in named_surfaces:
            matched = [face for face in faces if math.dist(tuple(face.center), com) <= tol]
            if not matched:
                warnings.append(
                    f"netgen engine: surface '{name}' could not be matched to a netgen face; "
                    "the sideset will be empty."
                )
            for face in matched:
                face.bc(name)

        mesh_kwargs: dict[str, float] = {}
        maxh = max_size if max_size is not None else mesh_size
        if maxh is not None:
            mesh_kwargs["maxh"] = float(maxh)
        if min_size is not None:
            mesh_kwargs["minh"] = float(min_size)
        ng_mesh = OCCGeometry(shape).GenerateMesh(**mesh_kwargs)
        if order == 2:
            ng_mesh.SecondOrder()

    mesh = _netgen_to_meshio(ng_mesh, warnings)

    output_msh.parent.mkdir(parents=True, exist_ok=True)
    meshio.write(str(output_msh), mesh, file_format="gmsh22", binary=False)
    return mesh


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
    # Face order follows the SEACAS ExodusII TETRA(4) side convention
    # (1-based local node numbering): side 1 = {1,2,4}, side 2 = {2,3,4},
    # side 3 = {1,4,3}, side 4 = {1,3,2}.
    face_owners: dict[frozenset[int], list[tuple[int, int]]] = {}
    for tet_idx, tet in enumerate(tets):
        faces = [
            frozenset([int(tet[0]), int(tet[1]), int(tet[3])]),  # side 1
            frozenset([int(tet[1]), int(tet[2]), int(tet[3])]),  # side 2
            frozenset([int(tet[0]), int(tet[2]), int(tet[3])]),  # side 3
            frozenset([int(tet[0]), int(tet[1]), int(tet[2])]),  # side 4
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

        def outward_normal(face: tuple[int, int, int], opposite: int) -> np.ndarray:
            """Face normal flipped so it points away from the opposite vertex."""
            a, b, c = verts[face[0]], verts[face[1]], verts[face[2]]
            n = np.cross(b - a, c - a)
            if np.dot(n, verts[opposite] - a) > 0:
                n = -n
            norm = np.linalg.norm(n)
            return n / norm if norm > 0 else n

        n1 = outward_normal(f1, opposite=(set(range(4)) - set(f1)).pop())
        n2 = outward_normal(f2, opposite=(set(range(4)) - set(f2)).pop())

        dot = float(np.clip(np.dot(n1, n2), -1.0, 1.0))
        # arccos(-dot) of the outward normals is already the interior dihedral.
        angles.append(float(np.degrees(np.arccos(-dot))))

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

    element_type = "tetra10" if tets.shape[1] == 10 else "tetra"
    return {
        "elementCount": int(len(tets)),
        "nodeCount": int(len(points)),
        "elementTypes": {element_type: int(len(tets))},
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
    repairs: list[str] | None = None,
) -> dict[str, Any]:
    """Generate FEM volume meshes from a canonical STEP file.

    Args:
        step_path: Input STEP file path.
        output_dir: Directory for output files; defaults to the STEP directory.
        output_stem: Base file name; defaults to the STEP stem.
        manifest: Optional ``RegionManifest`` for block/sideset names and sizes.
        selector_map: Maps selectors to lists of 1-based gmsh volume/surface tags.
        engine: ``"gmsh"`` (primary) or ``"netgen"`` (fallback, order 1 or 2).
        mesh_size: Global target element size (sets max characteristic length).
        min_size: Minimum allowed element size.
        max_size: Maximum allowed element size.
        order: Element order (1 = linear, 2 = quadratic).
        write_exodus: Whether to write ``<stem>.e``.
        write_inp: Whether to write ``<stem>.inp``.
        write_vtk: Whether to write ``<stem>.vtk``.
        repairs: Optional ordered mesh repair ops (see ``mesh_repair``)
            applied to the generated mesh before conversion and reporting;
            per-op counts are recorded under ``report["repairs"]``.

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

    repair_ops: list[str] = []
    if repairs is not None:
        try:
            repair_ops = mesh_repair.normalize_repair_ops(repairs)
        except mesh_repair.RepairError as exc:
            result["error"] = f"Mesh repair failed: {exc}"
            return result

    step_file = Path(step_path).resolve()
    if not step_file.exists():
        result["error"] = f"STEP file not found: {step_path}"
        return result

    try:
        _require_deps()
    except RuntimeError as exc:
        result["error"] = str(exc)
        return result

    # Cheap input validation runs before the heavy-dependency gate above,
    # so a missing STEP file reports "not found" in every profile (minimal
    # and full) instead of a dependency error.
    paths = _derive_output_paths(step_path, output_dir, output_stem)
    result["paths"] = {key: str(path) for key, path in paths.items()}

    if engine == "netgen" and not HAS_NETGEN:
        result["error"] = (
            "Netgen engine is not available: install the optional netgen/ngsolve "
            "packages (conda install -c conda-forge ngsolve preferred, or pip install "
            "ngsolve) to use it."
        )
        return result

    if selector_map is None:
        selector_map = {}

    warnings: list[str] = []

    try:
        _print_progress(f"Meshing STEP: {step_file} with engine={engine}")
        mesh = None
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
            mesh = _mesh_with_netgen(
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

        if mesh is None:
            _print_progress(f"Reading gmsh mesh for conversion: {paths['msh']}")
            mesh = meshio.read(str(paths["msh"]))

        repair_report: dict[str, Any] | None = None
        if repair_ops:
            _print_progress(f"Applying mesh repairs: {', '.join(repair_ops)}")
            blocks_in = [(block.type, np.asarray(block.data)) for block in mesh.cells]
            new_points, new_cells, new_sets, new_data, repair_stats = mesh_repair.repair_mesh_data(
                np.asarray(mesh.points),
                blocks_in,
                dict(mesh.cell_sets),
                dict(mesh.cell_data),
                dict(mesh.field_data),
                repair_ops,
            )
            mesh = meshio.Mesh(
                points=new_points,
                cells=new_cells,
                cell_data=new_data,
                cell_sets=new_sets,
                field_data=dict(mesh.field_data),
            )
            _print_progress(f"Rewriting repaired mesh: {paths['msh']}")
            meshio.write(str(paths["msh"]), mesh, file_format="gmsh22", binary=False)
            for note in repair_stats.get("warnings", []):
                warnings.append(f"mesh repair: {note}")
            repair_report = repair_stats

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
        if repair_report is not None:
            report["repairs"] = repair_report
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
    except mesh_repair.RepairError as exc:
        # Repair ops fail loudly with the op name, never as a traceback.
        result["error"] = f"Mesh repair failed: {exc}"
        result["warnings"] = warnings
    except NotImplementedError as exc:
        # Documented stubs: report a clean structured error instead of a traceback.
        result["error"] = str(exc)
        result["warnings"] = warnings
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
    parser.add_argument(
        "--repair",
        default=None,
        metavar="OP,...",
        help=(
            "Comma-separated mesh repair ops applied after generation, before the "
            "quality report (remove_duplicate_facets, fill_holes, smooth_laplacian, "
            "decimate). Decimate refuses volume meshes loudly."
        ),
    )
    parser.add_argument("--no-exodus", action="store_true", help="Skip ExodusII output")
    parser.add_argument("--no-inp", action="store_true", help="Skip CalculiX/Abaqus output")
    parser.add_argument("--no-vtk", action="store_true", help="Skip VTK output")
    args = parser.parse_args()

    repair_ops: list[str] | None = None
    if args.repair is not None:
        try:
            repair_ops = mesh_repair.normalize_repair_ops(args.repair)
        except mesh_repair.RepairError as exc:
            print(
                json.dumps(
                    {
                        "success": False,
                        "paths": {},
                        "warnings": [],
                        "error": f"Mesh repair failed: {exc}",
                        "report": None,
                    }
                )
            )
            sys.stdout.flush()
            sys.exit(1)

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
        repairs=repair_ops,
    )
    print(json.dumps(result))
    sys.stdout.flush()
    sys.exit(0 if result.get("success") else 1)


if __name__ == "__main__":
    main()
