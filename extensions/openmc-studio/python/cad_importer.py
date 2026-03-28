#!/usr/bin/env python3
"""
CAD to OpenMC CSG Geometry Converter

Converts CAD files (STEP/IGES/BREP/STL) to OpenMC-compatible CSG surfaces.
Uses gmsh for CAD processing and geometry analysis.

Usage:
    python cad_importer.py <input_file> [options]

Options:
    --unit-factor FACTOR    Unit conversion factor (default: 1.0)
    --tolerance TOL         Surface fitting tolerance in cm (default: 0.001)
    --scale SCALE           Additional scale factor (default: 1.0)
    --material-id ID        Material ID for imported cells (default: None)
    --universe-id ID        Universe ID for imported cells (default: 0)
    --output-json           Output result as JSON to stdout
"""

import sys
import json
import math
import argparse
from pathlib import Path

# Optional imports - handled gracefully if not available
try:
    import numpy as np
    HAS_NUMPY = True
except ImportError:
    HAS_NUMPY = False
    print("Warning: numpy not available, using basic math", file=sys.stderr)

try:
    import gmsh
    HAS_GMSH = True
except ImportError:
    HAS_GMSH = False


def normalize_vector(v):
    """Normalize a 3D vector."""
    length = math.sqrt(v[0]**2 + v[1]**2 + v[2]**2)
    if length < 1e-10:
        return [0, 0, 1]
    return [v[0]/length, v[1]/length, v[2]/length]


def fit_plane(points):
    """Fit a plane to a set of points using PCA."""
    if len(points) < 3:
        return None
    
    if HAS_NUMPY:
        # Compute centroid
        points_arr = np.array(points)
        centroid = np.mean(points_arr, axis=0)
        
        # Compute covariance matrix
        centered = points_arr - centroid
        cov = np.dot(centered.T, centered) / len(points)
        
        # Get normal from smallest eigenvalue eigenvector
        eigenvalues, eigenvectors = np.linalg.eigh(cov)
        normal = eigenvectors[:, 0]  # Smallest eigenvalue
        normal = normalize_vector(normal.tolist())
        
        # Ensure consistent orientation
        if normal[2] < 0:
            normal = [-n for n in normal]
        
        # Plane equation: ax + by + cz = d
        d = np.dot(normal, centroid)
        
        # Calculate max deviation for quality check
        deviations = [abs(np.dot(normal, p) - d) for p in points_arr]
        max_deviation = float(max(deviations)) if deviations else 0
        
        return {
            'type': 'plane',
            'coefficients': [float(normal[0]), float(normal[1]), float(normal[2]), -float(d)],
            'centroid': centroid.tolist(),
            'max_deviation': max_deviation
        }
    else:
        # Basic implementation without numpy
        # Simple centroid and normal estimation
        n = len(points)
        cx = sum(p[0] for p in points) / n
        cy = sum(p[1] for p in points) / n
        cz = sum(p[2] for p in points) / n
        
        # Estimate normal from first 3 points
        if len(points) >= 3:
            p1, p2, p3 = points[0], points[1], points[2]
            v1 = [p2[0]-p1[0], p2[1]-p1[1], p2[2]-p1[2]]
            v2 = [p3[0]-p1[0], p3[1]-p1[1], p3[2]-p1[2]]
            # Cross product
            nx = v1[1]*v2[2] - v1[2]*v2[1]
            ny = v1[2]*v2[0] - v1[0]*v2[2]
            nz = v1[0]*v2[1] - v1[1]*v2[0]
            normal = normalize_vector([nx, ny, nz])
        else:
            normal = [0, 0, 1]
        
        d = normal[0]*cx + normal[1]*cy + normal[2]*cz
        
        return {
            'type': 'plane',
            'coefficients': [normal[0], normal[1], normal[2], -d],
            'centroid': [cx, cy, cz],
            'max_deviation': 0.001  # Assume good fit
        }


