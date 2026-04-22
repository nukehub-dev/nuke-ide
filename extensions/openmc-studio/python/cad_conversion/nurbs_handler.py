"""NURBS / free-form surface detection and DAGMC fallback conversion.

Native DAGMC H5M export without external cad_to_dagmc dependency.
"""

import os
import tempfile
from typing import List, Tuple, Dict, Any, Optional

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
NURBS_TYPE_KEYWORDS = {'nurbs', 'bspline', 'b-spline', 'bezier', 'spline',
                       'bsplinesurface', 'beziersurface', 'nurbssurface',
                       'surfaceofrevolution'}


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


def get_nurbs_summary(file_path: str) -> Dict[str, Any]:
    """Get a summary of which surfaces are NURBS-like vs analytic."""
    result = {
        'hasNurbs': False,
        'totalFaces': 0,
        'nurbsFaces': [],
        'analyticFaces': [],
    }

    if not HAS_GMSH:
        return result

    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 0)
    try:
        gmsh.open(file_path)
        faces = gmsh_utils.get_faces()
        result['totalFaces'] = len(faces)
        for dim, tag in faces:
            stype = gmsh_utils.classify_gmsh_surface_type(dim, tag)
            info = {'tag': tag, 'type': stype}
            if gmsh_utils.is_nurbs_like_surface(dim, tag):
                result['hasNurbs'] = True
                if stype == 'SurfaceOfRevolution' and gmsh_utils.has_freeform_boundary_curves(dim, tag):
                    info['reason'] = 'SurfaceOfRevolution with free-form generating curve'
                else:
                    info['reason'] = 'Free-form surface'
                result['nurbsFaces'].append(info)
            else:
                result['analyticFaces'].append(info)
    except Exception as e:
        result['error'] = str(e)
    finally:
        gmsh.finalize()

    return result


def convert_to_dagmc(file_path: str,
                     output_path: Optional[str] = None,
                     faceting_tolerance: float = 0.001,
                     length_scale: float = 1.0,
                     auto_adjust_tolerance: bool = True) -> Dict[str, Any]:
    """Convert a CAD file to DAGMC .h5m format.

    Uses gmsh to mesh the geometry, then writes a properly tagged DAGMC
    H5M file using pymoab (preferred) or h5py (fallback).

    Args:
        file_path: Input CAD file (STEP/IGES/BREP).
        output_path: Output .h5m file path. If None, uses tempfile.
        faceting_tolerance: Mesh tolerance for faceting.
        length_scale: Scale factor applied to mesh vertices.
        auto_adjust_tolerance: Whether to auto-adjust tolerance for large models.

    Returns:
        Dict with success, output_path, warnings, error.
    """
    result = {
        'success': False,
        'output_path': output_path,
        'warnings': [],
        'error': None,
    }

    if not HAS_GMSH:
        result['error'] = 'gmsh is not installed'
        return result

    if output_path is None:
        fd, tmp_path = tempfile.mkstemp(suffix='.h5m')
        os.close(fd)
        output_path = tmp_path
        result['output_path'] = output_path

    h5m_success = _native_dagmc_conversion(
        file_path, output_path, faceting_tolerance, length_scale,
        result['warnings'], auto_adjust_tolerance
    )

    if h5m_success:
        result['success'] = True
    else:
        result['error'] = (
            'Failed to convert CAD to DAGMC .h5m. '
            'Ensure pymoab or h5py is installed.'
        )

    return result


