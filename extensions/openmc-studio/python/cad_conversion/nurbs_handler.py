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


def convert_to_dagmc(
    file_path: str,
    output_path: str | None = None,
    faceting_tolerance: float = 0.001,
    length_scale: float = 1.0,
    auto_adjust_tolerance: bool = True,
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
    except ImportError as e:
        result["error"] = f"Required dependency missing: {e}"
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
    )

    if h5m_success:
        result["success"] = True
    else:
        result["error"] = "Failed to convert CAD to DAGMC .h5m. Ensure pymoab or h5py is installed."

    return result


def _native_dagmc_conversion(
    file_path: str,
    h5m_path: str,
    faceting_tolerance: float,
    length_scale: float,
    warnings: list[str],
    auto_adjust_tolerance: bool = True,
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
    except ImportError as e:
        warnings.append(f"Missing dependency for fast DAGMC conversion: {e}")
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

        # 2. Auto-adjust tolerance for large models
        tol = faceting_tolerance
        if auto_adjust_tolerance:
            from OCP.Bnd import Bnd_Box
            from OCP.BRepBndLib import BRepBndLib

            bbox = Bnd_Box()
            BRepBndLib.Add_s(shape, bbox)
            xmin, ymin, zmin, xmax, ymax, zmax = bbox.Get()
            diag = ((xmax - xmin) ** 2 + (ymax - ymin) ** 2 + (zmax - zmin) ** 2) ** 0.5
            if diag > 100 and tol < 1.0:
                old_tol = tol
                tol = max(tol, min(diag / 200, 10.0))
                warnings.append(
                    f"Faceting tolerance auto-adjusted from {old_tol:.4f} to {tol:.4f} "
                    f"for large model (diagonal {diag:.1f} cm)"
                )

        # 3. Tessellate with OpenCASCADE
        BRepMesh_IncrementalMesh(shape, tol, False, 0.5, True)

        # 4. Extract geometry into MOAB
        vertex_coords = []
        volume_faces = []
        face_to_volumes = {}
        face_hashes = {}

        solid_exp = TopExp_Explorer(shape, TopAbs_SOLID)
        vol_id = 1
        while solid_exp.More():
            solid = TopoDS.Solid_s(solid_exp.Current())
            faces = []
            face_exp = TopExp_Explorer(solid, TopAbs_FACE)
            while face_exp.More():
                face = TopoDS.Face_s(face_exp.Current())
                loc = face.Location()
                tri = BRep_Tool.Triangulation_s(face, loc)
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
