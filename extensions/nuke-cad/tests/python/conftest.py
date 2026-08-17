"""Pytest configuration for the nuke-cad Python test suite.

Adds the extension's ``python/`` directory to ``sys.path`` so that
``geometry_service``, ``region_manifest``, and ``ocp_compat`` are importable.
"""

import os
import sys

_PYTHON_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "python")
_PYTHON_DIR = os.path.abspath(_PYTHON_DIR)
if _PYTHON_DIR not in sys.path:
    sys.path.insert(0, _PYTHON_DIR)