def _native_dagmc_conversion(file_path: str, h5m_path: str,
                             faceting_tolerance: float, length_scale: float,
                             warnings: List[str],
                             auto_adjust_tolerance: bool = True) -> bool:
    """Native DAGMC conversion pipeline.

    1. Mesh the CAD with gmsh
    2. Extract vertices and triangles grouped by volume/face
    3. Write tagged H5M via pymoab or h5py
    """
    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 0)

    try:
        gmsh.open(file_path)

        # Auto-adjust faceting tolerance for very large models.
        # The default 0.001 cm is impossibly fine for large assemblies and
        # would create billions of triangles / hang indefinitely. We cap at
        # 10.0 cm to keep runtime reasonable while preserving enough detail
        # for visualization and DAGMC transport.
        bbox = gmsh.model.getBoundingBox(-1, -1)
        diag = ((bbox[3]-bbox[0])**2 + (bbox[4]-bbox[1])**2 + (bbox[5]-bbox[2])**2)**0.5
        tol = faceting_tolerance
        if auto_adjust_tolerance and diag > 100 and tol < 1.0:
            old_tol = tol
            tol = max(tol, min(diag / 200, 10.0))
            warnings.append(
                f'Faceting tolerance auto-adjusted from {old_tol:.4f} to {tol:.4f} '
                f'for large model (diagonal {diag:.1f} cm)'
            )

        # Mesh settings that balance quality vs speed.
        # Frontal-Delaunay (6) + optimization produces smooth meshes on
        # curved surfaces (cylinders, tori, surfaces of revolution).
        gmsh.option.setNumber('Mesh.Algorithm', 6)
        gmsh.option.setNumber('Mesh.MeshSizeMax', tol)
        gmsh.option.setNumber('Mesh.MeshSizeMin', tol * 0.05)
        gmsh.option.setNumber('Mesh.Optimize', 1)
        gmsh.option.setNumber('Mesh.QualityType', 2)

        gmsh.model.mesh.generate(2)

        # Extract mesh data
        vertices, triangles_by_vol_by_face = _extract_gmsh_mesh()

        if length_scale != 1.0:
            vertices = [[v[0]*length_scale, v[1]*length_scale, v[2]*length_scale] for v in vertices]

        # Generate default material tags
        volumes = sorted(triangles_by_vol_by_face.keys())
        material_tags = [f'mat_{i}' for i in range(len(volumes))]

        # Try pymoab first, then h5py
        if _write_dagmc_pymoab(vertices, triangles_by_vol_by_face, material_tags, h5m_path):
            return True
        if _write_dagmc_h5py(vertices, triangles_by_vol_by_face, material_tags, h5m_path):
            warnings.append('DAGMC file written via h5py fallback.')
            return True

    except Exception as e:
        warnings.append(f'Native DAGMC conversion failed: {e}')
    finally:
        try:
            gmsh.finalize()
        except Exception:
            pass

    return False


def _extract_gmsh_mesh() -> Tuple[List[List[float]], Dict[int, Dict[int, List[List[int]]]]]:
    """Extract vertices and triangles from gmsh mesh.

    Returns:
        (vertices, triangles_by_vol_by_face)
        vertices: List of [x, y, z] floats
        triangles_by_vol_by_face: Dict[volume_tag][face_tag] = list of [v0, v1, v2] int indices
    """
    # Get all nodes (1-based tags in gmsh)
    node_tags, node_coords, _ = gmsh.model.mesh.getNodes()

    # Build vertex list indexed by gmsh node tag (1-based)
    max_tag = int(max(node_tags))
    vertices = [None] * (max_tag + 1)
    for tag, x, y, z in zip(node_tags, node_coords[0::3], node_coords[1::3], node_coords[2::3]):
        vertices[int(tag)] = [float(x), float(y), float(z)]

    # Remove unused index 0
    vertices = vertices[1:]
    # Now vertices[i] corresponds to gmsh node tag (i+1)

    # For each volume, get its boundary faces and their triangles
    triangles_by_vol_by_face: Dict[int, Dict[int, List[List[int]]]] = {}

    volumes = gmsh.model.getEntities(3)
    for vol_dim, vol_tag in volumes:
        boundary = gmsh.model.getBoundary([(vol_dim, vol_tag)], oriented=False, recursive=False)
        face_tris: Dict[int, List[List[int]]] = {}

        for face_dim, face_tag in boundary:
            if face_dim != 2:
                continue

            elem_types, elem_tags, elem_node_tags = gmsh.model.mesh.getElements(face_dim, face_tag)

            face_triangles: List[List[int]] = []
            for etype, etags, enodes in zip(elem_types, elem_tags, elem_node_tags):
                if etype == 2:  # 3-node triangle
                    for i in range(0, len(enodes), 3):
                        tri = [int(enodes[i + j]) - 1 for j in range(3)]
                        face_triangles.append(tri)
                elif etype == 3:  # 4-node quadrilateral -> split into 2 triangles
                    for i in range(0, len(enodes), 4):
                        q = [int(enodes[i + j]) - 1 for j in range(4)]
                        face_triangles.append([q[0], q[1], q[2]])
                        face_triangles.append([q[0], q[2], q[3]])
                else:
                    continue

            if face_triangles:
                face_tris[face_tag] = face_triangles

        if face_tris:
            triangles_by_vol_by_face[vol_tag] = face_tris

    return vertices, triangles_by_vol_by_face


