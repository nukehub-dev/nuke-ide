"""NURBS / free-form surface detection and DAGMC fallback conversion.

Native DAGMC H5M export using OpenCASCADE BRepMesh for tessellation,
with pymoab for H5M output.

NURBS detection still uses gmsh since it provides convenient surface
type classification.
"""

import os
import tempfile
from typing import Any

from . import gmsh_utils
from .ocp_compat import (
    brep_bnd_lib_add,
    brep_gprop_volume_properties,
    brep_tool_triangulation,
    topods_face,
    topods_solid,
)

try:
    import gmsh

    HAS_GMSH = True
except ImportError:
    HAS_GMSH = False


try:
    import numpy as np

    HAS_NUMPY = True
except ImportError:
    HAS_NUMPY = False


# Known free-form surface type strings from gmsh or OCCT
NURBS_TYPE_KEYWORDS = {
    "nurbs",
    "bspline",
    "b-spline",
    "bezier",
    "spline",
    "bsplinesurface",
    "beziersurface",
    "nurbssurface",
    "surfaceofrevolution",
}


def is_nurbs_surface(gmsh_type_str: str) -> bool:
    """Check if a gmsh surface type indicates a free-form NURBS/Bezier surface."""
    t = gmsh_type_str.lower()
    return any(kw in t for kw in NURBS_TYPE_KEYWORDS)


def has_nurbs_surfaces(file_path: str) -> bool:
    """Scan a CAD file for any NURBS or free-form surfaces.

    Returns True if at least one NURBS/Bezier/BSpline/SurfaceOfRevolution
    (with free-form generating curve) surface is found.
    """
    if not HAS_GMSH:
        return False

    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 0)
    try:
        gmsh.open(file_path)
        faces = gmsh_utils.get_faces()
        for dim, tag in faces:
            if gmsh_utils.is_nurbs_like_surface(dim, tag):
                return True
        return False
    except Exception:
        return False
    finally:
        gmsh.finalize()


def get_nurbs_summary(file_path: str) -> dict[str, Any]:
    """Get a summary of which surfaces are NURBS-like vs analytic."""
    result = {
        "hasNurbs": False,
        "totalFaces": 0,
        "nurbsFaces": [],
        "analyticFaces": [],
    }

    if not HAS_GMSH:
        return result

    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 0)
    try:
        gmsh.open(file_path)
        faces = gmsh_utils.get_faces()
        result["totalFaces"] = len(faces)
        for dim, tag in faces:
            stype = gmsh_utils.classify_gmsh_surface_type(dim, tag)
            info = {"tag": tag, "type": stype}
            if gmsh_utils.is_nurbs_like_surface(dim, tag):
                result["hasNurbs"] = True
                if stype == "SurfaceOfRevolution" and gmsh_utils.has_freeform_boundary_curves(
                    dim, tag
                ):
                    info["reason"] = "SurfaceOfRevolution with free-form generating curve"
                else:
                    info["reason"] = "Free-form surface"
                result["nurbsFaces"].append(info)
            else:
                result["analyticFaces"].append(info)
    except Exception as e:
        result["error"] = str(e)
    finally:
        gmsh.finalize()

    return result


def _solids_from_shape(shape: Any) -> list[Any]:
    """Return all TopoDS_Solid instances nested in a shape."""
    from OCP.TopAbs import TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    solids = []
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
    return props.Mass()


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


def _collect_cad_names(file_path: str, ext: str) -> set[str]:
    """Best-effort collection of product/assembly names from STEP/IGES via CAF readers.

    Returns a set of names found in the file. Matching is case-insensitive and
    performed separately from the main shape load so the existing plain readers
    can stay unchanged.
    """
    names: set[str] = set()
    try:
        from OCP.TDataStd import TDataStd_Name
        from OCP.TDF import TDF_LabelSequence
        from OCP.TDocStd import TDocStd_Document
        from OCP.XCAFDoc import XCAFDoc_DocumentTool

        doc = TDocStd_Document("doc")

        if ext in (".step", ".stp"):
            from OCP.STEPCAFControl import STEPCAFControl_Reader

            reader = STEPCAFControl_Reader()
            reader.SetNameMode(True)
        elif ext in (".iges", ".igs"):
            from OCP.IGESCAFControl import IGESCAFControl_Reader

            reader = IGESCAFControl_Reader()
            reader.SetNameMode(True)
        else:
            return names

        status = reader.ReadFile(file_path)
        if status != 1:
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


