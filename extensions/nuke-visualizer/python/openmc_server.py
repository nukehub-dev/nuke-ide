#!/usr/bin/env python3
"""
Backward-compatible shim for openmc_server.py.

Translates legacy command names to namespaced commands and delegates
to the unified server.py entry point.
"""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Map legacy commands to namespaced commands
_COMMAND_MAP = {
    'info': 'openmc.info',
    'list': 'openmc.list',
    'visualize-mesh': 'openmc.visualize-mesh',
    'visualize-source': 'openmc.visualize-source',
    'visualize-overlay': 'openmc.visualize-overlay',
    'spectrum': 'openmc.spectrum',
    'spatial': 'openmc.spatial',
    'heatmap': 'openmc.heatmap',
    'heatmap-all': 'openmc.heatmap-all',
    'check': 'openmc.check',
    'list-group-structures': 'openmc.list-group-structures',
    'list-thermal-materials': 'openmc.list-thermal-materials',
    'depletion-summary': 'openmc.depletion-summary',
    'depletion-materials': 'openmc.depletion-materials',
    'depletion-data': 'openmc.depletion-data',
    'geometry': 'openmc.geometry',
    'visualize-geometry': 'openmc.visualize-geometry',
    'xs-plot': 'openmc.xs-plot',
    'list-nuclides': 'openmc.list-nuclides',
    'materials': 'openmc.materials',
    'material-cell-linkage': 'openmc.material-cell-linkage',
    'mix-materials': 'openmc.mix-materials',
    'add-material': 'openmc.add-material',
    'check-overlaps': 'openmc.check-overlaps',
    'overlap-viz': 'openmc.overlap-viz',
    'statepoint-info': 'openmc.statepoint-info',
    'k-generation': 'openmc.k-generation',
    'source-data': 'openmc.source-data',
    'energy-distribution': 'openmc.energy-distribution',
    'visualize-statepoint-source': 'openmc.visualize-statepoint-source',
}

if len(sys.argv) > 1 and sys.argv[1] in _COMMAND_MAP:
    sys.argv[1] = _COMMAND_MAP[sys.argv[1]]

import server
sys.exit(server.main())
