"""STEP/STP/BREP to VTK converters using gmsh.

Each converter turns a CAD file (STEP, STP, BREP) into a VTK surface mesh
via gmsh's OpenCASCADE kernel: a 2D surface mesh suitable for rendering
directly in a client-side viewer (no trame/ParaView server).

Heavy dependencies (``gmsh``, ``vtk``) are imported lazily inside
:func:`_load_gmsh` / :func:`_load_vtk` so a missing optional dependency
surfaces as a clean :class:`StepError` instead of a traceback; command
handlers convert these to the single-JSON-object contract. Mesh-size
limits (``mesh_size_max``) are preserved.

All public functions raise :class:`StepError` with a human-readable
message on validation/dependency failure. gmsh runtime errors (e.g. an
unparseable file) still propagate unwrapped so the gmsh context is kept,
and gmsh is always finalized. Returned dict shapes are unchanged.
"""

import hashlib
import multiprocessing
import os
import tempfile
from pathlib import Path


class StepError(Exception):
    """Raised for all STEP converter failures (bad input, missing file,
    missing optional dependency)."""


try:
    import importlib.util as _importlib_util

    HAS_GMSH = _importlib_util.find_spec("gmsh") is not None
    HAS_VTK = _importlib_util.find_spec("vtk") is not None
except Exception:  # pragma: no cover - importlib is always available
    HAS_GMSH = False
    HAS_VTK = False


def _load_gmsh():
    """Lazily import ``gmsh`` and return the module.

    Raises :class:`StepError` when gmsh is not installed so command
    handlers can report a clean JSON error instead of a traceback.
    """
    if not HAS_GMSH:
        raise StepError("gmsh is required for STEP conversion (not installed)")
    try:
        import gmsh
    except ImportError as exc:
        raise StepError(f"gmsh is required for STEP conversion: {exc}") from None
    return gmsh


def _load_vtk():
    """Lazily import ``vtk`` and return the module.

    Raises :class:`StepError` when vtk is not installed so command
    handlers can report a clean JSON error instead of a traceback.
    """
    if not HAS_VTK:
        raise StepError("vtk not installed (required for STEP cache stats)")
    try:
        import vtk
    except ImportError as exc:
        raise StepError(f"vtk not installed (required for STEP cache stats): {exc}") from None
    return vtk


def _require_step_path(step_path) -> Path:
    """Validate a CAD input path.

    Input: ``step_path`` (path to the STEP/STP/BREP file). Output: the
    path as a :class:`pathlib.Path`. Raises :class:`StepError` for an
    empty/invalid path or a missing file.
    """
    if not step_path or not isinstance(step_path, (str, os.PathLike)):
        raise StepError(f"invalid CAD file path: {step_path!r}")
    path = Path(step_path)
    if not path.is_file():
        raise StepError(f"CAD file not found: {path}")
    return path


def _require_mesh_size(mesh_size_max) -> float:
    """Validate the maximum mesh element size.

    Input: ``mesh_size_max`` (int/float element size). Output: the size as
    a ``float``. Raises :class:`StepError` for non-numeric or
    non-positive values.
    """
    if isinstance(mesh_size_max, bool):
        raise StepError(f"mesh_size_max must be a positive number, got {mesh_size_max!r}")
    try:
        size = float(mesh_size_max)
    except (TypeError, ValueError):
        raise StepError(f"mesh_size_max must be a positive number, got {mesh_size_max!r}") from None
    if not size > 0:
        raise StepError(f"mesh_size_max must be a positive number, got {mesh_size_max!r}")
    return size