def _detect_existing_graveyard(
    shape: Any, file_path: str, ext: str
) -> tuple[bool, list[Any], int | None]:
    """Detect whether ``shape`` already contains a graveyard volume.

    Detection order:
    1. Name-based: any product/assembly name contains "graveyard" (case-insensitive).
    2. Heuristic: one solid is >10x the volume of the next largest and fully
       contains all other solids.

    Returns (detected, model_solids, graveyard_index). ``graveyard_index`` is
    the 0-based index of the existing graveyard solid in ``model_solids`` (or
    in the full solid list when ``model_solids`` is returned unchanged). It is
    ``None`` when a graveyard name is found but the solid cannot be identified.
    ``model_solids`` lists the non-graveyard solids when a graveyard was
    detected by heuristic or by a matched name; otherwise it lists all solids.
    """
    solids = _solids_from_shape(shape)

    def _find_largest_enclosing() -> int | None:
        """Return the index of the solid that is vastly larger than and
        contains all others, or None if no such solid exists."""
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

    # 1. Name-based detection.
    name_detected = False
    try:
        names = _collect_cad_names(file_path, ext)
        name_detected = any("graveyard" in n.lower() for n in names)
    except Exception:
        pass

    if name_detected:
        gy_index = _find_largest_enclosing()
        if gy_index is not None:
            return True, [solids[i] for i in range(len(solids)) if i != gy_index], gy_index
        # Name indicates a graveyard but we cannot identify which solid.
        return True, solids, None

    # 2. Heuristic detection.
    gy_index = _find_largest_enclosing()
    if gy_index is not None:
        return True, [solids[i] for i in range(len(solids)) if i != gy_index], gy_index

    return False, solids, None


def _make_compound(solids: list[Any]) -> Any:
    """Build a TopoDS_Compound from a list of solids."""
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeCompound

    builder = BRepBuilderAPI_MakeCompound()
    for solid in solids:
        builder.Add(solid)
    return builder.Shape()


def _build_graveyard_shape(model_solids: list[Any], warnings: list[str]) -> Any | None:
    """Create a graveyard box around the model and cut the model out of it.

    Returns a compound of the model solids plus the graveyard solid(s), or None
    if the boolean operation fails.
    """
    if not model_solids:
        warnings.append(
            "Could not auto-create graveyard: no model solids found. "
            "Add one in your CAD workflow if needed."
        )
        return None

    try:
        from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
        from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeCompound
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
            warnings.append(
                "Could not auto-create graveyard: boolean cut failed. "
                "Add one in your CAD workflow if needed."
            )
            return None

        graveyard_shape = cut.Shape()
        graveyard_solids = _solids_from_shape(graveyard_shape)
        if not graveyard_solids:
            warnings.append(
                "Could not auto-create graveyard: boolean cut produced no volumes. "
                "Add one in your CAD workflow if needed."
            )
            return None

        builder = BRepBuilderAPI_MakeCompound()
        for solid in model_solids:
            builder.Add(solid)
        for solid in graveyard_solids:
            builder.Add(solid)
        return builder.Shape()
    except Exception as e:
        warnings.append(
            f"Could not auto-create graveyard: {e}. Add one in your CAD workflow if needed."
        )
        return None


