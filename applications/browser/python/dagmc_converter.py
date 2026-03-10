#!/usr/bin/env python3
"""
DAGMC to VTK converter for NukeIDE trame integration.

REQUIREMENTS:
    - MOAB (Mesh-Oriented datABase) with Python bindings: pymoab
      Install: conda install -c conda-forge moab

NOTE: cad-to-dagmc is for CREATING DAGMC files, not reading them.
For reading/converting .h5m files, we need MOAB/pymoab.
"""

import sys
import os
import subprocess
from pathlib import Path


def convert_h5m_to_vtk(h5m_path: str, output_dir: str = None) -> str:
    """
    Convert .h5m file to VTK format using MOAB/pymoab.
    Returns path to converted VTK file.
    """
    h5m_path = Path(h5m_path)
    
    if not h5m_path.exists():
        raise FileNotFoundError(f"DAGMC file not found: {h5m_path}")
    
    if output_dir is None:
        output_dir = h5m_path.parent
    else:
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
    
    output_path = output_dir / f"{h5m_path.stem}.vtk"
    
    # Try conversion methods in order of preference
    
    # Method 1: Using pymoab (Python API for MOAB)
    try:
        from pymoab import core
        
        print(f"Converting {h5m_path} to VTK using pymoab...")
        mb = core.Core()
        mb.load_file(str(h5m_path))
        mb.write_file(str(output_path))
        print(f"Converted successfully: {output_path}")
        return str(output_path)
        
    except ImportError:
        print("pymoab not available, trying mbconvert...")
    
    # Method 2: Using mbconvert CLI (requires MOAB installation)
    try:
        result = subprocess.run(
            ['mbconvert', str(h5m_path), str(output_path)],
            check=True, 
            capture_output=True,
            text=True
        )
        print(f"Converted using mbconvert: {output_path}")
        return str(output_path)
        
    except FileNotFoundError:
        print("mbconvert not found in PATH")
    except subprocess.CalledProcessError as e:
        print(f"mbconvert failed: {e.stderr}")
    
    # Method 3: Create placeholder VTK file
    print(f"Warning: No DAGMC converter available. Creating placeholder VTK.")
    create_placeholder_vtk(output_path)
    return str(output_path)


def create_placeholder_vtk(output_path: Path):
    """Create a simple VTK file when conversion tools are unavailable."""
    vtk_content = """# vtk DataFile Version 3.0
Placeholder for DAGMC visualization - Conversion tools not available
ASCII
DATASET POLYDATA
POINTS 8 float
0 0 0  1 0 0  1 1 0  0 1 0
0 0 1  1 0 1  1 1 1  0 1 1
POLYGONS 6 30
4 0 1 2 3
4 4 5 6 7
4 0 1 5 4
4 2 3 7 6
4 0 3 7 4
4 1 2 6 5
"""
    with open(output_path, 'w') as f:
        f.write(vtk_content)
    print(f"Placeholder VTK created: {output_path}")


def check_converter_available() -> tuple[bool, str]:
    """
    Check if any DAGMC converter is available.
    Returns (is_available, message)
    """
    try:
        from pymoab import core
        return True, "pymoab available"
    except ImportError:
        pass
    
    try:
        subprocess.run(['mbconvert', '--help'], check=True, capture_output=True)
        return True, "mbconvert available"
    except FileNotFoundError:
        pass
    
    return False, "No DAGMC converter found. Install MOAB: conda install -c conda-forge moab"


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python dagmc_converter.py <h5m_file> [output_dir]")
        print("\nChecking converter availability:")
        available, msg = check_converter_available()
        print(f"  {msg}")
        sys.exit(1 if not available else 0)
    
    h5m_file = sys.argv[1]
    output_dir = sys.argv[2] if len(sys.argv) > 2 else None
    
    try:
        vtk_file = convert_h5m_to_vtk(h5m_file, output_dir)
        print(f"\nConversion complete: {vtk_file}")
    except Exception as e:
        print(f"\nConversion failed: {e}")
        sys.exit(1)
