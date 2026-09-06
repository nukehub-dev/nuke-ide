# Copyright (C) 2026 NukeHub and others.
# SPDX-License-Identifier: BSD-2-Clause
"""Headless Exodus-II series extraction command (no trame server).

Exposes ``plugins.base.lib.exodus_series`` as ``base.exodus-series`` so the
native time-slider viewer can load per-step mesh + variable JSON without
starting a ``base.serve`` server.
"""

import json
import sys

from nuke_viz.plugin import arg, command


@command("base.exodus-series", help="Extract an Exodus-II time series to headless JSON (no server)")
@arg("--file", required=True, help="Path to the input Exodus-II file (.e)")
@arg("--max-steps", type=int, help="Maximum number of time steps to extract (default: all)")
@arg("--max-points", type=int, default=5000, help="Max decimated mesh nodes stored per step")
def cmd_exodus_series(args):
    """Extract an Exodus-II transient series as JSON on stdout."""
    try:
        from plugins.base.lib import exodus_series
    except ImportError as e:
        print(f'{{"error": "Exodus series library not available: {e}"}}', file=sys.stderr)
        return 1

    try:
        from plugins.base.lib.exodus_series import json_default

        result = exodus_series.extract_exodus_series(
            args.file,
            max_steps=args.max_steps,
            max_points=args.max_points,
        )
        print(json.dumps(result, default=json_default))
        return 0
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        return 1