def convert_step_to_vtk(
    step_path: str, output_dir: str = None, mesh_size_max: float = 10.0
) -> dict:
    """Convert a STEP/STP/BREP file to VTK using gmsh.

    Generates a 2D surface mesh that is suitable for interactive
    visualization in a client-side viewer.

    Inputs: ``step_path`` (path to the STEP/STP/BREP file), optional
    ``output_dir`` (destination directory, default: beside the input),
    ``mesh_size_max`` (maximum mesh element size, default 10.0).
    Output: dict with ``vtk_path``, ``num_nodes`` and ``num_elements``.
    Raises :class:`StepError` for a bad path, a missing file, an invalid
    mesh size, or missing gmsh.
    """
    step_path = _require_step_path(step_path)
    mesh_size_max = _require_mesh_size(mesh_size_max)
    gmsh = _load_gmsh()

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
        gmsh.option.setNumber("General.NumThreads", multiprocessing.cpu_count())

        # Load the STEP file
        gmsh.open(str(step_path))

        # Get model info
        entities = gmsh.model.getEntities()
        dim_tags = [e for e in entities if e[0] >= 1]  # curves, surfaces, volumes
        print(f"[STEP] Loaded {len(dim_tags)} entities from {step_path.name}")

        # Generate 2D surface mesh
        gmsh.model.mesh.generate(2)

        # Get mesh stats before clearing
        nodes = gmsh.model.mesh.getNodes()
        num_nodes = len(nodes[0])
        elems = gmsh.model.mesh.getElements()
        num_elems = sum(len(e) for e in elems[1]) if elems[1] else 0
        print(f"[STEP] Mesh: {num_nodes} nodes, {num_elems} elements")

        # Write VTK
        gmsh.write(str(output_path))
        print(f"[STEP] Created: {output_path}")

        # Clear mesh from gmsh memory immediately
        gmsh.model.mesh.clear()

    finally:
        gmsh.finalize()

    return {"vtk_path": str(output_path), "num_nodes": num_nodes, "num_elements": num_elems}


def get_cache_path(step_path: str, cache_dir: str = None) -> tuple[str, bool]:
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
        cache_dir = Path(tempfile.gettempdir()) / "nuke-visualizer" / "step"
    else:
        cache_dir = Path(cache_dir)

    cache_dir.mkdir(parents=True, exist_ok=True)

    # Compute hash based on file name + size + modification time
    stat = step_path.stat()
    hash_input = f"{step_path.name}:{stat.st_size}:{stat.st_mtime}"
    file_hash = hashlib.md5(hash_input.encode()).hexdigest()[:12]

    cache_path = cache_dir / f"{step_path.stem}_{file_hash}.vtk"

    return str(cache_path), cache_path.exists()


def convert_step_to_vtk_cached(
    step_path: str, use_cache: bool = True, cache_dir: str = None, mesh_size_max: float = 10.0
) -> dict:
    """Convert STEP/STP/BREP to VTK with caching.

    Inputs: ``step_path`` (path to the CAD file), ``use_cache`` (default
    True), optional ``cache_dir``, ``mesh_size_max`` (maximum mesh element
    size, default 10.0; validated before any cache lookup so bad values
    fail fast even on a cache hit).
    Output: dict with ``vtk_path``, ``from_cache``, ``num_nodes`` and
    ``num_elements``. The node/element stats on a cache hit are
    best-effort (they stay 0 when vtk is unavailable).
    Raises :class:`StepError` for a bad path, a missing file, an invalid
    mesh size, or missing gmsh.
    """
    step_path = _require_step_path(step_path)
    mesh_size_max = _require_mesh_size(mesh_size_max)

    result = {"vtk_path": None, "from_cache": False, "num_nodes": 0, "num_elements": 0}

    # Check cache first
    if use_cache:
        cache_path, exists = get_cache_path(str(step_path), cache_dir)
        if exists:
            print(f"[STEP] Using cached VTK: {cache_path}")
            result["vtk_path"] = cache_path
            result["from_cache"] = True
            # Count nodes/elements from cached file using VTK (only when needed)
            try:
                import vtk as vtk_module

                reader = vtk_module.vtkUnstructuredGridReader()
                reader.SetFileName(cache_path)
                reader.Update()
                mesh = reader.GetOutput()
                result["num_nodes"] = mesh.GetNumberOfPoints()
                result["num_elements"] = mesh.GetNumberOfCells()
            except Exception:
                pass
            return result
    else:
        cache_path = None

    # Convert STEP to VTK
    conv = convert_step_to_vtk(
        str(step_path),
        output_dir=Path(cache_path).parent if cache_path else None,
        mesh_size_max=mesh_size_max,
    )

    vtk_path = conv["vtk_path"]
    result["num_nodes"] = conv["num_nodes"]
    result["num_elements"] = conv["num_elements"]

    # Move/rename to cache path if different
    if cache_path and Path(vtk_path) != Path(cache_path):
        import shutil

        shutil.move(vtk_path, cache_path)
        result["vtk_path"] = cache_path
    else:
        result["vtk_path"] = vtk_path

    return result
