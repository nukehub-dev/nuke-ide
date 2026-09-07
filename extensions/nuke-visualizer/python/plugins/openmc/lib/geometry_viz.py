#!/usr/bin/env python3
"""
OpenMC CSG geometry parsing and headless mesh extraction for NukeIDE.

Parses ``geometry.xml`` into Surface/Cell dataclasses
(:class:`OpenMCGeometryVisualizer`) and converts cells to numpy-only mesh
JSON for the native three.js client — no trame/ParaView server.
"""

import xml.etree.ElementTree as ET
from dataclasses import dataclass

import numpy as np


@dataclass
class Surface:
    """Represents an OpenMC surface for visualization."""

    id: int
    type: str
    coefficients: list[float]
    boundary: str = "transmission"


@dataclass
class Cell:
    """Represents an OpenMC cell for visualization."""

    id: int
    region: str
    surfaces: dict[int, bool]  # surface_id -> is_complemented
    universe: int = 0
    name: str = ""
    material: str = ""  # Material ID or name


class OpenMCGeometryVisualizer:
    """Parses OpenMC CSG geometry XML into surfaces, cells, and bounds."""

    def __init__(self):
        self.surfaces: dict[int, Surface] = {}
        self.cells: dict[int, Cell] = {}
        self.bounds = {"xmin": -10, "xmax": 10, "ymin": -10, "ymax": 10, "zmin": -10, "zmax": 10}

    def parse_geometry(self, file_path: str) -> bool:
        """Parse OpenMC geometry.xml file."""
        try:
            tree = ET.parse(file_path)
            root = tree.getroot()

            # Parse surfaces
            for surf_elem in root.findall("surface"):
                self._parse_surface(surf_elem)

            # Parse cells
            for cell_elem in root.findall("cell"):
                self._parse_cell(cell_elem)

            # Calculate bounds from surfaces
            self._calculate_bounds()

            return True
        except Exception as e:
            print(f"Error parsing geometry: {e}")
            return False

    def _parse_surface(self, elem: ET.Element) -> None:
        """Parse a surface element."""
        surf_id = int(elem.get("id"))
        surf_type = elem.get("type", "unknown").lower()

        coeffs = []
        coeffs_attr = elem.get("coeffs", "")
        if coeffs_attr:
            coeffs = [float(x) for x in coeffs_attr.split()]

        boundary = elem.get("boundary", "transmission")

        self.surfaces[surf_id] = Surface(
            id=surf_id, type=surf_type, coefficients=coeffs, boundary=boundary
        )

    def _parse_cell(self, elem: ET.Element) -> None:
        """Parse a cell element."""
        cell_id = int(elem.get("id"))
        region = elem.get("region", "")
        universe = int(elem.get("universe", "0"))
        name = elem.get("name", "")
        material = elem.get("material", "")

        # Parse region to extract surface references
        surfaces = self._parse_region(region)

        self.cells[cell_id] = Cell(
            id=cell_id,
            region=region,
            surfaces=surfaces,
            universe=universe,
            name=name,
            material=material,
        )

    def _parse_region(self, region: str) -> dict[int, bool]:
        """Parse region string to get surface references."""
        surfaces = {}
        if not region:
            return surfaces

        # Tokenize region
        tokens = (
            region.replace("(", " ( ")
            .replace(")", " ) ")
            .replace("|", " | ")
            .replace("&", " & ")
            .split()
        )

        for token in tokens:
            if not token or token in ("(", ")", "|", "&"):
                continue

            # Check for complement operator
            is_complement = False
            if token.startswith("~"):
                is_complement = True
                token = token[1:]

            # Check for negative surface (inside)
            if token.startswith("-"):
                is_complement = True
                token = token[1:]
            elif token.startswith("+"):
                token = token[1:]

            try:
                surf_id = int(token)
                surfaces[surf_id] = is_complement
            except ValueError:
                pass

        return surfaces

    def _calculate_bounds(self) -> None:
        """Calculate geometry bounds from surfaces."""
        if not self.surfaces:
            return

        xvals, yvals, zvals = [], [], []

        for surf in self.surfaces.values():
            coeffs = surf.coefficients

            if surf.type == "x-plane" and len(coeffs) >= 1:
                xvals.append(coeffs[0])
            elif surf.type == "y-plane" and len(coeffs) >= 1:
                yvals.append(coeffs[0])
            elif surf.type == "z-plane" and len(coeffs) >= 1:
                zvals.append(coeffs[0])
            elif surf.type in ("z-cylinder", "cylinder") and len(coeffs) >= 3:
                cx, cy, r = coeffs[0], coeffs[1], coeffs[2]
                xvals.extend([cx - r, cx + r])
                yvals.extend([cy - r, cy + r])
            elif surf.type == "sphere" and len(coeffs) >= 4:
                cx, cy, cz, r = coeffs[0], coeffs[1], coeffs[2], coeffs[3]
                xvals.extend([cx - r, cx + r])
                yvals.extend([cy - r, cy + r])
                zvals.extend([cz - r, cz + r])

        if xvals:
            self.bounds["xmin"] = min(xvals) - 0.1
            self.bounds["xmax"] = max(xvals) + 0.1
        if yvals:
            self.bounds["ymin"] = min(yvals) - 0.1
            self.bounds["ymax"] = max(yvals) + 0.1
        if zvals:
            self.bounds["zmin"] = min(zvals) - 0.1
            self.bounds["zmax"] = max(zvals) + 0.1