def fit_cylinder(points):
    """Fit a cylinder to a set of points."""
    if len(points) < 6:
        return None
    
    if not HAS_NUMPY:
        return None  # Too complex without numpy
    
    points_arr = np.array(points)
    
    # Estimate axis from point distribution using PCA
    centroid = np.mean(points_arr, axis=0)
    centered = points_arr - centroid
    cov = np.dot(centered.T, centered) / len(points)
    eigenvalues, eigenvectors = np.linalg.eigh(cov)
    
    # The axis is the direction of largest variance (largest eigenvalue)
    axis = eigenvectors[:, 2]
    axis = normalize_vector(axis.tolist())
    
    # Project points onto plane perpendicular to axis
    u = np.cross(axis, [1, 0, 0])
    if np.linalg.norm(u) < 0.1:
        u = np.cross(axis, [0, 1, 0])
    u = normalize_vector(u.tolist())
    v = np.cross(axis, u)
    v = normalize_vector(v.tolist())
    
    # Project points
    projections = []
    for p in centered:
        pu = np.dot(p, u)
        pv = np.dot(p, v)
        projections.append([pu, pv])
    
    projections = np.array(projections)
    
    # Fit circle to projections (algebraic method)
    A = np.column_stack([projections[:, 0], projections[:, 1], 
                         np.ones(len(projections))])
    b = projections[:, 0]**2 + projections[:, 1]**2
    
    try:
        sol = np.linalg.lstsq(A, b, rcond=None)[0]
        cx, cy = sol[0] / 2, sol[1] / 2
        r = math.sqrt(sol[2] + cx**2 + cy**2)
        
        # Center in 3D
        center = centroid + cx * np.array(u) + cy * np.array(v)
        
        # Calculate max deviation
        deviations = []
        for p in points_arr:
            to_point = p - center
            proj_axis = np.dot(to_point, axis)
            perp = to_point - proj_axis * np.array(axis)
            dist = np.linalg.norm(perp)
            deviations.append(abs(dist - r))
        
        max_deviation = max(deviations) if deviations else float('inf')
        
        return {
            'type': 'cylinder',
            'coefficients': [float(center[0]), float(center[1]), float(center[2]),
                           float(axis[0]), float(axis[1]), float(axis[2]), float(r)],
            'radius': float(r),
            'axis': [float(a) for a in axis],
            'center': center.tolist(),
            'max_deviation': float(max_deviation)
        }
    except:
        return None


def fit_sphere(points):
    """Fit a sphere to a set of points using least squares."""
    if len(points) < 4:
        return None
    
    if not HAS_NUMPY:
        return None  # Too complex without numpy
    
    points_arr = np.array(points)
    
    # Linear least squares for sphere
    A = np.column_stack([2*points_arr[:, 0], 2*points_arr[:, 1], 2*points_arr[:, 2], 
                         np.ones(len(points_arr))])
    b = points_arr[:, 0]**2 + points_arr[:, 1]**2 + points_arr[:, 2]**2
    
    try:
        sol = np.linalg.lstsq(A, b, rcond=None)[0]
        center = [float(sol[0]), float(sol[1]), float(sol[2])]
        r = math.sqrt(sol[3] + center[0]**2 + center[1]**2 + center[2]**2)
        
        # Calculate max deviation
        deviations = [abs(math.sqrt(sum((p[i] - center[i])**2 for i in range(3))) - r) 
                     for p in points]
        max_deviation = max(deviations) if deviations else float('inf')
        
        return {
            'type': 'sphere',
            'coefficients': [center[0], center[1], center[2], float(r)],
            'radius': float(r),
            'center': center,
            'max_deviation': float(max_deviation)
        }
    except:
        return None


