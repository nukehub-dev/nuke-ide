# Copyright (C) 2026 NukeHub and others.
# SPDX-License-Identifier: BSD-2-Clause
"""Pure export helpers for the base visualizer.

Backs the headless ``base.export`` command. This module never imports
``vtk``: CSV rendering, format/extension validation, and array-spec parsing
operate on plain sequences so they stay unit-testable in the minimal
pytest + numpy profile, while the command handler reads VTK arrays and
writes files.

Conventions:

- CSV tables always start with the caller's extra columns (typically
  ``tuple``) and then the array columns. Multi-component arrays expand to
  ``name[0]``, ``name[1]``, ... (the same naming the Dataset Inspector uses).
- Fields containing commas, quotes, or line breaks are quoted per RFC 4180;
  non-finite numbers render as empty cells and negative zero normalizes to
  ``0`` so spreadsheets read the table cleanly.
- Output text ends with a newline; an empty table renders just its header,
  and a table with neither columns nor rows renders an empty string.
- Public helpers return plain strings/dicts (JSON-safe by construction) and
  raise :class:`ExportError` for invalid formats, extensions, shapes, names,
  or mismatched tuple counts.
"""

import math
import numbers
import os
from collections.abc import Mapping

#: Export formats understood by ``base.export``.
EXPORT_FORMATS = ("csv", "vtk", "gltf")

#: Default output suffix per export format.
DEFAULT_EXTENSIONS = {
    "csv": ".csv",
    "vtk": ".vtk",
    "gltf": ".gltf",
}

#: Accepted output suffixes per export format (all lowercase).
EXPORT_SUFFIXES = {
    "csv": (".csv",),
    "vtk": (".vtk", ".vtp", ".vtu", ".vti", ".vtr", ".vts"),
    "gltf": (".gltf", ".glb"),
}


class ExportError(ValueError):
    """Raised for export helper failures (format, extension, shape, arrays)."""


def validate_export_format(format_name):
    """Return the normalized export format or raise :class:`ExportError`.

    Accepts case-insensitive names with surrounding whitespace. The result is
    one of :data:`EXPORT_FORMATS`.
    """
    if not isinstance(format_name, str):
        expected = ", ".join(EXPORT_FORMATS)
        raise ExportError(f"Unsupported export format {format_name!r} (expected: {expected})")
    normalized = format_name.strip().lower()
    if normalized not in EXPORT_FORMATS:
        expected = ", ".join(EXPORT_FORMATS)
        raise ExportError(f"Unsupported export format '{format_name}' (expected: {expected})")
    return normalized


def default_extension(format_name):
    """Return the default output suffix (``.csv``/``.vtk``/``.gltf``)."""
    return DEFAULT_EXTENSIONS[validate_export_format(format_name)]


def validate_output_extension(path, format_name):
    """Validate an output path suffix for one format and return it lowercased.

    Raises :class:`ExportError` when the path is empty, has no suffix, or
    carries a suffix that does not match the requested format. Callers that
    allow extensionless paths should append :func:`default_extension` first.
    """
    format_name = validate_export_format(format_name)
    if not isinstance(path, str) or not path.strip():
        raise ExportError("--output must be a non-empty path")
    suffix = os.path.splitext(path)[1].lower()
    allowed = EXPORT_SUFFIXES[format_name]
    if suffix not in allowed:
        expected = ", ".join(allowed)
        raise ExportError(
            f"Unsupported output suffix '{suffix or '<none>'}' for {format_name} export "
            f"(expected: {expected})"
        )
    return suffix


