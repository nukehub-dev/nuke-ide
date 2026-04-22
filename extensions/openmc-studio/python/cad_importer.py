#!/usr/bin/env python3
"""CAD to OpenMC CSG Geometry Converter.

Converts CAD files (STEP/IGES/BREP/STL) to OpenMC-compatible CSG surfaces.
Uses the cad_conversion package for robust surface recognition and
automatically falls back to DAGMC for NURBS / free-form surfaces.

Usage:
    python cad_importer.py <input_file> [options]

Options:
    --unit-factor FACTOR    Unit conversion factor (default: 1.0)
    --tolerance TOL         Surface fitting tolerance in cm (default: 0.001)
    --scale SCALE           Additional scale factor (default: 1.0)
    --material-id ID        Material ID for imported cells (default: None)
    --universe-id ID        Universe ID for imported cells (default: 0)
    --output-json           Output result as JSON to stdout
    --force-dagmc           Force DAGMC conversion even for analytic models
    --force-csg             Force CSG conversion even if NURBS detected
    --dagmc-output PATH     Output path for DAGMC .h5m (default: auto)
    --faceting-tol TOL      Faceting tolerance for DAGMC fallback (default: 0.001)
"""

import sys
import json
import math
import argparse
from pathlib import Path

# Ensure our package is importable
_SCRIPT_DIR = Path(__file__).parent.resolve()
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from cad_conversion import (
    gmsh_utils,
    surface_extractor,
    nurbs_handler,
    topology,
    SurfaceFitResult,
)

# Optional imports - handled gracefully if not available
try:
    import numpy as np
    HAS_NUMPY = True
except ImportError:
    HAS_NUMPY = False


def _map_surface_type_to_openmc(surf_type: str, coeffs: list) -> tuple:
    """Map internal surface type to OpenMC surface type and coefficients.

    Returns (openmc_type, openmc_coefficients).
    """
    if surf_type == 'plane':
        return 'plane', coeffs
    elif surf_type == 'sphere':
        return 'sphere', coeffs
    elif surf_type == 'cylinder':
        # General cylinder: [x0, y0, z0, vx, vy, vz, r]
        # Map to axis-aligned if possible
        vx, vy, vz = coeffs[3], coeffs[4], coeffs[5]
        ax = abs(vx)
        ay = abs(vy)
        az = abs(vz)
        if ax > 0.9 and ay < 0.1 and az < 0.1:
            return 'x-cylinder', [coeffs[0], coeffs[1], coeffs[2], vx, vy, vz, coeffs[6]]
        elif ay > 0.9 and ax < 0.1 and az < 0.1:
            return 'y-cylinder', [coeffs[0], coeffs[1], coeffs[2], vx, vy, vz, coeffs[6]]
        elif az > 0.9 and ax < 0.1 and ay < 0.1:
            return 'z-cylinder', [coeffs[0], coeffs[1], coeffs[2], vx, vy, vz, coeffs[6]]
        else:
            return 'cylinder', coeffs
    elif surf_type in ('x-cone', 'y-cone', 'z-cone'):
        return surf_type, coeffs
    elif surf_type in ('x-torus', 'y-torus', 'z-torus'):
        return surf_type, coeffs
    elif surf_type == 'quadric':
        return 'quadric', coeffs
    else:
        return 'plane', coeffs


