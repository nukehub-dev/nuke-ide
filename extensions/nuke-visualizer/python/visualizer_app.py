#!/usr/bin/env python3
"""
Backward-compatible shim for visualizer_app.py.

Delegates to the unified server.py entry point with the base.serve command.
"""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Insert base.serve command if not already present
if len(sys.argv) > 1 and not sys.argv[1].startswith('-'):
    # First arg looks like a command already; assume it's been namespaced
    pass
else:
    sys.argv.insert(1, 'base.serve')

import server
sys.exit(server.main())