def format_export_value(value):
    """Render one CSV cell: finite numbers round-trip, non-finite become empty."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, numbers.Integral):
        return str(int(value))
    if isinstance(value, numbers.Real):
        number = float(value)
        if not math.isfinite(number):
            return ""
        if number == 0.0:
            return "0"
        return repr(number)
    return str(value)


def csv_field(value):
    """Format and RFC-4180 quote one CSV field."""
    text = format_export_value(value)
    if any(character in text for character in (",", '"', "\r", "\n")):
        return '"' + text.replace('"', '""') + '"'
    return text


def parse_array_spec(spec):
    """Parse ``cell:<name>`` / ``point:<name>``; return ``(association, name)``."""
    if not isinstance(spec, str) or ":" not in spec:
        raise ExportError("--array must be 'cell:<name>' or 'point:<name>'")
    association, name = spec.split(":", 1)
    association = association.strip().lower()
    name = name.strip()
    if association not in ("cell", "point"):
        raise ExportError(f"Unsupported array association '{association}' (expected cell or point)")
    if not name:
        raise ExportError("--array is missing the array name after the association prefix")
    return association, name


def _normalize_components(components):
    """Validate a positive component count."""
    if (
        isinstance(components, bool)
        or not isinstance(components, numbers.Integral)
        or components < 1
    ):
        raise ExportError(f"components must be a positive integer (got {components!r})")
    return int(components)


def _normalize_array(entry):
    """Normalize one array entry to ``(name, values, components, tuple_count)``."""
    if isinstance(entry, Mapping):
        name = entry.get("name")
        values = entry.get("values")
        components = entry.get("components", 1)
    elif isinstance(entry, (tuple, list)) and len(entry) == 3:
        name, values, components = entry
    else:
        raise ExportError("each array must be a mapping or a (name, values, components) triple")
    if not isinstance(name, str) or not name.strip():
        raise ExportError("array name must be a non-empty string")
    components = _normalize_components(components)
    try:
        length = len(values)
    except TypeError:
        raise ExportError(f"array '{name}' values must be a sized sequence") from None
    if length % components:
        raise ExportError(
            f"array '{name}' has {length} values, not a multiple of {components} components"
        )
    return name, values, components, length // components


def _normalize_extra_columns(extra_columns):
    """Normalize ``(name, values)`` pairs (or a mapping) to a list of pairs."""
    if extra_columns is None:
        return []
    entries = extra_columns.items() if isinstance(extra_columns, Mapping) else extra_columns
    normalized = []
    for entry in entries:
        if not isinstance(entry, (tuple, list)) or len(entry) != 2:
            raise ExportError("extra_columns entries must be (name, values) pairs")
        name, values = entry
        if not isinstance(name, str) or not name.strip():
            raise ExportError("extra column name must be a non-empty string")
        try:
            len(values)
        except TypeError:
            raise ExportError(f"column '{name}' values must be a sized sequence") from None
        normalized.append((name, values))
    return normalized


def _component_names(name, components):
    """Column names for one array (scalar name or ``name[i]`` components)."""
    if components == 1:
        return [name]
    return [f"{name}[{index}]" for index in range(components)]


def export_csv_payload(arrays, extra_columns=()):
    """Build one CSV table over parallel arrays.

    ``arrays`` is a sequence of mappings with ``name``/``values``/
    ``components`` keys (or ``(name, values, components)`` triples). Values
    are the flat tuple stream; ``components`` is the number of values per
    tuple. ``extra_columns`` is a sequence of ``(column, values)`` pairs (or a
    mapping) whose values run parallel to the array tuples and appear before
    the array columns.

    Returns ``{"csv": text, "columns": header, "rows": tuple_count,
    "arrays": [name, ...]}``. Every array and extra column must have the same
    tuple count; mismatched shapes raise :class:`ExportError`. With no
    columns and no rows the CSV text is empty; otherwise the text ends with a
    newline.
    """
    normalized_arrays = [_normalize_array(entry) for entry in arrays]
    normalized_extras = _normalize_extra_columns(extra_columns)

    counts = []
    for name, _, _, tuple_count in normalized_arrays:
        counts.append((f"array '{name}'", tuple_count))
    for name, values in normalized_extras:
        counts.append((f"column '{name}'", len(values)))

    if counts:
        tuple_count = counts[0][1]
        for label, count in counts[1:]:
            if count != tuple_count:
                raise ExportError(f"{label} has {count} tuples; expected {tuple_count}")
    else:
        tuple_count = 0

    columns = [name for name, _ in normalized_extras]
    for name, _, components, _ in normalized_arrays:
        columns.extend(_component_names(name, components))

    lines = []
    if columns:
        lines.append(",".join(csv_field(column) for column in columns))
    for index in range(tuple_count):
        row = [csv_field(values[index]) for _, values in normalized_extras]
        for _, values, components, _ in normalized_arrays:
            base = index * components
            row.extend(csv_field(values[base + component]) for component in range(components))
        lines.append(",".join(row))

    return {
        "csv": "\n".join(lines) + "\n" if lines else "",
        "columns": columns,
        "rows": tuple_count,
        "arrays": [name for name, _, _, _ in normalized_arrays],
    }


def array_to_csv(values, components, extra_columns=(), name="value"):
    """Render one flat array as a complete RFC-4180 CSV table.

    ``values`` is the flat tuple stream, ``components`` the number of values
    per tuple, and ``extra_columns`` / ``name`` match
    :func:`export_csv_payload`. Returns the CSV text (header plus rows,
    trailing newline). The array's own columns use ``name`` and
    ``name[0]``... for multi-component data.
    """
    payload = export_csv_payload(
        [{"name": name, "values": values, "components": components}], extra_columns
    )
    return payload["csv"]