def convert_cad_to_openmc(file_path: str,
                          unit_factor: float = 1.0,
                          tolerance: float = 0.001,
                          material_id: int = None,
                          universe_id: int = 0,
                          force_dagmc: bool = False,
                          force_csg: bool = False,
                          dagmc_output: str = None,
                          faceting_tolerance: float = 0.001,
                          auto_adjust_tolerance: bool = True) -> dict:
    """Convert a CAD file to OpenMC geometry.

    Automatically detects NURBS surfaces and falls back to DAGMC conversion
    unless force_csg is set.
    """

    if not gmsh_utils.HAS_GMSH:
        return {'success': False, 'error': 'gmsh not available'}

    result = {
        'success': True,
        'surfaces': [],
        'cells': [],
        'warnings': [],
        'summary': {
            'surfacesCreated': 0,
            'cellsCreated': 0,
            'approximationsMade': 0,
        },
        'dagmc': False,
        'dagmcFile': None,
        'nurbsDetected': False,
    }

    # ------------------------------------------------------------------
    # Stage 1: Detect NURBS
    # ------------------------------------------------------------------
    has_nurbs = False
    if not force_csg:
        try:
            has_nurbs = nurbs_handler.has_nurbs_surfaces(file_path)
            result['nurbsDetected'] = has_nurbs
        except Exception as e:
            result['warnings'].append(f'NURBS detection failed: {e}')

    # ------------------------------------------------------------------
    # Stage 2: DAGMC fallback
    # ------------------------------------------------------------------
    if (has_nurbs or force_dagmc) and not force_csg:
        result['warnings'].append(
            'NURBS or free-form surfaces detected. Falling back to DAGMC conversion.'
        )
        dagmc_res = nurbs_handler.convert_to_dagmc(
            file_path,
            output_path=dagmc_output,
            faceting_tolerance=faceting_tolerance,
            length_scale=unit_factor,
            auto_adjust_tolerance=auto_adjust_tolerance,
        )
        if dagmc_res['success']:
            result['dagmc'] = True
            result['dagmcFile'] = dagmc_res['output_path']
            result['success'] = True
            # Add basic file info from gmsh
            gmsh_utils.gmsh.initialize()
            gmsh_utils.gmsh.option.setNumber("General.Terminal", 0)
            try:
                gmsh_utils.gmsh.open(file_path)
                entities = gmsh_utils.get_all_entities()
                solids = [e for e in entities if e[0] == 3]
                faces = [e for e in entities if e[0] == 2]
                result['fileInfo'] = {
                    'solidCount': len(solids),
                    'faceCount': len(faces),
                    'edgeCount': len([e for e in entities if e[0] == 1]),
                    'dagmc': True,
                    'dagmcOutput': dagmc_res['output_path'],
                }
                bbox = gmsh_utils.get_bounding_box(-1, -1)
                result['boundingBox'] = {
                    'min': [bbox[0] * unit_factor, bbox[1] * unit_factor, bbox[2] * unit_factor],
                    'max': [bbox[3] * unit_factor, bbox[4] * unit_factor, bbox[5] * unit_factor],
                }
            except Exception:
                pass
            finally:
                gmsh_utils.gmsh.finalize()

            if dagmc_res.get('warnings'):
                result['warnings'].extend(dagmc_res['warnings'])
            return result
        else:
            result['success'] = False
            result['error'] = dagmc_res.get('error', 'DAGMC conversion failed')
            return result

    # ------------------------------------------------------------------
    # Stage 3: CSG conversion for analytic surfaces
    # ------------------------------------------------------------------
    gmsh_utils.gmsh.initialize()
    gmsh_utils.gmsh.option.setNumber("General.Terminal", 0)

    try:
        gmsh_utils.gmsh.open(file_path)
    except Exception as e:
        gmsh_utils.gmsh.finalize()
        return {'success': False, 'error': f'Failed to open CAD file: {e}'}

    try:
        entities = gmsh_utils.get_all_entities()
        solids = [e for e in entities if e[0] == 3]
        faces = [e for e in entities if e[0] == 2]

        result['fileInfo'] = {
            'solidCount': len(solids),
            'faceCount': len(faces),
            'edgeCount': len([e for e in entities if e[0] == 1]),
            'dagmc': False,
        }

        bbox = gmsh_utils.get_bounding_box(-1, -1)
        result['boundingBox'] = {
            'min': [bbox[0] * unit_factor, bbox[1] * unit_factor, bbox[2] * unit_factor],
            'max': [bbox[3] * unit_factor, bbox[4] * unit_factor, bbox[5] * unit_factor],
        }

        surface_id = 1
        cell_id = 1
        all_surfaces: list = []

        for solid_dim, solid_tag in solids:
            boundary = gmsh_utils.get_boundary(
                (solid_dim, solid_tag), oriented=True, recursive=False
            )
            solid_surface_specs = []

            for surf_dim, signed_tag in boundary:
                if surf_dim != 2:
                    continue
                surf_tag = abs(signed_tag)
                orientation = '-' if signed_tag > 0 else '+'

                fit_result = surface_extractor.extract_surface_from_entity(
                    surf_dim, surf_tag, tolerance, unit_factor, file_path
                )

                if fit_result is None:
                    result['warnings'].append(
                        f'Surface {signed_tag}: could not fit any analytic primitive'
                    )
                    continue

                openmc_type, openmc_coeffs = _map_surface_type_to_openmc(
                    fit_result.surface_type, fit_result.coefficients
                )

                openmc_surface = {
                    'id': surface_id,
                    'type': openmc_type,
                    'coefficients': openmc_coeffs,
                    'name': f'surf_{solid_tag}_{surf_tag}',
                }

                if fit_result.warning:
                    result['warnings'].append(
                        f'Surface {signed_tag}: {fit_result.warning}'
                    )
                    result['summary']['approximationsMade'] += 1

                all_surfaces.append(openmc_surface)
                solid_surface_specs.append((surface_id, orientation))
                surface_id += 1

            if solid_surface_specs:
                region_terms = [f'{sign}{sid}' for sid, sign in solid_surface_specs]
                region = ' & '.join(region_terms)

                cell = {
                    'id': cell_id,
                    'name': f'cell_solid_{solid_tag}',
                    'region': region,
                    'material': str(material_id) if material_id is not None else 'void',
                    'universe': universe_id,
                }
                result['cells'].append(cell)
                cell_id += 1

        # Post-process: merge coplanar surfaces
        all_surfaces = topology.merge_coplanar_surfaces(all_surfaces, tolerance)

        result['surfaces'] = all_surfaces
        result['summary']['surfacesCreated'] = len(all_surfaces)
        result['summary']['cellsCreated'] = len(result['cells'])

        gmsh_utils.gmsh.finalize()
        return result

    except Exception as e:
        gmsh_utils.gmsh.finalize()
        return {
            'success': False,
            'error': f'Geometry extraction failed: {e}',
            'warnings': result.get('warnings', []),
        }