# ---------------------------------------------------------------------------
# Headless CSG -> mesh JSON extractors.
#
# These functions extract OpenMC CSG geometry as JSON-safe meshes for a
# native three.js client WITHOUT starting a trame/ParaView server.
#
# Mesh construction is numpy-only (unit-testable without vtk/openmc);
# ``openmc`` is imported lazily and only by extract_csg_from_openmc_model.
# Errors raise GeometryExtractorError; command wrappers convert these to the
# single-JSON-object contract.
# ---------------------------------------------------------------------------


class GeometryExtractorError(Exception):
    """Raised for all headless CSG extractor failures (bad input, missing
    file, missing optional dependency, unparseable XML)."""


_DEFAULT_SEGMENTS = 16
_MIN_SEGMENTS = 3
_MAX_SEGMENTS = 64


def _require_segments(value) -> int:
    """Validate a tessellation segment budget.

    Input: ``value`` (int, segments per curved surface). Output: the value
    as an ``int``. Raises :class:`GeometryExtractorError` for non-integer
    values or values outside ``[_MIN_SEGMENTS, _MAX_SEGMENTS]``.
    """
    if isinstance(value, bool):
        raise GeometryExtractorError(f"segments must be an integer, got {value!r}")
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise GeometryExtractorError(f"segments must be an integer, got {value!r}") from None
    if isinstance(value, float) and value != number:
        raise GeometryExtractorError(f"segments must be an integer, got {value!r}")
    if number < _MIN_SEGMENTS or number > _MAX_SEGMENTS:
        raise GeometryExtractorError(
            f"segments must be between {_MIN_SEGMENTS} and {_MAX_SEGMENTS}, got {value!r}"
        )
    return number


def _require_geometry_xml_path(path) -> str:
    """Validate a CSG geometry XML input path.

    Input: ``path`` (path to ``geometry.xml``). Output: the path string.
    Raises :class:`GeometryExtractorError` for an empty/invalid path, a
    missing file, or a non-``.xml`` suffix.
    """
    import os

    if not path or not isinstance(path, (str, os.PathLike)):
        raise GeometryExtractorError(f"invalid geometry file path: {path!r}")
    path_str = os.fspath(path)
    if not os.path.isfile(path_str):
        raise GeometryExtractorError(f"geometry file not found: {path_str}")
    if not path_str.lower().endswith(".xml"):
        raise GeometryExtractorError(f"expected a geometry.xml file, got: {path_str}")
    return path_str


def _load_openmc():
    """Lazily import ``openmc`` and return the module.

    Raises :class:`GeometryExtractorError` when openmc is not installed so
    command handlers can report a clean JSON error instead of a traceback.
    """
    import sys

    existing = sys.modules.get("openmc")
    if existing is not None:
        return existing
    try:
        import importlib.util as _importlib_util
    except ImportError as exc:
        raise GeometryExtractorError(f"openmc not installed (required): {exc}") from None
    if _importlib_util.find_spec("openmc") is None:
        raise GeometryExtractorError("openmc not installed (required for model extraction)")
    try:
        import openmc
    except ImportError as exc:
        raise GeometryExtractorError(f"openmc not installed (required): {exc}") from None
    return openmc


