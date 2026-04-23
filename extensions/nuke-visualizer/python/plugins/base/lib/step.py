"""
STEP/STP/BREP to VTK converter using Gmsh.

This module converts CAD files (STEP, STP, BREP) to VTK format using gmsh's
OpenCASCADE kernel. It generates a 2D surface mesh (suitable for visualization).
"""

import os
import sys
import tempfile
from pathlib import Path
from typing import Optional, Dict, Tuple
import hashlib


def convert_step_to_vtk(step_path: str, output_dir: str = None,
                        mesh_size_max: float = 10.0) -> str:
    """
    Convert a STEP/STP/BREP file to VTK using gmsh.

    Generates a 2D surface mesh that is suitable for interactive visualization
    in ParaView/Trame.

    Args:
        step_path: Path to the input STEP/STP/BREP file
        output_dir: Optional directory for output file. If None, uses temp cache dir.
        mesh_size_max: Maximum mesh element size (default 10.0)

    Returns:
        Path to the generated .vtk file
    """
    try:
        import gmsh
    except ImportError as e:
        raise ImportError(f"gmsh is required for STEP conversion: {e}")

    step_path = Path(step_path)
    if not step_path.exists():
        raise FileNotFoundError(f"CAD file not found: {step_path}")

    # Determine output path
    if output_dir is None:
        output_dir = step_path.parent
    else:
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)

    output_path = output_dir / f"{step_path.stem}.vtk"

    print(f"[STEP] Converting {step_path.name} to VTK...")

    gmsh.initialize()
    try:
        gmsh.option.setNumber("General.Terminal", 1)
        gmsh.option.setNumber("Mesh.Algorithm", 6)  # Frontal-Delaunay for 2D
        gmsh.option.setNumber("Mesh.MeshSizeMax", mesh_size_max)
        gmsh.option.setNumber("Mesh.MeshSizeMin", mesh_size_max * 0.05)
        gmsh.option.setNumber("Mesh.Optimize", 1)
        gmsh.option.setNumber("Mesh.QualityType", 2)

        # Load the STEP file
        gmsh.open(str(step_path))

        # Get model info
        entities = gmsh.model.getEntities()
        dim_tags = [e for e in entities if e[0] >= 1]  # curves, surfaces, volumes
        print(f"[STEP] Loaded {len(dim_tags)} entities from {step_path.name}")

        # Generate 2D surface mesh
        gmsh.model.mesh.generate(2)

        # Get mesh stats
        nodes = gmsh.model.mesh.getNodes()
        num_nodes = len(nodes[0])
        elems = gmsh.model.mesh.getElements()
        num_elems = sum(len(e) for e in elems[1]) if elems[1] else 0
        print(f"[STEP] Mesh: {num_nodes} nodes, {num_elems} elements")

        # Write VTK
        gmsh.write(str(output_path))
        print(f"[STEP] Created: {output_path}")

    finally:
        gmsh.finalize()

    return str(output_path)


def get_cache_path(step_path: str, cache_dir: str = None) -> Tuple[str, bool]:
    """
    Get the cached VTK path for a STEP file.

    Args:
        step_path: Path to the STEP file
        cache_dir: Optional cache directory. Uses system temp dir if None.

    Returns:
        Tuple of (cache_vtk_path, exists)
    """
    step_path = Path(step_path)

    if cache_dir is None:
        cache_dir = Path(tempfile.gettempdir()) / 'nuke-visualizer' / 'step'
    else:
        cache_dir = Path(cache_dir)

    cache_dir.mkdir(parents=True, exist_ok=True)

    # Compute hash based on file content (first 1MB) + modification time
    stat = step_path.stat()
    hash_input = f"{step_path.name}:{stat.st_size}:{stat.st_mtime}"
    file_hash = hashlib.md5(hash_input.encode()).hexdigest()[:12]

    cache_path = cache_dir / f"{step_path.stem}_{file_hash}.vtk"

    return str(cache_path), cache_path.exists()


def convert_step_to_vtk_cached(step_path: str, use_cache: bool = True,
                               cache_dir: str = None,
                               mesh_size_max: float = 10.0) -> Dict:
    """
    Convert STEP/STP/BREP to VTK with caching.

    Args:
        step_path: Path to the CAD file
        use_cache: Whether to use caching (default True)
        cache_dir: Optional cache directory
        mesh_size_max: Maximum mesh element size

    Returns:
        Dict with 'vtk_path', 'from_cache', 'num_nodes', 'num_elements'
    """
    step_path = Path(step_path)

    result = {
        'vtk_path': None,
        'from_cache': False,
        'num_nodes': 0,
        'num_elements': 0
    }

    # Check cache first
    if use_cache:
        cache_path, exists = get_cache_path(str(step_path), cache_dir)
        if exists:
            print(f"[STEP] Using cached VTK: {cache_path}")
            result['vtk_path'] = cache_path
            result['from_cache'] = True
            return result
    else:
        cache_path = None

    # Convert STEP to VTK
    if cache_path:
        vtk_path = convert_step_to_vtk(str(step_path), output_dir=Path(cache_path).parent,
                                       mesh_size_max=mesh_size_max)
        # Move/rename to cache path if different
        if Path(vtk_path) != Path(cache_path):
            import shutil
            shutil.move(vtk_path, cache_path)
            result['vtk_path'] = cache_path
        else:
            result['vtk_path'] = vtk_path
    else:
        result['vtk_path'] = convert_step_to_vtk(str(step_path), mesh_size_max=mesh_size_max)

    # Count mesh stats from output
    try:
        import vtk as vtk_module
        reader = vtk_module.vtkUnstructuredGridReader()
        reader.SetFileName(result['vtk_path'])
        reader.Update()
        mesh = reader.GetOutput()
        result['num_nodes'] = mesh.GetNumberOfPoints()
        result['num_elements'] = mesh.GetNumberOfCells()
    except Exception:
        pass

    return result