def main():
    parser = argparse.ArgumentParser(description='Convert CAD to OpenMC CSG or DAGMC')
    parser.add_argument('input_file', help='Input CAD file (STEP/IGES/BREP/STL)')
    parser.add_argument('--unit-factor', type=float, default=1.0,
                       help='Unit conversion factor (default: 1.0)')
    parser.add_argument('--tolerance', type=float, default=0.001,
                       help='Surface fitting tolerance in cm (default: 0.001)')
    parser.add_argument('--scale', type=float, default=1.0,
                       help='Additional scale factor (default: 1.0)')
    parser.add_argument('--material-id', type=int, default=None,
                       help='Material ID for imported cells')
    parser.add_argument('--universe-id', type=int, default=0,
                       help='Universe ID for imported cells')
    parser.add_argument('--output-json', action='store_true',
                       help='Output result as JSON')
    parser.add_argument('--force-dagmc', action='store_true',
                       help='Force DAGMC conversion')
    parser.add_argument('--force-csg', action='store_true',
                       help='Force CSG conversion even with NURBS')
    parser.add_argument('--dagmc-output', type=str, default=None,
                       help='Output path for DAGMC .h5m file')
    parser.add_argument('--faceting-tol', type=float, default=0.001,
                       help='Faceting tolerance for DAGMC (default: 0.001)')
    parser.add_argument('--no-auto-adjust-tol', action='store_true',
                       help='Disable automatic faceting tolerance adjustment for large models')

    args = parser.parse_args()
    total_scale = args.unit_factor * args.scale

    result = convert_cad_to_openmc(
        args.input_file,
        unit_factor=total_scale,
        tolerance=args.tolerance,
        material_id=args.material_id,
        universe_id=args.universe_id,
        force_dagmc=args.force_dagmc,
        force_csg=args.force_csg,
        dagmc_output=args.dagmc_output,
        faceting_tolerance=args.faceting_tol,
        auto_adjust_tolerance=not args.no_auto_adjust_tol,
    )

    if args.output_json:
        json.dump(result, sys.stdout)
        sys.stdout.flush()
    else:
        if result['success']:
            print("Successfully converted CAD file")
            if result.get('dagmc'):
                print(f"DAGMC output: {result.get('dagmcFile')}")
            print(f"Surfaces created: {result['summary']['surfacesCreated']}")
            print(f"Cells created: {result['summary']['cellsCreated']}")
            if result['warnings']:
                print(f"\nWarnings ({len(result['warnings'])}):")
                for w in result['warnings'][:10]:
                    print(f"  - {w}")
                if len(result['warnings']) > 10:
                    print(f"  ... and {len(result['warnings']) - 10} more")
        else:
            print(f"Error: {result['error']}")
            sys.exit(1)


if __name__ == '__main__':
    main()