def _box_corners(bounds: dict) -> "np.ndarray":
    """Return the 8 corner vertices of an axis-aligned bounding box."""
    xmin, xmax = bounds["xmin"], bounds["xmax"]
    ymin, ymax = bounds["ymin"], bounds["ymax"]
    zmin, zmax = bounds["zmin"], bounds["zmax"]
    return np.array(
        [
            [xmin, ymin, zmin],
            [xmax, ymin, zmin],
            [xmax, ymax, zmin],
            [xmin, ymax, zmin],
            [xmin, ymin, zmax],
            [xmax, ymin, zmax],
            [xmax, ymax, zmax],
            [xmin, ymax, zmax],
        ],
        dtype=float,
    )


_BOX_INDICES = [
    [0, 1, 2],
    [0, 2, 3],
    [4, 6, 5],
    [4, 7, 6],
    [0, 4, 5],
    [0, 5, 1],
    [1, 5, 6],
    [1, 6, 2],
    [2, 6, 7],
    [2, 7, 3],
    [3, 7, 4],
    [3, 4, 0],
]


def _box_mesh(bounds: dict) -> tuple[str, "np.ndarray", "np.ndarray"]:
    """Build a box mesh (8 corners, 12 triangles) from a bounds dict."""
    return ("box", _box_corners(bounds), np.array(_BOX_INDICES, dtype=np.int64))


def _cylinder_mesh(
    center: tuple[float, float], lo: float, hi: float, radius: float, axis: str, segments: int
) -> tuple[str, "np.ndarray", "np.ndarray"]:
    """Build a capped cylinder mesh along ``axis`` with numpy only.

    Inputs: ``center`` (the two cross-axis center coordinates), ``lo``/``hi``
    (axis extent), ``radius``, ``axis`` (``"x"``, ``"y"`` or ``"z"``),
    ``segments`` (rim vertices). Output: ``(kind, positions, indices)``
    with ``positions`` shaped ``(2 * segments + 2, 3)`` (two rim rings plus
    two cap centers) and ``indices`` holding side quads plus cap fans.
    """
    angles = np.linspace(0.0, 2.0 * np.pi, segments, endpoint=False)
    ring = np.stack([np.cos(angles), np.sin(angles)], axis=1) * radius
    # Canonical z-aligned cylinder centered on the origin.
    height = hi - lo
    lower = np.column_stack([ring[:, 0], ring[:, 1], np.full(segments, -height / 2)])
    upper = np.column_stack([ring[:, 0], ring[:, 1], np.full(segments, height / 2)])
    positions = np.vstack([lower, upper, [[0.0, 0.0, -height / 2], [0.0, 0.0, height / 2]]])

    indices = []
    for i in range(segments):
        j = (i + 1) % segments
        indices.append([i, segments + i, segments + j])
        indices.append([i, segments + j, j])
        indices.append([2 * segments, j, i])
        indices.append([2 * segments + 1, segments + i, segments + j])

    positions = np.asarray(positions, dtype=float)
    if axis == "x":
        positions = positions[:, [2, 0, 1]]
        mid = (lo + hi) / 2
        positions = positions + np.array([mid, center[0], center[1]])
    elif axis == "y":
        positions = positions[:, [0, 2, 1]]
        mid = (lo + hi) / 2
        positions = positions + np.array([center[0], mid, center[1]])
    else:
        mid = (lo + hi) / 2
        positions = positions + np.array([center[0], center[1], mid])

    return (f"{axis}-cylinder", positions, np.array(indices, dtype=np.int64))


