"""
Basic OpenMC commands (info, list, check).
"""

import json
import sys
from openmc_integration import OpenMCReader


def cmd_info(args):
    """Get statepoint info."""
    reader = OpenMCReader()
    info = reader.load_statepoint(args.statepoint)
    print(json.dumps(info, indent=2))
    return 0


def cmd_list(args):
    """List tallies in statepoint file."""
    reader = OpenMCReader()
    tallies = reader.list_tallies(args.statepoint)
    print(json.dumps(tallies, indent=2))
    return 0


def cmd_check(args):
    """Check if OpenMC Python module is available."""
    try:
        import openmc
        print(json.dumps({
            "available": True,
            "version": openmc.__version__ if hasattr(openmc, '__version__') else 'unknown'
        }))
        return 0
    except ImportError:
        print(json.dumps({
            "available": False,
            "error": "OpenMC Python module not installed"
        }))
        return 1
