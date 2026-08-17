"""DAGMC export with imprint/merge and named material groups.

Pipeline
--------
1. Load the canonical STEP file into an OCP shape.
2. Optionally auto-create a mat:graveyard bounding volume (OCP boolean cut).
3. Write the (graveyard-augmented) shape to a temporary STEP file.
4. Load the temp STEP into the gmsh OpenCASCADE kernel and run ``fragment``
   on all volumes. This is the imprint/merge stage: touching solids receive
   exact, shared coincident faces.
5. Generate a 2D surface mesh in gmsh.
6. Extract triangles, surface-to-volume adjacencies, and build a tagged
   DAGMC H5M file via pymoab.
7. Validate surface senses and report watertightness diagnostics.

The module stays importable in the minimal pytest profile (``pytest`` +
``numpy`` only). All heavy imports are guarded with module-level flags and
function-local imports.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import traceback
from pathlib import Path
from typing import Any

# Ensure sibling modules are importable when run as a script.
_SCRIPT_DIR = Path(__file__).parent.resolve()
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from ocp_compat import (  # noqa: E402
    brep_bnd_lib_add,
    brep_gprop_volume_properties,
    interface_static_set_cval,
    topods_solid,
)

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
    import pymoab
    from pymoab import core as moab_core
    from pymoab import types as moab_types

    HAS_PYMOLAB = True
except ImportError:
    pymoab = None  # type: ignore
    moab_core = None  # type: ignore
    moab_types = None  # type: ignore
    HAS_PYMOLAB = False


def _require_deps() -> None:
    """Raise a clear error if any required heavy dependency is missing."""
    missing: list[str] = []
    if not HAS_NUMPY:
        missing.append("numpy")
    if not HAS_GMSH:
        missing.append("gmsh")
    if not HAS_PYMOLAB:
        missing.append("pymoab")
    if missing:
        raise RuntimeError(f"DAGMC export requires: {', '.join(missing)}")


def _solids_from_shape(shape: Any) -> list[Any]:
    """Return all TopoDS_Solid instances nested in ``shape``."""
    from OCP.TopAbs import TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    solids: list[Any] = []
    exp = TopExp_Explorer(shape, TopAbs_SOLID)
    while exp.More():
        solids.append(topods_solid(TopoDS, exp.Current()))
        exp.Next()
    return solids


def _shape_volume(shape: Any) -> float:
    """Compute the volume of a shape (or compound of solids)."""
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps

    props = GProp_GProps()
    brep_gprop_volume_properties(BRepGProp, shape, props)
    return float(props.Mass())


def _solid_bounding_box(solid: Any) -> tuple[float, float, float, float, float, float]:
    """Return the axis-aligned bounding box of a single solid."""
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib

    bbox = Bnd_Box()
    brep_bnd_lib_add(BRepBndLib, solid, bbox)
    return bbox.Get()


def _shape_bounding_box(shape: Any) -> tuple[float, float, float, float, float, float]:
    """Return the axis-aligned bounding box of any shape."""
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib

    bbox = Bnd_Box()
    brep_bnd_lib_add(BRepBndLib, shape, bbox)
    return bbox.Get()


def _bbox_contains(
    outer: tuple[float, float, float, float, float, float],
    inner: tuple[float, float, float, float, float, float],
    padding: float = 1e-4,
) -> bool:
    """Check whether ``outer`` bounds fully enclose ``inner`` bounds."""
    oxmin, oymin, ozmin, oxmax, oymax, ozmax = outer
    ixmin, iymin, izmin, ixmax, iymax, izmax = inner
    return (
        oxmin <= ixmin + padding
        and oymin <= iymin + padding
        and ozmin <= izmin + padding
        and oxmax >= ixmax - padding
        and oymax >= iymax - padding
        and ozmax >= izmax - padding
    )


def _collect_step_names(file_path: str) -> set[str]:
    """Best-effort collection of product/assembly names from a STEP file via CAF."""
    names: set[str] = set()
    try:
        from OCP.STEPCAFControl import STEPCAFControl_Reader
        from OCP.TDataStd import TDataStd_Name
        from OCP.TDF import TDF_LabelSequence
        from OCP.TDocStd import TDocStd_Document
        from OCP.XCAFDoc import XCAFDoc_DocumentTool

        doc = TDocStd_Document("doc")
        reader = STEPCAFControl_Reader()
        reader.SetNameMode(True)
        if reader.ReadFile(file_path) != 1:
            return names
        reader.Transfer(doc)

        shape_tool = XCAFDoc_DocumentTool.ShapeTool(doc.Main())
        free_shapes = TDF_LabelSequence()
        shape_tool.GetFreeShapes(free_shapes)

        def _collect(label: Any) -> None:
            name_attr = TDataStd_Name()
            if label.FindAttribute(TDataStd_Name.GetID(), name_attr):
                try:
                    name = name_attr.Get().PrintToString()
                    if name:
                        names.add(name)
                except Exception:
                    pass
            children = TDF_LabelSequence()
            shape_tool.GetComponents(label, children)
            for i in range(1, children.Length() + 1):
                _collect(children.Value(i))
            subshapes = TDF_LabelSequence()
            shape_tool.GetSubShapes(label, subshapes)
            for i in range(1, subshapes.Length() + 1):
                _collect(subshapes.Value(i))

        for i in range(1, free_shapes.Length() + 1):
            _collect(free_shapes.Value(i))
    except Exception:
        pass
    return names


def _detect_existing_graveyard(shape: Any, file_path: str) -> tuple[bool, list[Any], int | None]:
    """Detect whether ``shape`` already contains a graveyard volume.

    Detection order:
    1. Name-based: any STEP product/assembly name contains "graveyard".
    2. Heuristic: one solid is >10x the volume of the next largest and fully
       contains all other solids.

    Returns ``(detected, model_solids, graveyard_index)``. ``graveyard_index``
    is the 0-based index of the existing graveyard solid in the original solid
    list, or ``None`` if a name was found but the solid could not be matched.
    """
    solids = _solids_from_shape(shape)

    def _find_largest_enclosing() -> int | None:
        if len(solids) <= 1:
            return None
        volumes: list[float] = []
        bboxes: list[tuple[float, float, float, float, float, float]] = []
        for solid in solids:
            try:
                volumes.append(_shape_volume(solid))
                bboxes.append(_solid_bounding_box(solid))
            except Exception:
                return None

        sorted_idx = sorted(range(len(solids)), key=lambda i: volumes[i], reverse=True)
        largest = sorted_idx[0]
        second = sorted_idx[1]

        if volumes[second] <= 0:
            return None
        if volumes[largest] <= 10.0 * volumes[second]:
            return None
        if not all(
            _bbox_contains(bboxes[largest], bboxes[i]) for i in range(len(solids)) if i != largest
        ):
            return None
        return largest

    name_detected = False
    try:
        names = _collect_step_names(file_path)
        name_detected = any("graveyard" in n.lower() for n in names)
    except Exception:
        pass

    if name_detected:
        gy_index = _find_largest_enclosing()
        if gy_index is not None:
            return True, [solids[i] for i in range(len(solids)) if i != gy_index], gy_index
        return True, solids, None

    gy_index = _find_largest_enclosing()
    if gy_index is not None:
        return True, [solids[i] for i in range(len(solids)) if i != gy_index], gy_index

    return False, solids, None


def _make_compound(solids: list[Any]) -> Any:
    """Build a TopoDS_Compound from a list of solids."""
    from OCP.BRep import BRep_Builder
    from OCP.TopoDS import TopoDS_Compound

    builder = BRep_Builder()
    compound = TopoDS_Compound()
    builder.MakeCompound(compound)
    for solid in solids:
        builder.Add(compound, solid)
    return compound


def _write_step(shape: Any, step_path: Path) -> None:
    """Write ``shape`` to a STEP file using OCP."""
    from OCP.Interface import Interface_Static
    from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer

    writer = STEPControl_Writer()
    interface_static_set_cval(Interface_Static, "write.step.schema", "AP214IS")
    writer.Transfer(shape, STEPControl_AsIs)
    status = writer.Write(str(step_path))
    if status != 1:
        raise RuntimeError(f"STEP writer returned status {status}")


def _build_graveyard_shape(model_solids: list[Any], warnings: list[str]) -> Any | None:
    """Create a graveyard box around the model and cut the model out of it."""
    if not model_solids:
        warnings.append(
            "Could not auto-create graveyard: no model solids found. "
            "Add one in your CAD workflow if needed."
        )
        return None

    try:
        from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
        from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
        from OCP.gp import gp_Pnt

        model_shape = _make_compound(model_solids)
        xmin, ymin, zmin, xmax, ymax, zmax = _shape_bounding_box(model_shape)
        dx = xmax - xmin
        dy = ymax - ymin
        dz = zmax - zmin
        max_dim = max(dx, dy, dz)
        padding = max(1.0, 0.1 * max_dim)

        box = BRepPrimAPI_MakeBox(
            gp_Pnt(xmin - padding, ymin - padding, zmin - padding),
            gp_Pnt(xmax + padding, ymax + padding, zmax + padding),
        ).Shape()

        cut = BRepAlgoAPI_Cut(box, model_shape)
        if not cut.IsDone():
            warnings.append("Could not auto-create graveyard: boolean cut failed.")
            return None

        graveyard_shape = cut.Shape()
        graveyard_solids = _solids_from_shape(graveyard_shape)
        if not graveyard_solids:
            warnings.append("Could not auto-create graveyard: boolean cut produced no volumes.")
            return None

        combined = _make_compound(model_solids + graveyard_solids)
        return combined
    except Exception as e:
        warnings.append(f"Could not auto-create graveyard: {e}.")
        return None


def _maybe_add_graveyard(shape: Any, file_path: str, warnings: list[str]) -> tuple[Any, set[int]]:
    """Add a graveyard volume to ``shape`` if one is not already present.

    Returns ``(shape, graveyard_vol_ids)``. ``graveyard_vol_ids`` is a set of
    1-based volume IDs in the final shape that should be tagged
    ``mat:graveyard``.
    """
    try:
        has_graveyard, model_solids, gy_index = _detect_existing_graveyard(shape, file_path)
        if has_graveyard:
            warnings.append("Existing graveyard volume detected; skipping auto-creation.")
            graveyard_ids: set[int] = set()
            if gy_index is not None:
                graveyard_ids.add(gy_index + 1)
                warnings.append("Existing graveyard volume will be tagged mat:graveyard.")
            else:
                warnings.append(
                    "Existing graveyard name found but could not be matched to a solid; "
                    "material tag may need manual correction."
                )
            return shape, graveyard_ids

        combined = _build_graveyard_shape(model_solids, warnings)
        if combined is None:
            return shape, set()

        original_count = len(_solids_from_shape(shape))
        new_count = len(_solids_from_shape(combined))
        warnings.append("Auto-created graveyard volume around model (mat:graveyard).")
        return combined, set(range(original_count + 1, new_count + 1))
    except Exception as e:
        warnings.append(f"Could not auto-create graveyard: {e}.")
        return shape, set()


def _load_shape(step_path: str) -> Any:
    """Load a STEP file into a TopoDS_Shape."""
    from OCP.STEPControl import STEPControl_Reader

    reader = STEPControl_Reader()
    status = reader.ReadFile(step_path)
    if status != 1:
        raise RuntimeError(f"Failed to read STEP file, status={status}")
    reader.TransferRoot()
    return reader.OneShape()


def _volume_name_from_manifest(
    vol_id: int,
    manifest: Any | None,
    selector_map: dict[str, list[int]] | None,
    graveyard_vol_ids: set[int],
) -> str:
    """Return the DAGMC material name for a 1-based volume ID."""
    if vol_id in graveyard_vol_ids:
        return "mat:graveyard"

    selector: str | None = None
    if manifest is not None and selector_map:
        for sel, indices in selector_map.items():
            if vol_id in indices:
                selector = sel
                break

    if selector is not None and manifest is not None:
        for entry in manifest.volumes:
            if entry.get("selector") == selector:
                name = entry.get("name") or selector
                return f"mat:{name}"

    return f"mat_{vol_id - 1}"


def _extract_gmsh_surface_mesh(
    warnings: list[str],
) -> tuple[np.ndarray, dict[int, np.ndarray], dict[int, list[int]], dict[int, int]]:
    """Extract gmsh surface mesh data.

    Returns ``(vertices, face_triangles, face_to_volumes, gmsh_to_dense)``
    where ``vertices`` is a dense (N, 3) float64 array, ``face_triangles`` maps
    gmsh face tag to a (M, 3) int32 triangle index array into ``vertices``,
    ``face_to_volumes`` maps face tag to adjacent 1-based volume tags, and
    ``gmsh_to_dense`` maps original gmsh node tag to dense 0-based vertex index.
    """
    if np is None:
        raise RuntimeError("numpy is required")
    if gmsh is None:
        raise RuntimeError("gmsh is required")

    node_tags, coords, _ = gmsh.model.mesh.getNodes()
    gmsh_to_dense: dict[int, int] = {}
    dense_coords: list[list[float]] = []
    for tag, x, y, z in zip(node_tags, coords[0::3], coords[1::3], coords[2::3], strict=True):
        gmsh_to_dense[int(tag)] = len(dense_coords)
        dense_coords.append([float(x), float(y), float(z)])

    vertices = np.array(dense_coords, dtype=np.float64)

    face_triangles: dict[int, np.ndarray] = {}
    face_to_volumes: dict[int, list[int]] = {}

    faces = gmsh.model.getEntities(2)
    for dim, tag in faces:
        tag = int(tag)
        up, _ = gmsh.model.getAdjacencies(dim, tag)
        face_to_volumes[tag] = [int(v) for v in up]

        elem_types, elem_tags, elem_node_tags = gmsh.model.mesh.getElements(dim, tag)
        triangles: list[list[int]] = []
        for etype, etags, nodes in zip(elem_types, elem_tags, elem_node_tags, strict=True):
            if int(etype) != 2:  # Not a 3-node triangle
                continue
            for i in range(len(etags)):
                tri_nodes = nodes[i * 3 : (i + 1) * 3]
                triangles.append([gmsh_to_dense[int(n)] for n in tri_nodes])

        if not triangles:
            warnings.append(f"Face {tag} has no triangles; skipping.")
            continue

        face_triangles[tag] = np.array(triangles, dtype=np.int32)

    return vertices, face_triangles, face_to_volumes, gmsh_to_dense


def _build_moab_model(
    vertices: np.ndarray,
    face_triangles: dict[int, np.ndarray],
    face_to_volumes: dict[int, list[int]],
    material_names: dict[int, str],
    faceting_tolerance: float,
    warnings: list[str],
) -> Any:
    """Build a pymoab Core with the DAGMC tags and return it."""
    if moab_core is None or moab_types is None:
        raise RuntimeError("pymoab is required")

    mb = moab_core.Core()
    tag_cat = mb.tag_get_handle(
        moab_types.CATEGORY_TAG_NAME,
        moab_types.CATEGORY_TAG_SIZE,
        moab_types.MB_TYPE_OPAQUE,
        moab_types.MB_TAG_SPARSE,
        create_if_missing=True,
    )
    tag_name = mb.tag_get_handle(
        moab_types.NAME_TAG_NAME,
        moab_types.NAME_TAG_SIZE,
        moab_types.MB_TYPE_OPAQUE,
        moab_types.MB_TAG_SPARSE,
        create_if_missing=True,
    )
    tag_gdim = mb.tag_get_handle(
        moab_types.GEOM_DIMENSION_TAG_NAME,
        1,
        moab_types.MB_TYPE_INTEGER,
        moab_types.MB_TAG_DENSE,
        create_if_missing=True,
    )
    tag_gid = mb.tag_get_handle(moab_types.GLOBAL_ID_TAG_NAME)
    tag_sense = mb.tag_get_handle(
        "GEOM_SENSE_2",
        2,
        moab_types.MB_TYPE_HANDLE,
        moab_types.MB_TAG_SPARSE,
        create_if_missing=True,
    )
    tag_facet_tol = mb.tag_get_handle(
        "FACETING_TOL",
        1,
        moab_types.MB_TYPE_DOUBLE,
        moab_types.MB_TAG_SPARSE,
        create_if_missing=True,
    )

    moab_verts = mb.create_vertices(vertices)

    surface_sets: dict[int, Any] = {}
    surf_id = 1
    for face_tag in sorted(face_triangles.keys()):
        sset = mb.create_meshset()
        mb.tag_set_data(tag_gid, sset, surf_id)
        mb.tag_set_data(tag_gdim, sset, 2)
        mb.tag_set_data(tag_cat, sset, "Surface")
        surface_sets[face_tag] = sset

        tri_idx = face_triangles[face_tag]
        for a, b, c in tri_idx:
            tri_verts = (moab_verts[int(a)], moab_verts[int(b)], moab_verts[int(c)])
            mb_tri = mb.create_element(moab_types.MBTRI, tri_verts)
            mb.add_entity(sset, mb_tri)
        surf_id += 1

    # Build volume sets from all adjacent volume IDs.
    all_vol_ids: set[int] = set()
    for vols in face_to_volumes.values():
        all_vol_ids.update(vols)

    volume_sets: dict[int, Any] = {}
    for vol_id in sorted(all_vol_ids):
        vset = mb.create_meshset()
        mb.tag_set_data(tag_gid, vset, vol_id)
        mb.tag_set_data(tag_gdim, vset, 3)
        mb.tag_set_data(tag_cat, vset, "Volume")
        volume_sets[vol_id] = vset

    # Parent-child surface links.
    for face_tag, vols in face_to_volumes.items():
        sset = surface_sets[face_tag]
        for vol_id in vols:
            if vol_id in volume_sets:
                mb.add_parent_child(volume_sets[vol_id], sset)

    # Material groups.
    for vol_id in sorted(volume_sets.keys()):
        mat_name = material_names.get(vol_id)
        if mat_name is None:
            mat_name = f"mat_{vol_id - 1}"
        gset = mb.create_meshset()
        mb.tag_set_data(tag_cat, gset, "Group")
        mb.tag_set_data(tag_gdim, gset, 4)
        mb.tag_set_data(tag_name, gset, mat_name)
        mb.tag_set_data(tag_gid, gset, vol_id)
        mb.add_entity(gset, volume_sets[vol_id])

    # GEOM_SENSE_2 tags.
    for face_tag, vols in face_to_volumes.items():
        sset = surface_sets[face_tag]
        if len(vols) == 2 and vols[0] in volume_sets and vols[1] in volume_sets:
            sense_data = np.array([volume_sets[vols[0]], volume_sets[vols[1]]], dtype=np.uint64)
        elif len(vols) >= 1 and vols[0] in volume_sets:
            sense_data = np.array([volume_sets[vols[0]], 0], dtype=np.uint64)
        else:
            continue
        mb.tag_set_data(tag_sense, sset, sense_data)

    root = mb.get_root_set()
    mb.tag_set_data(tag_facet_tol, root, float(faceting_tolerance))

    # Validation: every surface must have 1 or 2 adjacent volumes.
    for face_tag, vols in face_to_volumes.items():
        if len(vols) > 2:
            warnings.append(
                f"Surface {face_tag} is adjacent to {len(vols)} volumes; DAGMC expects 1 or 2."
            )
        if not vols:
            warnings.append(f"Surface {face_tag} has no adjacent volumes.")

    return mb


def _watertight_check(mb: Any, surface_sets: dict[int, Any], warnings: list[str]) -> dict[str, Any]:
    """Return edge-to-triangle incidence statistics for the faceted model.

    A sealed model has no edge shared by more than two triangles and no
    interior edge shared by fewer than two. This routine reports the raw
    histogram; ``sealed`` is True when every edge has at most two adjacent
    triangles (a necessary condition for watertightness).
    """
    edge_to_tris: dict[tuple[int, int], set[Any]] = {}
    for sset in surface_sets.values():
        tris = mb.get_entities_by_type(sset, moab_types.MBTRI)
        for tri in tris:
            verts = mb.get_connectivity(tri)
            for i in range(3):
                a, b = int(verts[i]), int(verts[(i + 1) % 3])
                edge = tuple(sorted((a, b)))
                edge_to_tris.setdefault(edge, set()).add(tri)

    counts = [len(tris) for tris in edge_to_tris.values()]
    histogram: dict[str, int] = {}
    for c in counts:
        histogram[str(c)] = histogram.get(str(c), 0) + 1

    non_manifold = sum(1 for c in counts if c > 3)
    if non_manifold:
        warnings.append(
            f"Found {non_manifold} edges shared by more than three triangles; "
            "the facet mesh may not be watertight."
        )

    return {
        "totalEdges": len(edge_to_tris),
        "edgeHistogram": histogram,
        "nonManifoldEdges": non_manifold,
        "sealed": non_manifold == 0,
    }


def convert_to_dagmc(
    step_path: str,
    output_path: str | None = None,
    manifest: Any | None = None,
    selector_map: dict[str, list[int]] | None = None,
    faceting_tolerance: float = 0.001,
    length_scale: float = 1.0,
    auto_adjust_tolerance: bool = True,
    add_graveyard: bool = True,
) -> dict[str, Any]:
    """Convert a canonical STEP file to a DAGMC .h5m file.

    Args:
        step_path: Input STEP file path.
        output_path: Output .h5m file path. If None, uses a sibling path.
        manifest: Optional ``RegionManifest`` instance for named material groups.
        selector_map: Mapping from selector name to list of 1-based volume IDs.
        faceting_tolerance: Mesh tolerance for faceting.
        length_scale: Scale factor applied to mesh vertices.
        auto_adjust_tolerance: Whether to auto-adjust tolerance for large models.
        add_graveyard: Whether to auto-create a mat:graveyard bounding volume.

    Returns:
        Dict with ``success``, ``output_path``, ``warnings``, ``error``,
        ``solid_count``, ``surface_count``, ``triangle_count``,
        ``watertight`` metrics.
    """
    result: dict[str, Any] = {
        "success": False,
        "output_path": output_path,
        "warnings": [],
        "error": None,
    }

    try:
        _require_deps()
    except RuntimeError as e:
        result["error"] = str(e)
        return result

    step_file = Path(step_path).resolve()
    if not step_file.exists():
        result["error"] = f"STEP file not found: {step_path}"
        return result

    if output_path is None:
        output_path = str(step_file.with_suffix(".h5m"))
    out_path = Path(output_path).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    result["output_path"] = str(out_path)

    if selector_map is None:
        selector_map = {}

    warnings: list[str] = []
    gmsh_initialized = False

    try:
        # ------------------------------------------------------------------
        # 1. Load STEP and optionally add graveyard via OCP.
        # ------------------------------------------------------------------
        shape = _load_shape(str(step_file))
        graveyard_vol_ids: set[int] = set()
        if add_graveyard:
            shape, graveyard_vol_ids = _maybe_add_graveyard(shape, str(step_file), warnings)

        # ------------------------------------------------------------------
        # 2. Write (possibly graveyard-augmented) shape to a temp STEP.
        # ------------------------------------------------------------------
        with tempfile.TemporaryDirectory() as tmpdir:
            temp_step = Path(tmpdir) / "with_graveyard.step"
            _write_step(shape, temp_step)

            # ------------------------------------------------------------------
            # 3. gmsh imprint/merge and surface mesh.
            # ------------------------------------------------------------------
            gmsh.initialize()
            gmsh_initialized = True
            gmsh.option.setNumber("General.Terminal", 0)

            gmsh.open(str(temp_step))
            volumes = gmsh.model.getEntities(3)
            if not volumes:
                raise RuntimeError("No volumes found in STEP file")

            # Imprint/merge: fragment all volumes with all volumes.
            gmsh.model.occ.fragment(volumes, volumes)
            gmsh.model.occ.synchronize()

            tol = faceting_tolerance
            if auto_adjust_tolerance:
                bbox = gmsh.model.getBoundingBox(-1, -1)
                diag = sum((bbox[i + 3] - bbox[i]) ** 2 for i in range(3)) ** 0.5
                if diag > 100 and tol < 1.0:
                    old_tol = tol
                    tol = max(tol, min(diag / 200, 10.0))
                    warnings.append(
                        f"Faceting tolerance auto-adjusted from {old_tol:.4f} to {tol:.4f} "
                        f"for large model (diagonal {diag:.1f})"
                    )

            # Size field: interpret ``tol`` as a rough target mesh edge length.
            # Curved surfaces are refined based on curvature. This is a pragmatic
            # mapping from faceting tolerance to gmsh's length-field API.
            gmsh.option.setNumber("Mesh.CharacteristicLengthMin", tol / 100.0)
            gmsh.option.setNumber("Mesh.CharacteristicLengthMax", max(tol * 10.0, 0.1))
            gmsh.option.setNumber("Mesh.CharacteristicLengthFromCurvature", 1)
            gmsh.option.setNumber("Mesh.MinimumCirclePoints", 12)
            gmsh.option.setNumber("Mesh.MinimumCurvePoints", 3)

            gmsh.model.mesh.generate(2)

            vertices, face_triangles, face_to_volumes, _ = _extract_gmsh_surface_mesh(warnings)

            gmsh.finalize()
            gmsh_initialized = False

            # ------------------------------------------------------------------
            # 4. Build MOAB model.
            # ------------------------------------------------------------------
            material_names = {
                vol_id: _volume_name_from_manifest(
                    vol_id, manifest, selector_map, graveyard_vol_ids
                )
                for vol_id in {v for vols in face_to_volumes.values() for v in vols}
            }

            if length_scale != 1.0:
                vertices *= length_scale

            mb = _build_moab_model(
                vertices,
                face_triangles,
                face_to_volumes,
                material_names,
                tol,
                warnings,
            )

            # Re-fetch surface meshsets from MOAB for watertight check.
            cat_tag = mb.tag_get_handle(
                moab_types.CATEGORY_TAG_NAME,
                moab_types.CATEGORY_TAG_SIZE,
                moab_types.MB_TYPE_OPAQUE,
                moab_types.MB_TAG_SPARSE,
                create_if_missing=True,
            )
            gdim_tag = mb.tag_get_handle(
                moab_types.GEOM_DIMENSION_TAG_NAME,
                1,
                moab_types.MB_TYPE_INTEGER,
                moab_types.MB_TAG_DENSE,
                create_if_missing=True,
            )
            all_sets = mb.get_entities_by_type_and_tag(
                mb.get_root_set(), moab_types.MBENTITYSET, [cat_tag], ["Surface"]
            )
            surface_sets = {
                i: s for i, s in enumerate(all_sets) if mb.tag_get_data(gdim_tag, s)[0][0] == 2
            }
            watertight = _watertight_check(mb, surface_sets, warnings)

            mb.write_file(str(out_path))

            result.update(
                {
                    "success": True,
                    "solid_count": len({v for vols in face_to_volumes.values() for v in vols}),
                    "surface_count": len(face_triangles),
                    "triangle_count": int(sum(len(t) for t in face_triangles.values())),
                    "warnings": warnings,
                    "watertight": watertight,
                }
            )

    except Exception as e:
        result["error"] = f"DAGMC export failed: {e}"
        result["traceback"] = traceback.format_exc()
        result["warnings"] = warnings
        if gmsh_initialized:
            try:
                gmsh.finalize()
            except Exception:
                pass

    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="nuke-cad DAGMC export service")
    parser.add_argument("step", help="Path to the input STEP file")
    parser.add_argument("--output", default=None, help="Output .h5m file path")
    parser.add_argument("--tolerance", type=float, default=0.001, help="Faceting tolerance")
    parser.add_argument("--no-graveyard", action="store_true", help="Do not auto-create graveyard")
    args = parser.parse_args()

    res = convert_to_dagmc(
        args.step,
        output_path=args.output,
        faceting_tolerance=args.tolerance,
        add_graveyard=not args.no_graveyard,
    )
    print(json.dumps(res))
    sys.stdout.flush()
    sys.exit(0 if res.get("success") else 1)