def analyze_surface_type(points, normals, tolerance):
    """Analyze surface type and fit appropriate primitive."""
    if len(points) < 3:
        return None
    
    # Check if planar
    plane_fit = fit_plane(points)
    if plane_fit and plane_fit['max_deviation'] < tolerance:
        return plane_fit
    
    # Check if cylindrical
    cyl_fit = fit_cylinder(points)
    if cyl_fit and cyl_fit['max_deviation'] < tolerance:
        return cyl_fit
    
    # Check if spherical
    sph_fit = fit_sphere(points)
    if sph_fit and sph_fit['max_deviation'] < tolerance * 2:
        return sph_fit
    
    # Default to plane with warning
    if plane_fit:
        plane_fit['warning'] = f'Non-planar surface approximated as plane (deviation: {plane_fit["max_deviation"]:.6f})'
        return plane_fit
    
    return None


def sample_surface_parametric(dim, tag, num_samples=15):
    """Sample points on surface using parametric coordinates."""
    points = []
    
    try:
        # Get parameter bounds for the surface
        param_bounds = gmsh.model.getParametrizationBounds(dim, tag)
        
        # param_bounds is a tuple of two arrays: (u_bounds, v_bounds)
        if param_bounds and len(param_bounds) >= 2:
            u_min, u_max = float(param_bounds[0][0]), float(param_bounds[0][1])
            v_min, v_max = float(param_bounds[1][0]), float(param_bounds[1][1])
        else:
            return points  # Can't sample without bounds
        
        # Sample uniformly in parametric space
        for i in range(num_samples):
            for j in range(num_samples):
                u = u_min + (u_max - u_min) * i / max(num_samples - 1, 1)
                v = v_min + (v_max - v_min) * j / max(num_samples - 1, 1)
                
                try:
                    coord = gmsh.model.getValue(dim, tag, [u, v])
                    if coord is not None and hasattr(coord, '__len__') and len(coord) == 3:
                        points.append([float(coord[0]), float(coord[1]), float(coord[2])])
                except:
                    pass
        
        # If we got points but very few, try denser sampling in center region
        if 0 < len(points) < 9:
            for i in range(5):
                for j in range(5):
                    u = u_min + (u_max - u_min) * (0.3 + 0.4 * i / 4)
                    v = v_min + (v_max - v_min) * (0.3 + 0.4 * j / 4)
                    try:
                        coord = gmsh.model.getValue(dim, tag, [u, v])
                        if coord is not None and hasattr(coord, '__len__') and len(coord) == 3:
                            pt = [float(coord[0]), float(coord[1]), float(coord[2])]
                            # Check for duplicates
                            if not any(abs(p[0]-pt[0]) < 1e-6 and abs(p[1]-pt[1]) < 1e-6 and abs(p[2]-pt[2]) < 1e-6 for p in points):
                                points.append(pt)
                    except:
                        pass
    except Exception as e:
        pass
    
    return points


def sample_surface_from_curves(dim, tag):
    """Sample points from surface boundary curves."""
    points = []
    
    try:
        # Get boundary curves of the surface
        boundary = gmsh.model.getBoundary([(dim, tag)], oriented=False, recursive=False)
        
        for curve_dim, curve_tag in boundary:
            if curve_dim != 1:
                continue
            
            try:
                # Sample points along the curve
                param_bounds = gmsh.model.getParametrizationBounds(curve_dim, curve_tag)
                if param_bounds and len(param_bounds) >= 1:
                    t_min, t_max = float(param_bounds[0][0]), float(param_bounds[0][1])
                else:
                    continue
                
                for i in range(10):
                    t = t_min + (t_max - t_min) * i / 9
                    try:
                        coord = gmsh.model.getValue(curve_dim, curve_tag, [t])
                        if coord is not None and hasattr(coord, '__len__') and len(coord) == 3:
                            pt = [float(coord[0]), float(coord[1]), float(coord[2])]
                            # Check for duplicates
                            if not any(abs(p[0]-pt[0]) < 1e-6 and abs(p[1]-pt[1]) < 1e-6 and abs(p[2]-pt[2]) < 1e-6 for p in points):
                                points.append(pt)
                    except:
                        pass
            except:
                pass
    except Exception as e:
        pass
    
    return points