def _maybe_add_graveyard(
    shape: Any, file_path: str, ext: str, warnings: list[str]
) -> tuple[Any, set[int]]:
    """Add a graveyard volume to ``shape`` if one is not already present.

    Returns ``(shape, graveyard_vol_ids)``. ``graveyard_vol_ids`` is a set of
    1-based volume IDs that should be tagged ``mat:graveyard`` in the MOAB
    output. For an existing graveyard this is the detected solid's 1-based
    index; for an auto-created graveyard it is the range of new volumes
    appended after the model solids.
    """
    try:
        has_graveyard, model_solids, gy_index = _detect_existing_graveyard(shape, file_path, ext)
        if has_graveyard:
            warnings.append("Existing graveyard volume detected; skipping auto-creation.")
            graveyard_ids = set()
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
        warnings.append(
            f"Could not auto-create graveyard: {e}. Add one in your CAD workflow if needed."
        )
        return shape, set()


def convert_to_dagmc(
    file_path: str,
    output_path: str | None = None,
    faceting_tolerance: float = 0.001,
    length_scale: float = 1.0,
    auto_adjust_tolerance: bool = True,
    add_graveyard: bool = True,
) -> dict[str, Any]:
    """Convert a CAD file to DAGMC .h5m format.

    Uses OpenCASCADE BRepMesh_IncrementalMesh for tessellation,
    then writes a properly tagged DAGMC H5M file via pymoab.

    Args:
        file_path: Input CAD file (STEP/IGES).
        output_path: Output .h5m file path. If None, uses tempfile.
        faceting_tolerance: Mesh tolerance for faceting.
        length_scale: Scale factor applied to mesh vertices.
        auto_adjust_tolerance: Whether to auto-adjust tolerance for large models.
        add_graveyard: Whether to auto-create a mat:graveyard bounding volume
            when the input does not already appear to have one.

    Returns:
        Dict with success, output_path, warnings, error.
    """
    result = {
        "success": False,
        "output_path": output_path,
        "warnings": [],
        "error": None,
    }

    # Check for required dependencies (OCP + pymoab)
    try:
        from OCP.BRepMesh import BRepMesh_IncrementalMesh  # noqa: F401  # availability probe
        from OCP.STEPControl import STEPControl_Reader  # noqa: F401  # availability probe
        from pymoab import core as _moab_core  # noqa: F401  # availability probe
    except (ImportError, AttributeError) as e:
        result["error"] = f"Required dependency missing or incompatible: {e}"
        return result

    if output_path is None:
        fd, tmp_path = tempfile.mkstemp(suffix=".h5m")
        os.close(fd)
        output_path = tmp_path
        result["output_path"] = output_path

    h5m_success = _native_dagmc_conversion(
        file_path,
        output_path,
        faceting_tolerance,
        length_scale,
        result["warnings"],
        auto_adjust_tolerance,
        add_graveyard,
    )

    if h5m_success:
        result["success"] = True
    else:
        # Surface the actual failure reason from warnings rather than a
        # misleading blanket message about pymoab/h5py.
        if result["warnings"]:
            result["error"] = result["warnings"].pop(0)
        else:
            result["error"] = (
                "Failed to convert CAD to DAGMC .h5m. "
                "Ensure the CAD environment has OCP (CadQuery OCC) and pymoab installed."
            )

    return result


