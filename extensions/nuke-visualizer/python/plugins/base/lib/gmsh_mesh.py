"""Gmsh ``.msh`` mesh to VTK converter.

Imports an existing Gmsh mesh through the gmsh Python API and writes a
legacy ASCII ``.vtk`` file for the native three.js viewer. The mesh is never
regenerated or re-meshed: whatever the file already contains is exported.

Heavy dependencies (``gmsh``) are imported lazily inside :func:`_load_gmsh`
so a missing optional dependency surfaces as a clean
:class:`GmshMeshError` instead of a traceback; command handlers convert
these to the single-JSON-object contract. gmsh runtime errors (e.g. an
unparseable file) still propagate unwrapped so the gmsh context is kept,
and gmsh is always finalized.
"""

import hashlib
import os
import shutil
import tempfile
from pathlib import Path


class GmshMeshError(Exception):
    """Raised for all Gmsh mesh converter failures (bad input, missing file,
    missing optional dependency, or a file with no mesh elements)."""


try:
    import importlib.util as _importlib_util

    HAS_GMSH = _importlib_util.find_spec("gmsh") is not None
except Exception:  # pragma: no cover - importlib is always available
    HAS_GMSH = False


def _load_gmsh():
    """Lazily import ``gmsh`` and return the module.

    Raises :class:`GmshMeshError` when gmsh is not installed so command
    handlers can report a clean JSON error instead of a traceback.
    """
    if not HAS_GMSH:
        raise GmshMeshError("gmsh is required for Gmsh mesh conversion (not installed)")
    try:
        import gmsh
    except ImportError as exc:
        raise GmshMeshError(f"gmsh is required for Gmsh mesh conversion: {exc}") from None
    return gmsh


def _require_msh_path(msh_path) -> Path:
    """Validate a Gmsh mesh input path.

    Input: ``msh_path`` (path to the ``.msh`` file). Output: the path as a
    :class:`pathlib.Path`. Raises :class:`GmshMeshError` for an empty/invalid
    path or a missing file.
    """
    if not msh_path or not isinstance(msh_path, (str, os.PathLike)):
        raise GmshMeshError(f"invalid Gmsh mesh file path: {msh_path!r}")
    path = Path(msh_path)
    if not path.is_file():
        raise GmshMeshError(f"Gmsh mesh file not found: {path}")
    return path


def _mesh_stats(gmsh) -> tuple[int, int]:
    """Return ``(num_nodes, num_elements)`` for the currently open mesh."""
    nodes = gmsh.model.mesh.getNodes()
    num_nodes = len(nodes[0]) if nodes and nodes[0] is not None else 0
    elements = gmsh.model.mesh.getElements()
    groups = elements[1] if len(elements) > 1 and elements[1] else []
    num_elements = sum(len(group) for group in groups)
    return num_nodes, num_elements


def convert_gmsh_to_vtk(msh_path: str, output_dir: str = None) -> dict:
    """Convert an existing Gmsh ``.msh`` mesh to legacy ASCII VTK.

    The mesh is imported with ``gmsh.open`` and written as-is; no meshing
    step runs. ``Mesh.Binary`` is forced to 0 so the VTK output is ASCII and
    readable by the native viewer.

    Inputs: ``msh_path`` (path to the ``.msh`` file), optional
    ``output_dir`` (destination directory, default: beside the input).
    Output: dict with ``vtk_path``, ``num_nodes`` and ``num_elements``.
    Raises :class:`GmshMeshError` for a bad path, a missing file, missing
    gmsh, or a file that contains no mesh elements.
    """
    msh_path = _require_msh_path(msh_path)
    gmsh = _load_gmsh()

    if output_dir is None:
        output_dir = msh_path.parent
    else:
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)

    output_path = output_dir / f"{msh_path.stem}.vtk"

    print(f"[Gmsh] Converting {msh_path.name} to VTK...")

    gmsh.initialize()
    try:
        gmsh.option.setNumber("Mesh.Binary", 0)
        gmsh.open(str(msh_path))

        num_nodes, num_elements = _mesh_stats(gmsh)
        if num_elements == 0:
            raise GmshMeshError(f"Gmsh mesh has no elements: {msh_path}")
        print(f"[Gmsh] Mesh: {num_nodes} nodes, {num_elements} elements")

        gmsh.write(str(output_path))
        print(f"[Gmsh] Created: {output_path}")
    finally:
        gmsh.finalize()

    return {"vtk_path": str(output_path), "num_nodes": num_nodes, "num_elements": num_elements}


def get_cache_path(msh_path: str, cache_dir: str = None) -> tuple[str, bool]:
    """Get the cached VTK path for a Gmsh ``.msh`` file.

    Inputs: ``msh_path`` (path to the ``.msh`` file), optional ``cache_dir``
    (defaults to a ``nuke-visualizer/gmsh`` directory in the system temp
    dir). Output: tuple of ``(cache_vtk_path, exists)``. The cache key
    includes the file name, size, and modification time.
    Raises :class:`GmshMeshError` for a bad path or a missing file.
    """
    msh_path = _require_msh_path(msh_path)

    if cache_dir is None:
        cache_dir = Path(tempfile.gettempdir()) / "nuke-visualizer" / "gmsh"
    else:
        cache_dir = Path(cache_dir)

    cache_dir.mkdir(parents=True, exist_ok=True)

    # Compute hash based on file name + size + modification time
    stat = msh_path.stat()
    hash_input = f"{msh_path.name}:{stat.st_size}:{stat.st_mtime}"
    file_hash = hashlib.md5(hash_input.encode()).hexdigest()[:12]

    cache_path = cache_dir / f"{msh_path.stem}_{file_hash}.vtk"

    return str(cache_path), cache_path.exists()


def convert_gmsh_to_vtk_cached(
    msh_path: str, use_cache: bool = True, cache_dir: str = None
) -> dict:
    """Convert a Gmsh ``.msh`` mesh to VTK with caching.

    Inputs: ``msh_path`` (path to the ``.msh`` file), ``use_cache`` (default
    True), optional ``cache_dir`` (defaults to a temp cache directory).
    Output: dict with ``vtk_path``, ``from_cache``, ``num_nodes`` and
    ``num_elements``. The node/element stats on a cache hit are best-effort
    and stay 0 because the cached file is not re-read.
    Raises :class:`GmshMeshError` for a bad path, a missing file, or missing
    gmsh.
    """
    msh_path = _require_msh_path(msh_path)

    result = {"vtk_path": None, "from_cache": False, "num_nodes": 0, "num_elements": 0}

    # Check cache first
    if use_cache:
        cache_path, exists = get_cache_path(str(msh_path), cache_dir)
        if exists:
            print(f"[Gmsh] Using cached VTK: {cache_path}")
            result["vtk_path"] = cache_path
            result["from_cache"] = True
            return result
    else:
        cache_path = None

    # Convert the Gmsh mesh to VTK
    conv = convert_gmsh_to_vtk(
        str(msh_path),
        output_dir=Path(cache_path).parent if cache_path else None,
    )

    vtk_path = conv["vtk_path"]
    result["num_nodes"] = conv["num_nodes"]
    result["num_elements"] = conv["num_elements"]

    # Move/rename to cache path if different
    if cache_path and Path(vtk_path) != Path(cache_path):
        shutil.move(vtk_path, cache_path)
        result["vtk_path"] = cache_path
    else:
        result["vtk_path"] = vtk_path

    return result