def get_surface_parametrization(dim, tag, tolerance):
    """Get surface parametrization using gmsh."""
    try:
        # Get surface type from gmsh
        surf_type = gmsh.model.getType(dim, tag)
        
        # Use parametric sampling first
        points = sample_surface_parametric(dim, tag, 15)
        
        # If insufficient points, try curve boundary sampling
        if len(points) < 9:
            curve_points = sample_surface_from_curves(dim, tag)
            # Merge unique points
            for pt in curve_points:
                if not any(abs(p[0]-pt[0]) < 1e-6 and abs(p[1]-pt[1]) < 1e-6 and abs(p[2]-pt[2]) < 1e-6 for p in points):
                    points.append(pt)
        
        normals = []
        return points, normals, surf_type
    except Exception as e:
        return [], [], str(e)


def convert_cad_to_openmc(file_path, unit_factor=1.0, tolerance=0.001, 
                          material_id=None, universe_id=0):
    """Convert CAD file to OpenMC CSG geometry."""
    
    if not HAS_GMSH:
        return {'success': False, 'error': 'gmsh not available'}
    
    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 0)  # Suppress output
    
    try:
        gmsh.open(file_path)
    except Exception as e:
        gmsh.finalize()
        return {'success': False, 'error': f'Failed to open CAD file: {str(e)}'}
    
    result = {
        'success': True,
        'surfaces': [],
        'cells': [],
        'warnings': [],
        'summary': {
            'surfacesCreated': 0,
            'cellsCreated': 0,
            'approximationsMade': 0
        }
    }
    
    try:
        entities = gmsh.model.getEntities()
        
        # Get all solids (3D entities)
        solids = [e for e in entities if e[0] == 3]
        surfaces_2d = [e for e in entities if e[0] == 2]
        
        result['fileInfo'] = {
            'solidCount': len(solids),
            'faceCount': len(surfaces_2d),
            'edgeCount': len([e for e in entities if e[0] == 1])
        }
        
        # Get bounding box
        bbox = gmsh.model.getBoundingBox(-1, -1)
        result['boundingBox'] = {
            'min': [bbox[0] * unit_factor, bbox[1] * unit_factor, bbox[2] * unit_factor],
            'max': [bbox[3] * unit_factor, bbox[4] * unit_factor, bbox[5] * unit_factor]
        }
        
        # Note: Mesh generation is disabled for performance
        # Instead, we use parametric sampling which is faster for large models
        # If high precision is needed, consider pre-meshing the CAD file
        pass
        
        # Surface counter for OpenMC IDs
        surface_id = 1
        cell_id = 1
        
        # Process each solid
        for solid_dim, solid_tag in solids:
            # Get bounding surfaces of this solid
            try:
                boundary = gmsh.model.getBoundary([(solid_dim, solid_tag)], 
                                                   oriented=True, recursive=False)
            except:
                continue
            
            solid_surfaces = []
            solid_surface_ids = []
            
            # Track surfaces for this solid with their orientations
            solid_surface_specs = []  # [(surface_id, sign), ...]
            
            for surf_dim, signed_tag in boundary:
                # signed_tag can be positive or negative indicating orientation
                surf_tag = abs(signed_tag)
                orientation = '-' if signed_tag > 0 else '+'  # gmsh sign convention
                
                # Get surface points and analyze
                points, normals, surf_type = get_surface_parametrization(
                    surf_dim, surf_tag, tolerance
                )
                
                if len(points) < 3:
                    # Try to get points directly from geometry if mesh failed
                    try:
                        points = sample_surface_parametric(surf_dim, surf_tag, 10)
                    except:
                        pass
                
                if len(points) < 3:
                    result['warnings'].append(f'Surface {signed_tag}: insufficient points for fitting ({len(points)} points)')
                    continue
                
                # Analyze and fit surface
                surface_data = analyze_surface_type(points, normals, tolerance)
                
                if surface_data:
                    # Apply scale and unit conversion to coefficients
                    coeffs = surface_data['coefficients']
                    surf_type = surface_data['type']
                    
                    if surf_type == 'plane':
                        coeffs = [coeffs[0], coeffs[1], coeffs[2], 
                                 coeffs[3] * unit_factor]
                    elif surf_type == 'cylinder':
                        coeffs = [coeffs[0] * unit_factor,
                                 coeffs[1] * unit_factor,
                                 coeffs[2] * unit_factor,
                                 coeffs[3], coeffs[4], coeffs[5],
                                 coeffs[6] * unit_factor]
                        # Determine cylinder orientation
                        if abs(coeffs[3]) > 0.9:
                            surf_type = 'x-cylinder'
                        elif abs(coeffs[4]) > 0.9:
                            surf_type = 'y-cylinder'
                        elif abs(coeffs[5]) > 0.9:
                            surf_type = 'z-cylinder'
                    elif surf_type == 'sphere':
                        coeffs = [coeffs[0] * unit_factor,
                                 coeffs[1] * unit_factor,
                                 coeffs[2] * unit_factor,
                                 coeffs[3] * unit_factor]
                    
                    # Map surface type to OpenMC surface type
                    openmc_type_map = {
                        'plane': 'plane',
                        'x-cylinder': 'x-cylinder',
                        'y-cylinder': 'y-cylinder',
                        'z-cylinder': 'z-cylinder',
                        'cylinder': 'cylinder',
                        'sphere': 'sphere'
                    }
                    
                    openmc_surface = {
                        'id': surface_id,
                        'type': openmc_type_map.get(surf_type, 'plane'),
                        'coefficients': coeffs,
                        'name': f'surf_{solid_tag}_{surf_tag}'
                    }
                    
                    if 'warning' in surface_data:
                        result['warnings'].append(
                            f'Surface {signed_tag}: {surface_data["warning"]}'
                        )
                        result['summary']['approximationsMade'] += 1
                    
                    result['surfaces'].append(openmc_surface)
                    solid_surfaces.append(openmc_surface)
                    solid_surface_specs.append((surface_id, orientation))
                    surface_id += 1
            
            # Create cell for this solid
            if solid_surface_specs:
                # Build region expression with proper orientations
                region_terms = [f'{sign}{sid}' for sid, sign in solid_surface_specs]
                region = ' & '.join(region_terms)
                
                cell = {
                    'id': cell_id,
                    'name': f'cell_solid_{solid_tag}',
                    'region': region,
                    'material': str(material_id) if material_id is not None else 'void',
                    'universe': universe_id
                }
                
                result['cells'].append(cell)
                cell_id += 1
        
        result['summary']['surfacesCreated'] = len(result['surfaces'])
        result['summary']['cellsCreated'] = len(result['cells'])
        
        gmsh.finalize()
        return result
        
    except Exception as e:
        gmsh.finalize()
        return {
            'success': False,
            'error': f'Geometry extraction failed: {str(e)}',
            'warnings': result.get('warnings', [])
        }


def main():
    parser = argparse.ArgumentParser(description='Convert CAD to OpenMC CSG')
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
    
    args = parser.parse_args()
    
    # Apply both unit factor and scale
    total_scale = args.unit_factor * args.scale
    
    result = convert_cad_to_openmc(
        args.input_file,
        unit_factor=total_scale,
        tolerance=args.tolerance,
        material_id=args.material_id,
        universe_id=args.universe_id
    )
    
    if args.output_json:
        # Print JSON to stderr to avoid mixing with gmsh stdout
        import sys
        json.dump(result, sys.stdout)
        sys.stdout.flush()
    else:
        if result['success']:
            print(f"Successfully converted CAD file")
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