def _native_dagmc_conversion(
    file_path: str,
    h5m_path: str,
    faceting_tolerance: float,
    length_scale: float,
    warnings: list[str],
    auto_adjust_tolerance: bool = True,
    add_graveyard: bool = False,
) -> bool:
    """Native DAGMC conversion pipeline using OpenCASCADE BRepMesh."""
    try:
        from OCP.BRep import BRep_Tool
        from OCP.BRepMesh import BRepMesh_IncrementalMesh
        from OCP.IGESControl import IGESControl_Reader
        from OCP.STEPControl import STEPControl_Reader
        from OCP.TopAbs import TopAbs_FACE, TopAbs_SOLID
        from OCP.TopExp import TopExp_Explorer
        from OCP.TopoDS import TopoDS
        from pymoab import core as moab_core
        from pymoab import types
    except (ImportError, AttributeError) as e:
        warnings.append(f"Missing or incompatible dependency for fast DAGMC conversion: {e}")
        return False

    try:
        # 1. Load CAD file
        ext = os.path.splitext(file_path)[1].lower()
        if ext in (".step", ".stp"):
            reader = STEPControl_Reader()
        elif ext in (".iges", ".igs"):
            reader = IGESControl_Reader()
        else:
            warnings.append(f"Unsupported CAD format: {ext}. Trying STEP reader.")
            reader = STEPControl_Reader()

        status = reader.ReadFile(file_path)
        if status != 1:
            warnings.append(f"Failed to read CAD file, status={status}")
            return False

        reader.TransferRoot()
        shape = reader.OneShape()

        # 2. Optionally auto-create a graveyard volume before tessellation.
        graveyard_vol_ids: set[int] = set()
        if add_graveyard:
            shape, graveyard_vol_ids = _maybe_add_graveyard(shape, file_path, ext, warnings)

        # 3. Auto-adjust tolerance for large models
        tol = faceting_tolerance
        if auto_adjust_tolerance:
            from OCP.Bnd import Bnd_Box
            from OCP.BRepBndLib import BRepBndLib

            bbox = Bnd_Box()
            brep_bnd_lib_add(BRepBndLib, shape, bbox)
            xmin, ymin, zmin, xmax, ymax, zmax = bbox.Get()
            diag = ((xmax - xmin) ** 2 + (ymax - ymin) ** 2 + (zmax - zmin) ** 2) ** 0.5
            if diag > 100 and tol < 1.0:
                old_tol = tol
                tol = max(tol, min(diag / 200, 10.0))
                warnings.append(
                    f"Faceting tolerance auto-adjusted from {old_tol:.4f} to {tol:.4f} "
                    f"for large model (diagonal {diag:.1f} cm)"
                )

        # 4. Tessellate with OpenCASCADE
        BRepMesh_IncrementalMesh(shape, tol, False, 0.5, True)

        # 5. Extract geometry into MOAB
        vertex_coords = []
        volume_faces = []
        face_to_volumes = {}
        face_hashes = {}

        solid_exp = TopExp_Explorer(shape, TopAbs_SOLID)
        vol_id = 1
        while solid_exp.More():
            solid = topods_solid(TopoDS, solid_exp.Current())
            faces = []
            face_exp = TopExp_Explorer(solid, TopAbs_FACE)
            while face_exp.More():
                face = topods_face(TopoDS, face_exp.Current())
                loc = face.Location()
                tri = brep_tool_triangulation(BRep_Tool, face, loc)
                if tri is None or tri.NbTriangles() == 0:
                    face_exp.Next()
                    continue

                face_hash = hash(face.TShape().__hash__())
                if face_hash not in face_to_volumes:
                    face_to_volumes[face_hash] = []
                face_to_volumes[face_hash].append(vol_id)

                if face_hash not in face_hashes:
                    trsf = loc.Transformation()
                    local_to_global = {}
                    for i in range(1, tri.NbNodes() + 1):
                        pnt = tri.Node(i)
                        pnt.Transform(trsf)
                        if length_scale != 1.0:
                            vertex_coords.append(
                                [
                                    pnt.X() * length_scale,
                                    pnt.Y() * length_scale,
                                    pnt.Z() * length_scale,
                                ]
                            )
                        else:
                            vertex_coords.append([pnt.X(), pnt.Y(), pnt.Z()])
                        local_to_global[i] = len(vertex_coords) - 1

                    face_tris = []
                    for i in range(1, tri.NbTriangles() + 1):
                        t = tri.Triangle(i)
                        face_tris.append(
                            [
                                local_to_global[t.Value(1)],
                                local_to_global[t.Value(2)],
                                local_to_global[t.Value(3)],
                            ]
                        )
                    face_hashes[face_hash] = face_tris

                faces.append(face_hash)
                face_exp.Next()

            if faces:
                volume_faces.append((vol_id, faces))
                vol_id += 1
            solid_exp.Next()

        # 5. Build MOAB
        mb = moab_core.Core()
        tag_cat = mb.tag_get_handle(
            types.CATEGORY_TAG_NAME,
            types.CATEGORY_TAG_SIZE,
            types.MB_TYPE_OPAQUE,
            types.MB_TAG_SPARSE,
            create_if_missing=True,
        )
        tag_name = mb.tag_get_handle(
            types.NAME_TAG_NAME,
            types.NAME_TAG_SIZE,
            types.MB_TYPE_OPAQUE,
            types.MB_TAG_SPARSE,
            create_if_missing=True,
        )
        tag_gdim = mb.tag_get_handle(
            types.GEOM_DIMENSION_TAG_NAME,
            1,
            types.MB_TYPE_INTEGER,
            types.MB_TAG_DENSE,
            create_if_missing=True,
        )
        tag_gid = mb.tag_get_handle(types.GLOBAL_ID_TAG_NAME)
        tag_sense = mb.tag_get_handle(
            "GEOM_SENSE_2", 2, types.MB_TYPE_HANDLE, types.MB_TAG_SPARSE, create_if_missing=True
        )
        tag_facet_tol = mb.tag_get_handle(
            "FACETING_TOL", 1, types.MB_TYPE_DOUBLE, types.MB_TAG_SPARSE, create_if_missing=True
        )

        verts_array = np.array(vertex_coords, dtype=np.float64)
        moab_verts = mb.create_vertices(verts_array)

        surface_sets = {}
        surf_id = 1
        for face_hash in face_hashes:
            sset = mb.create_meshset()
            mb.tag_set_data(tag_gid, sset, surf_id)
            mb.tag_set_data(tag_gdim, sset, 2)
            mb.tag_set_data(tag_cat, sset, "Surface")
            surface_sets[face_hash] = sset

            for tri_idx in face_hashes[face_hash]:
                tri_verts = (
                    moab_verts[tri_idx[0]],
                    moab_verts[tri_idx[1]],
                    moab_verts[tri_idx[2]],
                )
                mb_tri = mb.create_element(types.MBTRI, tri_verts)
                mb.add_entity(sset, mb_tri)
            surf_id += 1

        volume_sets = {}
        for vol_id, face_hash_list in volume_faces:
            vset = mb.create_meshset()
            mb.tag_set_data(tag_gid, vset, vol_id)
            mb.tag_set_data(tag_gdim, vset, 3)
            mb.tag_set_data(tag_cat, vset, "Volume")
            volume_sets[vol_id] = vset

            for fh in face_hash_list:
                mb.add_parent_child(vset, surface_sets[fh])

            if vol_id in graveyard_vol_ids:
                mat_name = "graveyard"
            else:
                mat_name = f"mat_{vol_id - 1}"
            gset = mb.create_meshset()
            mb.tag_set_data(tag_cat, gset, "Group")
            mb.tag_set_data(tag_gdim, gset, 4)
            mb.tag_set_data(tag_name, gset, f"mat:{mat_name}")
            mb.tag_set_data(tag_gid, gset, vol_id)
            mb.add_entity(gset, vset)

        for face_hash, vols in face_to_volumes.items():
            if face_hash not in surface_sets:
                continue
            sset = surface_sets[face_hash]
            if len(vols) == 2 and vols[0] in volume_sets and vols[1] in volume_sets:
                sense_data = np.array([volume_sets[vols[0]], volume_sets[vols[1]]], dtype=np.uint64)
            elif len(vols) >= 1 and vols[0] in volume_sets:
                sense_data = np.array([volume_sets[vols[0]], 0], dtype=np.uint64)
            else:
                continue
            mb.tag_set_data(tag_sense, sset, sense_data)

        root = mb.get_root_set()
        mb.tag_set_data(tag_facet_tol, root, float(tol))
        mb.write_file(h5m_path)

        total_tris = sum(sum(len(face_hashes[fh]) for fh in fl) for _, fl in volume_faces)
        warnings.append(
            f"DAGMC conversion: {len(volume_faces)} volumes, "
            f"{len(vertex_coords)} vertices, {total_tris} triangles"
        )
        return True

    except Exception as e:
        import traceback

        warnings.append(f"DAGMC conversion failed: {e}\n{traceback.format_exc()}")
        return False