def _write_dagmc_pymoab(vertices: List[List[float]],
                        triangles_by_vol_by_face: Dict[int, Dict[int, List[List[int]]]],
                        material_tags: List[str],
                        h5m_path: str) -> bool:
    """Write DAGMC H5M file using pymoab.

    Creates proper MOAB entity sets with DAGMC tags:
    - CATEGORY (Volume, Surface, Group)
    - GEOM_DIMENSION (3 for volumes, 2 for surfaces)
    - NAME (material names on groups)
    - GLOBAL_ID (volume/surface IDs)
    - GEOM_SENSE_2 (surface-to-volume sense)
    """
    try:
        from pymoab import core, types
    except ImportError:
        return False

    try:
        moab = core.Core()

        # Create DAGMC tags
        tag_cat = moab.tag_get_handle(
            types.CATEGORY_TAG_NAME, types.CATEGORY_TAG_SIZE,
            types.MB_TYPE_OPAQUE, types.MB_TAG_SPARSE, create_if_missing=True
        )
        tag_name = moab.tag_get_handle(
            types.NAME_TAG_NAME, types.NAME_TAG_SIZE,
            types.MB_TYPE_OPAQUE, types.MB_TAG_SPARSE, create_if_missing=True
        )
        tag_gdim = moab.tag_get_handle(
            types.GEOM_DIMENSION_TAG_NAME, 1,
            types.MB_TYPE_INTEGER, types.MB_TAG_DENSE, create_if_missing=True
        )
        tag_gid = moab.tag_get_handle(types.GLOBAL_ID_TAG_NAME)
        tag_sense = moab.tag_get_handle(
            "GEOM_SENSE_2", 2,
            types.MB_TYPE_HANDLE, types.MB_TAG_SPARSE, create_if_missing=True
        )

        # Create vertices
        verts_array = np.array(vertices, dtype=np.float64)
        moab_verts = moab.create_vertices(verts_array)

        # Track which solids each face belongs to
        face_to_volumes: Dict[int, List[int]] = {}
        for vol_tag, face_dict in triangles_by_vol_by_face.items():
            for face_tag in face_dict.keys():
                if face_tag not in face_to_volumes:
                    face_to_volumes[face_tag] = []
                face_to_volumes[face_tag].append(vol_tag)

        # Create volume meshsets
        volume_sets: Dict[int, Any] = {}
        for vol_tag in triangles_by_vol_by_face.keys():
            vset = moab.create_meshset()
            moab.tag_set_data(tag_gid, vset, int(vol_tag))
            moab.tag_set_data(tag_gdim, vset, 3)
            moab.tag_set_data(tag_cat, vset, "Volume")
            volume_sets[vol_tag] = vset

        # Create surface meshsets and add triangles
        surface_sets: Dict[int, Any] = {}
        for face_tag, vols in face_to_volumes.items():
            sset = moab.create_meshset()
            moab.tag_set_data(tag_gid, sset, int(face_tag))
            moab.tag_set_data(tag_gdim, sset, 2)
            moab.tag_set_data(tag_cat, sset, "Surface")
            surface_sets[face_tag] = sset

            # Add triangles to surface
            # Collect all triangles for this face (from any volume)
            all_tris: List[List[int]] = []
            for vol_tag in vols:
                if face_tag in triangles_by_vol_by_face[vol_tag]:
                    all_tris.extend(triangles_by_vol_by_face[vol_tag][face_tag])

            # Deduplicate triangles
            seen = set()
            unique_tris = []
            for tri in all_tris:
                key = tuple(sorted(tri))
                if key not in seen:
                    seen.add(key)
                    unique_tris.append(tri)

            # Create MOAB triangles
            for tri in unique_tris:
                tri_verts = (moab_verts[tri[0]], moab_verts[tri[1]], moab_verts[tri[2]])
                mb_tri = moab.create_element(types.MBTRI, tri_verts)
                moab.add_entity(sset, mb_tri)

            # Set GEOM_SENSE_2
            if len(vols) == 2:
                sense_data = np.array([volume_sets[vols[0]], volume_sets[vols[1]]], dtype=np.uint64)
            elif len(vols) == 1:
                sense_data = np.array([volume_sets[vols[0]], 0], dtype=np.uint64)
            else:
                sense_data = np.array([volume_sets[vols[0]], 0], dtype=np.uint64)
            moab.tag_set_data(tag_sense, sset, sense_data)

        # Link volumes to surfaces
        for vol_tag, face_dict in triangles_by_vol_by_face.items():
            vset = volume_sets[vol_tag]
            for face_tag in face_dict.keys():
                sset = surface_sets[face_tag]
                moab.add_parent_child(vset, sset)

        # Create material groups
        group_sets: Dict[int, Any] = {}
        for i, vol_tag in enumerate(triangles_by_vol_by_face.keys()):
            mat_tag = material_tags[i] if i < len(material_tags) else f'mat_{i}'
            gset = moab.create_meshset()
            moab.tag_set_data(tag_cat, gset, "Group")
            moab.tag_set_data(tag_gdim, gset, 4)
            moab.tag_set_data(tag_name, gset, f"mat:{mat_tag}")
            moab.tag_set_data(tag_gid, gset, int(vol_tag))
            moab.add_entity(gset, volume_sets[vol_tag])
            group_sets[vol_tag] = gset

        # File set
        all_sets = moab.get_entities_by_handle(0)
        file_set = moab.create_meshset()
        moab.add_entities(file_set, all_sets)

        moab.write_file(str(h5m_path))
        return True

    except Exception as e:
        return False


