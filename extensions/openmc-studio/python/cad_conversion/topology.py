"""Topological analysis and post-processing for CAD assemblies."""

import math
from typing import List, Dict, Tuple, Any, Optional, Set

from .core import SurfaceFitResult, TopologyInfo
from . import gmsh_utils

try:
    import numpy as np
    HAS_NUMPY = True
except ImportError:
    HAS_NUMPY = False
    np = None  # type: ignore


def analyze_assembly(file_path: str) -> TopologyInfo:
    """Analyze topological relationships in a CAD assembly.

    Builds adjacency graph and detects shared faces between solids.
    """
    info = TopologyInfo(
        solid_count=0,
        face_count=0,
        edge_count=0,
        vertex_count=0,
    )

    if not gmsh_utils.HAS_GMSH:
        return info

    gmsh_utils.gmsh.initialize()
    gmsh_utils.gmsh.option.setNumber("General.Terminal", 0)
    try:
        gmsh_utils.gmsh.open(file_path)
        entities = gmsh_utils.get_all_entities()
        solids = [e for e in entities if e[0] == 3]
        faces = [e for e in entities if e[0] == 2]
        edges = [e for e in entities if e[0] == 1]
        vertices = [e for e in entities if e[0] == 0]

        info.solid_count = len(solids)
        info.face_count = len(faces)
        info.edge_count = len(edges)
        info.vertex_count = len(vertices)

        # Build solid -> face mapping
        solid_faces: Dict[int, Set[int]] = {}
        for dim, tag in solids:
            boundary = gmsh_utils.get_boundary((dim, tag), oriented=False, recursive=False)
            solid_faces[tag] = set(abs(t) for d, t in boundary if d == 2)

        # Detect shared faces -> adjacency
        solid_tags = list(solid_faces.keys())
        for i in range(len(solid_tags)):
            for j in range(i + 1, len(solid_tags)):
                s1, s2 = solid_tags[i], solid_tags[j]
                shared = solid_faces[s1] & solid_faces[s2]
                if shared:
                    if s1 not in info.adjacency:
                        info.adjacency[s1] = []
                    if s2 not in info.adjacency:
                        info.adjacency[s2] = []
                    info.adjacency[s1].append(s2)
                    info.adjacency[s2].append(s1)
                    info.shared_faces[(s1, s2)] = list(shared)

    except Exception:
        pass
    finally:
        gmsh_utils.gmsh.finalize()

    return info


def merge_coplanar_surfaces(surfaces: List[Dict[str, Any]],
                            tolerance: float = 0.001) -> List[Dict[str, Any]]:
    """Post-process a list of OpenMC surfaces to deduplicate coincident planes.

    For now this only merges exact duplicate planes.  Future enhancement:
    merge cylinders, spheres, etc. that are geometrically identical.

    Args:
        surfaces: List of surface dicts with 'type', 'coefficients', 'id', 'name'.
        tolerance: Geometric tolerance for coincidence.

    Returns:
        Deduplicated surface list with a '_merged_ids' field on merged entries.
    """
    if not surfaces:
        return []

    merged: List[Dict[str, Any]] = []
    skip_indices: Set[int] = set()

    for i, s1 in enumerate(surfaces):
        if i in skip_indices:
            continue
        if s1.get('type') != 'plane':
            merged.append(s1)
            continue

        coeffs1 = s1.get('coefficients', [])
        if len(coeffs1) < 4:
            merged.append(s1)
            continue

        # Normalize plane coefficients for comparison
        n1 = normalize_plane(coeffs1)
        merged_ids = [s1['id']]

        for j in range(i + 1, len(surfaces)):
            if j in skip_indices:
                continue
            s2 = surfaces[j]
            if s2.get('type') != 'plane':
                continue
            coeffs2 = s2.get('coefficients', [])
            if len(coeffs2) < 4:
                continue

            n2 = normalize_plane(coeffs2)
            # Check if normals are parallel and d-values are close
            dot = sum(n1[k] * n2[k] for k in range(3))
            if abs(abs(dot) - 1.0) < 0.01 and abs(n1[3] - n2[3]) < tolerance:
                # Same plane (possibly opposite orientation)
                merged_ids.append(s2['id'])
                skip_indices.add(j)

        if len(merged_ids) > 1:
            s1_copy = dict(s1)
            s1_copy['_merged_ids'] = merged_ids
            merged.append(s1_copy)
        else:
            merged.append(s1)

    return merged


def normalize_plane(coeffs: List[float]) -> List[float]:
    """Normalize plane coefficients [a, b, c, d] so that sqrt(a^2+b^2+c^2)=1 and a>=0.

    Returns [a, b, c, d].
    """
    if len(coeffs) < 4:
        return coeffs
    a, b, c, d = coeffs[0], coeffs[1], coeffs[2], coeffs[3]
    norm = math.sqrt(a*a + b*b + c*c)
    if norm < 1e-10:
        return [0.0, 0.0, 1.0, d]
    a, b, c, d = a/norm, b/norm, c/norm, d/norm
    # Ensure consistent orientation: make largest positive component positive
    if a < -1e-6 or (abs(a) < 1e-6 and b < -1e-6) or (abs(a) < 1e-6 and abs(b) < 1e-6 and c < -1e-6):
        a, b, c, d = -a, -b, -c, -d
    return [a, b, c, d]


def detect_boolean_ops(solid1_bounds: Dict[str, Any],
                       solid2_bounds: Dict[str, Any]) -> Optional[str]:
    """Heuristic detection of boolean operation between two solids.

    Compares bounding boxes to guess union / intersection / difference.
    This is a placeholder; robust detection requires volume intersection tests.

    Args:
        solid1_bounds: {'min': [x,y,z], 'max': [x,y,z]}
        solid2_bounds: {'min': [x,y,z], 'max': [x,y,z]}

    Returns:
        'union', 'intersection', 'difference', or None.
    """
    b1 = solid1_bounds
    b2 = solid2_bounds

    # Check for overlap
    overlap = True
    for i in range(3):
        if b1['max'][i] < b2['min'][i] or b2['max'][i] < b1['min'][i]:
            overlap = False
            break

    if not overlap:
        return 'union'  # Disjoint solids likely form a union

    # If one is almost completely inside the other, likely difference
    def inside(inner, outer):
        for i in range(3):
            if inner['min'][i] < outer['min'][i] - 1e-3 or inner['max'][i] > outer['max'][i] + 1e-3:
                return False
        return True

    if inside(b1, b2):
        return 'difference'
    if inside(b2, b1):
        return 'difference'

    # Partial overlap
    return 'intersection'
