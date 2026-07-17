"""Pytest configuration for the openmc-studio Python test suite.

Adds the extension's ``python/`` directory to ``sys.path`` (the same way
``python/cad_importer.py`` does) so that ``cad_conversion`` and the
top-level service modules are importable.
"""

import os
import sys

_PYTHON_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "python")
_PYTHON_DIR = os.path.abspath(_PYTHON_DIR)
if _PYTHON_DIR not in sys.path:
    sys.path.insert(0, _PYTHON_DIR)