def _sphere_mesh(
    center: tuple[float, float, float], radius: float, segments: int
) -> tuple[str, "np.ndarray", "np.ndarray"]:
    """Build a latitude/longitude sphere mesh with numpy only.

    Inputs: ``center`` ((cx, cy, cz)), ``radius``, ``segments`` (rings and
    rim vertices per ring). Output: ``(kind, positions, indices)``.
    """
    n_lat, n_lon = segments, segments
    positions = []
    for i in range(n_lat + 1):
        theta = np.pi * i / n_lat
        ring_r = radius * np.sin(theta)
        z = radius * np.cos(theta)
        for j in range(n_lon):
            phi = 2.0 * np.pi * j / n_lon
            positions.append(
                [center[0] + ring_r * np.cos(phi), center[1] + ring_r * np.sin(phi), center[2] + z]
            )
    positions = np.array(positions, dtype=float)

    indices = []
    for i in range(n_lat):
        for j in range(n_lon):
            a = i * n_lon + j
            b = i * n_lon + (j + 1) % n_lon
            c = (i + 1) * n_lon + j
            d = (i + 1) * n_lon + (j + 1) % n_lon
            indices.append([a, c, b])
            indices.append([b, c, d])

    return ("sphere", positions, np.array(indices, dtype=np.int64))


def _cell_box(cell: Cell, surfaces: dict[int, Surface], bounds: dict) -> dict:
    """Compute a per-cell axis-aligned bounding box with numpy only.

    Starts from the global ``bounds`` and tightens with the cell's plane
    half-spaces plus cylinder/sphere extents. Output: the 6-float bounds
    dict plus ``min``/``max`` 3-lists (the ``geometry-native`` frontend
    consumes ``bbox.min``/``bbox.max``).
    """
    box = dict(bounds)
    for surf_id, is_comp in cell.surfaces.items():
        surf = surfaces.get(surf_id)
        if surf is None or not surf.coefficients:
            continue
        coeffs = surf.coefficients
        if surf.type == "x-plane":
            x = float(coeffs[0])
            if is_comp:
                box["xmin"] = max(box["xmin"], x)
            else:
                box["xmax"] = min(box["xmax"], x)
        elif surf.type == "y-plane":
            y = float(coeffs[0])
            if is_comp:
                box["ymin"] = max(box["ymin"], y)
            else:
                box["ymax"] = min(box["ymax"], y)
        elif surf.type == "z-plane":
            z = float(coeffs[0])
            if is_comp:
                box["zmin"] = max(box["zmin"], z)
            else:
                box["zmax"] = min(box["zmax"], z)
        elif surf.type in ("z-cylinder", "cylinder") and len(coeffs) >= 3:
            cx, cy, r = float(coeffs[0]), float(coeffs[1]), float(coeffs[2])
            box["xmin"] = max(box["xmin"], cx - r)
            box["xmax"] = min(box["xmax"], cx + r)
            box["ymin"] = max(box["ymin"], cy - r)
            box["ymax"] = min(box["ymax"], cy + r)
        elif surf.type == "x-cylinder" and len(coeffs) >= 3:
            cy, cz, r = float(coeffs[0]), float(coeffs[1]), float(coeffs[2])
            box["ymin"] = max(box["ymin"], cy - r)
            box["ymax"] = min(box["ymax"], cy + r)
            box["zmin"] = max(box["zmin"], cz - r)
            box["zmax"] = min(box["zmax"], cz + r)
        elif surf.type == "y-cylinder" and len(coeffs) >= 3:
            cx, cz, r = float(coeffs[0]), float(coeffs[1]), float(coeffs[2])
            box["xmin"] = max(box["xmin"], cx - r)
            box["xmax"] = min(box["xmax"], cx + r)
            box["zmin"] = max(box["zmin"], cz - r)
            box["zmax"] = min(box["zmax"], cz + r)
        elif surf.type == "sphere" and len(coeffs) >= 4:
            cx, cy, cz, r = (float(coeffs[0]), float(coeffs[1]), float(coeffs[2]), float(coeffs[3]))
            box["xmin"] = max(box["xmin"], cx - r)
            box["xmax"] = min(box["xmax"], cx + r)
            box["ymin"] = max(box["ymin"], cy - r)
            box["ymax"] = min(box["ymax"], cy + r)
            box["zmin"] = max(box["zmin"], cz - r)
            box["zmax"] = min(box["zmax"], cz + r)

    # Repair degenerate ranges against the global bounds.
    if box["xmin"] >= box["xmax"]:
        box["xmin"], box["xmax"] = bounds["xmin"], bounds["xmax"]
    if box["ymin"] >= box["ymax"]:
        box["ymin"], box["ymax"] = bounds["ymin"], bounds["ymax"]
    if box["zmin"] >= box["zmax"]:
        box["zmin"], box["zmax"] = bounds["zmin"], bounds["zmax"]
    flat = {key: float(value) for key, value in box.items()}
    flat["min"] = [flat["xmin"], flat["ymin"], flat["zmin"]]
    flat["max"] = [flat["xmax"], flat["ymax"], flat["zmax"]]
    return flat