def _write_dagmc_h5py(vertices: List[List[float]],
                      triangles_by_vol_by_face: Dict[int, Dict[int, List[List[int]]]],
                      material_tags: List[str],
                      h5m_path: str) -> bool:
    """Write DAGMC H5M file using h5py (fallback when pymoab is unavailable).

    Reproduces the minimal tstt/ structure that DAGMC expects.
    """
    try:
        import h5py
        from datetime import datetime
    except ImportError:
        return False

    try:
        # Build face -> volumes mapping
        face_to_volumes: Dict[int, List[int]] = {}
        for vol_tag, face_dict in triangles_by_vol_by_face.items():
            for face_tag in face_dict.keys():
                if face_tag not in face_to_volumes:
                    face_to_volumes[face_tag] = []
                face_to_volumes[face_tag].append(vol_tag)

        # Deduplicate triangles per face
        all_faces: Dict[int, List[List[int]]] = {}
        for vol_tag, face_dict in triangles_by_vol_by_face.items():
            for face_tag, tris in face_dict.items():
                if face_tag not in all_faces:
                    all_faces[face_tag] = []
                all_faces[face_tag].extend(tris)

        for face_tag in all_faces:
            seen = set()
            unique = []
            for tri in all_faces[face_tag]:
                key = tuple(sorted(tri))
                if key not in seen:
                    seen.add(key)
                    unique.append(tri)
            all_faces[face_tag] = unique

        vertices_arr = np.array(vertices, dtype=np.float64)
        num_vertices = len(vertices_arr)

        # Flatten all triangles
        all_triangles = []
        for face_tag in sorted(all_faces.keys()):
            all_triangles.extend(all_faces[face_tag])
        all_triangles = np.array(all_triangles, dtype=np.int64)
        num_triangles = len(all_triangles)

        solid_ids = list(triangles_by_vol_by_face.keys())
        num_solids = len(solid_ids)

        with h5py.File(h5m_path, "w") as f:
            tstt = f.create_group("tstt")

            # Element type enum
            elems = {"Edge": 1, "Tri": 2, "Quad": 3, "Polygon": 4, "Tet": 5,
                     "Pyramid": 6, "Prism": 7, "Knife": 8, "Hex": 9, "Polyhedron": 10}
            tstt["elemtypes"] = h5py.enum_dtype(elems)

            now = datetime.now()
            tstt.create_dataset("history", data=[
                b"nuke-ide cad_conversion",
                b"1.0.0",
                now.strftime("%m/%d/%y").encode("ascii"),
                now.strftime("%H:%M:%S").encode("ascii"),
            ])

            # Nodes
            nodes_group = tstt.create_group("nodes")
            coords = nodes_group.create_dataset("coordinates", data=vertices_arr)
            coords.attrs.create("start_id", 1)
            node_tags = nodes_group.create_group("tags")
            node_tags.create_dataset("GLOBAL_ID", data=np.full(num_vertices, -1, dtype=np.int32))

            # Elements (triangles)
            elements = tstt.create_group("elements")
            tri3_group = elements.create_group("Tri3")
            tri3_group.attrs.create("element_type", elems["Tri"], dtype=tstt["elemtypes"])
            tri_start_id = num_vertices + 1
            connectivity = tri3_group.create_dataset("connectivity", data=all_triangles + 1, dtype=np.uint64)
            connectivity.attrs.create("start_id", tri_start_id)
            tags_tri3 = tri3_group.create_group("tags")
            tags_tri3.create_dataset("GLOBAL_ID", data=np.full(num_triangles, -1, dtype=np.int32))

            # Assign set IDs
            surface_set_ids = {}
            volume_set_ids = {}
            group_set_ids = {}
            current_id = tri_start_id + num_triangles

            for face_tag in sorted(all_faces.keys()):
                surface_set_ids[face_tag] = current_id
                current_id += 1
            for solid_id in solid_ids:
                volume_set_ids[solid_id] = current_id
                current_id += 1
            for solid_id in solid_ids:
                group_set_ids[solid_id] = current_id
                current_id += 1
            file_set_id = current_id
            current_id += 1

            # Tags
            tstt_tags = tstt.create_group("tags")

            # CATEGORY
            category_ids = []
            categories = []
            for face_tag in sorted(all_faces.keys()):
                category_ids.append(surface_set_ids[face_tag])
                categories.append("Surface")
            for solid_id in solid_ids:
                category_ids.append(volume_set_ids[solid_id])
                categories.append("Volume")
            for solid_id in solid_ids:
                category_ids.append(group_set_ids[solid_id])
                categories.append("Group")
            category_ids.append(file_set_id)
            categories.append("Group")

            cat_group = tstt_tags.create_group("CATEGORY")
            cat_group.attrs.create("class", 1, dtype=np.int32)
            cat_group.create_dataset("id_list", data=np.array(category_ids, dtype=np.uint64))
            cat_group["type"] = h5py.opaque_dtype(np.dtype("V32"))
            cat_values = np.array([s.encode("ascii").ljust(32, b"\x00") for s in categories], dtype="V32")
            cat_group.create_dataset("values", data=cat_values)

            # GEOM_DIMENSION
            geom_ids = []
            geom_dims = []
            for face_tag in sorted(all_faces.keys()):
                geom_ids.append(surface_set_ids[face_tag])
                geom_dims.append(2)
            for solid_id in solid_ids:
                geom_ids.append(volume_set_ids[solid_id])
                geom_dims.append(3)
            for solid_id in solid_ids:
                geom_ids.append(group_set_ids[solid_id])
                geom_dims.append(4)

            geom_group = tstt_tags.create_group("GEOM_DIMENSION")
            geom_group["type"] = np.dtype("i4")
            geom_group.attrs.create("class", 1, dtype=np.int32)
            geom_group.attrs.create("default", -1, dtype=geom_group["type"])
            geom_group.attrs.create("global", -1, dtype=geom_group["type"])
            geom_group.create_dataset("id_list", data=np.array(geom_ids, dtype=np.uint64))
            geom_group.create_dataset("values", data=np.array(geom_dims, dtype=np.int32))

            # GEOM_SENSE_2
            surface_ids_list = [surface_set_ids[fid] for fid in sorted(all_faces.keys())]
            gs2_group = tstt_tags.create_group("GEOM_SENSE_2")
            gs2_dtype = np.dtype("(2,)u8")
            gs2_group["type"] = gs2_dtype
            gs2_group.attrs.create("class", 1, dtype=np.int32)
            gs2_group.attrs.create("is_handle", 1, dtype=np.int32)
            gs2_group.create_dataset("id_list", data=np.array(surface_ids_list, dtype=np.uint64))

            sense_values = []
            for face_tag in sorted(all_faces.keys()):
                vols = face_to_volumes[face_tag]
                if len(vols) == 2:
                    sense_values.append([volume_set_ids[vols[0]], volume_set_ids[vols[1]]])
                else:
                    sense_values.append([volume_set_ids[vols[0]], 0])

            if sense_values:
                gs2_values = np.zeros((len(sense_values),), dtype=[("f0", "<u8", (2,))])
                gs2_values["f0"] = np.array(sense_values, dtype=np.uint64)
                gs2_space = h5py.h5s.create_simple((len(sense_values),))
                gs2_arr_type = h5py.h5t.array_create(h5py.h5t.NATIVE_UINT64, (2,))
                gs2_dset = h5py.h5d.create(gs2_group.id, b"values", gs2_arr_type, gs2_space)
                gs2_dset.write(h5py.h5s.ALL, h5py.h5s.ALL, gs2_values, mtype=gs2_arr_type)
                gs2_dset.close()

            # GLOBAL_ID
            gid_ids = []
            gid_values = []
            for face_tag in sorted(all_faces.keys()):
                gid_ids.append(surface_set_ids[face_tag])
                gid_values.append(face_tag)
            for solid_id in solid_ids:
                gid_ids.append(volume_set_ids[solid_id])
                gid_values.append(solid_id)
            for solid_id in solid_ids:
                gid_ids.append(group_set_ids[solid_id])
                gid_values.append(solid_id)
            gid_ids.append(file_set_id)
            gid_values.append(-1)

            gid_group = tstt_tags.create_group("GLOBAL_ID")
            gid_group["type"] = np.dtype("i4")
            gid_group.attrs.create("class", 2, dtype=np.int32)
            gid_group.attrs.create("default", -1, dtype=gid_group["type"])
            gid_group.attrs.create("global", -1, dtype=gid_group["type"])
            gid_group.create_dataset("id_list", data=np.array(gid_ids, dtype=np.uint64))
            gid_group.create_dataset("values", data=np.array(gid_values, dtype=np.int32))

            # NAME
            name_ids = []
            name_values = []
            for i, solid_id in enumerate(solid_ids):
                mat_tag = material_tags[i] if i < len(material_tags) else f'mat_{i}'
                name_ids.append(group_set_ids[solid_id])
                name_values.append(f"mat:{mat_tag}")

            name_group = tstt_tags.create_group("NAME")
            name_group.attrs.create("class", 1, dtype=np.int32)
            name_group.create_dataset("id_list", data=np.array(name_ids, dtype=np.uint64))
            name_group["type"] = h5py.opaque_dtype(np.dtype("S32"))
            name_group.create_dataset("values", data=name_values, dtype=name_group["type"])

            # Empty standard tags
            for tag_name in ["DIRICHLET_SET", "MATERIAL_SET", "NEUMANN_SET"]:
                tag_grp = tstt_tags.create_group(tag_name)
                tag_grp["type"] = np.dtype("i4")
                tag_grp.attrs.create("class", 1, dtype=np.int32)
                tag_grp.attrs.create("default", -1, dtype=tag_grp["type"])
                tag_grp.attrs.create("global", -1, dtype=tag_grp["type"])

            # Sets
            sets_group = tstt.create_group("sets")

            contents = []
            list_rows = []
            parents_list = []
            children_list = []
            contents_end = -1
            children_end = -1
            parents_end = -1

            # Track triangle ranges per face
            tri_offset = 0
            face_triangle_ranges = {}
            for face_tag in sorted(all_faces.keys()):
                tris = all_faces[face_tag]
                face_triangle_ranges[face_tag] = (tri_offset, len(tris))
                tri_offset += len(tris)

            # Surface sets: contents = vertices + triangles for this face
            for face_tag in sorted(all_faces.keys()):
                verts = set()
                for tri in all_faces[face_tag]:
                    verts.update(tri)
                for v in sorted(verts):
                    contents.append(v + 1)
                tri_start, tri_count = face_triangle_ranges[face_tag]
                for i in range(tri_count):
                    contents.append(tri_start_id + tri_start + i)
                contents_end = len(contents) - 1

                vols = face_to_volumes[face_tag]
                for solid_id in vols:
                    parents_list.append(volume_set_ids[solid_id])
                parents_end = len(parents_list) - 1
                list_rows.append([contents_end, children_end, parents_end, 2])

            # Volume sets: children = surfaces
            for solid_id in solid_ids:
                faces_in_solid = list(triangles_by_vol_by_face[solid_id].keys())
                for face_tag in faces_in_solid:
                    children_list.append(surface_set_ids[face_tag])
                children_end = len(children_list) - 1
                list_rows.append([contents_end, children_end, parents_end, 2])

            # Group sets: contents = volume handle
            for solid_id in solid_ids:
                contents.append(volume_set_ids[solid_id])
                contents_end = len(contents) - 1
                list_rows.append([contents_end, children_end, parents_end, 2])

            # File set: range of all entities
            contents.extend([1, file_set_id - 1])
            contents_end = len(contents) - 1
            list_rows.append([contents_end, children_end, parents_end, 10])

            sets_group.create_dataset("contents", data=np.array(contents, dtype=np.uint64))
            sets_group.create_dataset("children", data=np.array(children_list, dtype=np.uint64))
            sets_group.create_dataset("parents", data=np.array(parents_list, dtype=np.uint64))
            lst = sets_group.create_dataset("list", data=np.array(list_rows, dtype=np.int64))
            sets_start_id = tri_start_id + num_triangles + 1
            lst.attrs.create("start_id", sets_start_id)

            # Set GLOBAL_ID tags on sets
            sets_tags = sets_group.create_group("tags")
            set_global_ids = []
            for face_tag in sorted(all_faces.keys()):
                set_global_ids.append(face_tag)
            for solid_id in solid_ids:
                set_global_ids.append(solid_id)
            for solid_id in solid_ids:
                set_global_ids.append(solid_id)
            set_global_ids.append(-1)
            sets_tags.create_dataset("GLOBAL_ID", data=np.array(set_global_ids, dtype=np.int32))

            tstt.attrs.create("max_id", np.uint64(current_id - 1))

        return True

    except Exception as e:
        return False
