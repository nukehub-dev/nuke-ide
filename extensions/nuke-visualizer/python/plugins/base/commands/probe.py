# Copyright (C) 2026 NukeHub and others.
# SPDX-License-Identifier: BSD-2-Clause
"""Headless generic probe command for the base visualizer (no server).

Registers one command over VTK datasets:

- ``base.probe --file <vtk> --array <cell|point:name>
  (--points "x,y,z;x,y,z;..." | --path "x,y,z;x,y,z[;...]")
  [--samples N] [--component N]`` prints one JSON object on stdout:
  ``{file, array, association, points: [{position, value, valid}],
  dataRange?, series?, length?}``.

Point mode probes the given positions. Path mode samples ``--samples``
(default 100, clamped to 2..10000) positions evenly spaced by cumulative
distance along the polyline and adds ``series`` (``distance``/``position``/
``value``/``valid`` rows) plus the total ``length``. ``--component`` selects
one component of a multi-component array (0-based); without it
multi-component arrays use the L2 magnitude. A probe miss is data, not an
error: the sample carries ``value: null`` and ``valid: false``.

The dataset is read through the shared analysis reader and sampled through
``plugins.base.lib.probe``; VTK stays lazily imported, so a missing
dependency surfaces as one JSON error on stderr with exit code 1, never a
traceback (base-plugin contract).
"""

import json
import os

from nuke_viz.plugin import arg, command

from plugins.base.commands.analysis import _error_json, _read_dataset, parse_array_spec
from plugins.base.lib.analysis import AnalysisError
from plugins.base.lib.probe import (
    build_probe_result,
    parse_path,
    parse_points,
    path_samples,
    sample_array_values,
)


@command("base.probe", help="Sample a cell/point array at points or along a path")
@arg("--file", required=True, help="Path to the input VTK dataset")
@arg("--array", required=True, help="Array spec: cell:<name> or point:<name>")
@arg("--points", help='Probe points: "x,y,z;x,y,z;..."')
@arg("--path", help='Polyline: "x,y,z;x,y,z[;...]" (2+ points, evenly sampled)')
@arg("--samples", help="Path sample count (default: 100, clamped to 2..10000)")
@arg(
    "--component",
    type=int,
    help="0-based component of a multi-component array (default: L2 magnitude)",
)
def cmd_probe(args):
    """Probe a cell/point array at points or along a path; print JSON."""
    try:
        association, name = parse_array_spec(args.array)
        if args.points is not None and args.path is not None:
            raise AnalysisError("--points and --path are mutually exclusive")
        if args.points is None and args.path is None:
            raise AnalysisError("one of --points or --path is required")

        series = None
        length = None
        if args.points is not None:
            positions = parse_points(args.points)
        else:
            path = parse_path(args.path)
            series, length = path_samples(path, args.samples)
            positions = [sample["position"] for sample in series]

        _vtk, numpy_support, dataset = _read_dataset(args.file)
        sampled = sample_array_values(
            dataset,
            numpy_support,
            association,
            name,
            positions,
            component=args.component,
        )
        result = build_probe_result(
            os.path.abspath(args.file),
            association,
            name,
            positions,
            sampled,
            series=series,
            length=length,
        )
    except Exception as exc:
        return _error_json(exc)
    print(json.dumps(result))
    return 0