def _cell_mesh(
    cell: Cell, surfaces: dict[int, Surface], bounds: dict, segments: int
) -> tuple[str | None, "np.ndarray | None", "np.ndarray | None"]:
    """Build a numpy mesh for one cell from its primary surface.

    Output: ``(kind, positions, indices)`` with ``positions`` shaped
    ``(N, 3)`` and ``indices`` shaped ``(M, 3)``. Returns ``(None, None,
    None)`` for surface types without a numpy tessellator (general planes,
    cones, tori, quadrics) — callers fall back to the cell bounding box.
    """
    if not cell.surfaces:
        return (None, None, None)
    primary_id = list(cell.surfaces.keys())[0]
    surf = surfaces.get(primary_id)
    if surf is None:
        return (None, None, None)

    if surf.type in ("x-plane", "y-plane", "z-plane"):
        cell_bounds = _cell_box(cell, surfaces, bounds)
        return _box_mesh(cell_bounds)
    if surf.type in ("z-cylinder", "cylinder") and len(surf.coefficients) >= 3:
        cx, cy, r = (
            float(surf.coefficients[0]),
            float(surf.coefficients[1]),
            float(surf.coefficients[2]),
        )
        return _cylinder_mesh((cx, cy), bounds["zmin"], bounds["zmax"], r, "z", segments)
    if surf.type == "x-cylinder" and len(surf.coefficients) >= 3:
        cy, cz, r = (
            float(surf.coefficients[0]),
            float(surf.coefficients[1]),
            float(surf.coefficients[2]),
        )
        return _cylinder_mesh((cy, cz), bounds["xmin"], bounds["xmax"], r, "x", segments)
    if surf.type == "y-cylinder" and len(surf.coefficients) >= 3:
        cx, cz, r = (
            float(surf.coefficients[0]),
            float(surf.coefficients[1]),
            float(surf.coefficients[2]),
        )
        return _cylinder_mesh((cx, cz), bounds["ymin"], bounds["ymax"], r, "y", segments)
    if surf.type == "sphere" and len(surf.coefficients) >= 4:
        center = (
            float(surf.coefficients[0]),
            float(surf.coefficients[1]),
            float(surf.coefficients[2]),
        )
        return _sphere_mesh(center, float(surf.coefficients[3]), segments)
    return (None, None, None)


def extract_csg_mesh(geometry_file: str, *, segments: int = _DEFAULT_SEGMENTS) -> dict:
    """Extract OpenMC CSG geometry as three.js-ready mesh JSON (no server).

    Inputs: ``geometry_file`` (path to ``geometry.xml``), ``segments``
    (tessellation segments per curved surface, 3-64). Geometry is parsed
    with the :class:`OpenMCGeometryVisualizer` XML parser; every mesh is
    built with numpy only (no vtk/openmc required).

    Output: JSON-safe dict with ``sourceFile``, ``bounds`` (6 floats),
    ``cells`` (one entry per cell: ``id``, ``name``, ``material``,
    ``universe``, ``surfaceIds``, ``bbox`` plus ``mesh`` with ``kind``,
    flat ``positions``/``indices`` lists and vertex/triangle counts, or
    ``mesh: None`` when the cell needs the bbox fallback), ``surfaces``
    (``id``, ``type``, ``coefficients``, ``boundary``) and ``stats``.
    Raises :class:`GeometryExtractorError` on bad input or parse failure.
    """
    segments = _require_segments(segments)
    path = _require_geometry_xml_path(geometry_file)

    viz = OpenMCGeometryVisualizer()
    if not viz.parse_geometry(path):
        raise GeometryExtractorError(f"could not parse geometry XML: {path}")

    bounds = {key: float(value) for key, value in viz.bounds.items()}

    surfaces_json = [
        {
            "id": int(surf_id),
            "type": surf.type,
            "coefficients": [float(c) for c in surf.coefficients],
            "boundary": surf.boundary,
        }
        for surf_id, surf in sorted(viz.surfaces.items())
    ]

    cells_json = []
    n_vertices = 0
    n_triangles = 0
    n_meshed = 0
    for cell_id, cell in sorted(viz.cells.items()):
        bbox = _cell_box(cell, viz.surfaces, bounds)
        kind, positions, indices = _cell_mesh(cell, viz.surfaces, bounds, segments)
        if kind is None:
            mesh_json = None
        else:
            flat_positions = [float(v) for v in np.asarray(positions, dtype=float).ravel()]
            flat_indices = [int(v) for v in np.asarray(indices, dtype=np.int64).ravel()]
            n_vertices += int(np.asarray(positions).shape[0])
            n_triangles += int(np.asarray(indices).shape[0])
            n_meshed += 1
            mesh_json = {
                "kind": kind,
                "positions": flat_positions,
                "indices": flat_indices,
                "nVertices": int(np.asarray(positions).shape[0]),
                "nTriangles": int(np.asarray(indices).shape[0]),
            }
        cells_json.append(
            {
                "id": int(cell_id),
                "name": cell.name,
                "material": cell.material,
                "universe": int(cell.universe),
                "surfaceIds": [int(s) for s in cell.surfaces],
                "bbox": bbox,
                "mesh": mesh_json,
            }
        )

    return {
        "sourceFile": path,
        "bounds": bounds,
        "cells": cells_json,
        "surfaces": surfaces_json,
        "stats": {
            "nCells": len(cells_json),
            "nSurfaces": len(surfaces_json),
            "nMeshed": n_meshed,
            "nVertices": n_vertices,
            "nTriangles": n_triangles,
        },
    }


def extract_csg_from_openmc_model(model, *, segments: int = _DEFAULT_SEGMENTS) -> dict:
    """Extract mesh JSON from an in-memory openmc model (no server).

    Inputs: ``model`` (an ``openmc.Model`` or ``openmc.Geometry`` — anything
    with ``export_to_xml(path)``; ``model.geometry`` is used when present),
    ``segments`` (tessellation budget, forwarded to :func:`extract_csg_mesh`).
    The geometry is exported to a temp ``geometry.xml`` and extracted with
    :func:`extract_csg_mesh`, so the JSON shape is identical. Raises
    :class:`GeometryExtractorError` when openmc is missing or the export or
    extraction fails.
    """
    _load_openmc()
    segments = _require_segments(segments)

    geometry = getattr(model, "geometry", model)
    if not hasattr(geometry, "export_to_xml"):
        raise GeometryExtractorError("model does not expose export_to_xml (not an openmc model?)")

    import os
    import tempfile

    tmp_dir = tempfile.mkdtemp(prefix="nuke-geom-mesh-")
    xml_path = os.path.join(tmp_dir, "geometry.xml")
    try:
        geometry.export_to_xml(xml_path)
    except Exception as exc:
        raise GeometryExtractorError(f"openmc geometry export failed: {exc}") from None
    return extract_csg_mesh(xml_path, segments=segments)


def write_geometry_mesh_json(mesh: dict, output_path: str) -> str:
    """Write an :func:`extract_csg_mesh` dict to a JSON file.

    Inputs: ``mesh`` (extractor dict), ``output_path`` (destination
    ``.json`` file). Output: the path string. Raises
    :class:`GeometryExtractorError` for a non-dict mesh or a write failure.
    """
    import json
    import os

    if not isinstance(mesh, dict) or "cells" not in mesh:
        raise GeometryExtractorError("mesh must be an extract_csg_mesh dict")
    if not output_path or not isinstance(output_path, (str, os.PathLike)):
        raise GeometryExtractorError(f"invalid output path: {output_path!r}")
    out_str = os.fspath(output_path)
    try:
        with open(out_str, "w") as handle:
            json.dump(mesh, handle, indent=2)
    except OSError as exc:
        raise GeometryExtractorError(f"could not write mesh JSON: {exc}") from None
    return out_str
