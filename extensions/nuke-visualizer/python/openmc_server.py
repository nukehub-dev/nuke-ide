#!/usr/bin/env python3
"""
OpenMC visualization server for NukeIDE.
Supports mesh tally and source distribution visualization.
"""

import argparse
import json
import sys
import os
import tempfile
import numpy as np

# NumPy 2.0+ compatibility: trapezoid replaces trapz
if hasattr(np, 'trapezoid'):
    _np_trapz = np.trapezoid
else:
    _np_trapz = np.trapz

# Force headless/offscreen rendering BEFORE importing vtk or paraview
os.environ['DISPLAY'] = ''
os.environ['QT_QPA_PLATFORM'] = 'offscreen'
os.environ['VTK_USE_OFFSCREEN'] = '1'

# Import common utilities
from visualizer_common import (
    find_free_port, COLOR_MAPS, COLOR_MAPS_SHORT, hex_to_rgb, get_data_bounds,
    calculate_camera_position, create_update_view, create_reset_camera_controller,
    create_set_camera_view_controller, 
    create_pan_camera_controller, create_zoom_camera_controller,
    create_capture_screenshot_controller,
    save_screenshot_with_timestamp, UIComponents, StateHandlers,
    init_common_state, GLOBAL_STYLES
)

from openmc_integration import OpenMCReader

# Import refactored command modules
from openmc_commands import (
    cmd_info, cmd_list, cmd_check,
    cmd_visualize_mesh, cmd_visualize_source, cmd_visualize_overlay, cmd_visualize_statepoint_source,
    cmd_spectrum, cmd_spatial, cmd_heatmap, cmd_heatmap_all,
    cmd_geometry, cmd_visualize_geometry, cmd_check_overlaps, cmd_overlap_viz,
    cmd_materials, cmd_list_nuclides, cmd_list_group_structures, cmd_list_thermal_materials, cmd_material_cell_linkage,
    cmd_mix_materials, cmd_add_material,
    cmd_depletion_summary, cmd_depletion_materials, cmd_depletion_data,
    cmd_xs_plot,
    cmd_statepoint_info, cmd_k_generation, cmd_source_data,
    cmd_energy_distribution,
)

def main():
    parser = argparse.ArgumentParser(description='OpenMC visualization server for NukeIDE')
    subparsers = parser.add_subparsers(dest='command')
    
    # Info command
    info_parser = subparsers.add_parser('info', help='Get statepoint info')
    info_parser.add_argument('statepoint', help='Path to statepoint file')
    
    # List command
    list_parser = subparsers.add_parser('list', help='List tallies in statepoint')
    list_parser.add_argument('statepoint', help='Path to statepoint file')
    
    # Visualize mesh command
    mesh_parser = subparsers.add_parser('visualize-mesh', help='Visualize mesh tally')
    mesh_parser.add_argument('statepoint', help='Path to statepoint file')
    mesh_parser.add_argument('tally_id', type=int, help='Tally ID to visualize')
    mesh_parser.add_argument('--score-index', help='Score index or name')
    mesh_parser.add_argument('--nuclide-index', help='Nuclide index or name')
    mesh_parser.add_argument('--colormap', help='Color map name')
    mesh_parser.add_argument('--port', type=int, help='Server port')
    
    # Visualize source command
    source_parser = subparsers.add_parser('visualize-source', help='Visualize source distribution')
    source_parser.add_argument('source', help='Path to source.h5 file')
    source_parser.add_argument('--port', type=int, help='Server port')
    
    # Visualize overlay command
    overlay_parser = subparsers.add_parser('visualize-overlay', help='Overlay tally on geometry')
    overlay_parser.add_argument('geometry', help='Path to geometry.xml')
    overlay_parser.add_argument('statepoint', help='Path to statepoint file')
    overlay_parser.add_argument('tally_id', type=int, help='Tally ID')
    overlay_parser.add_argument('--score', help='Score name')
    overlay_parser.add_argument('--colormap', help='Color map name')
    overlay_parser.add_argument('--no-graveyard-filter', action='store_true',
                                help='Disable graveyard surface filtering (show full geometry including graveyard cube)')
    overlay_parser.add_argument('--port', type=int, help='Server port')
    
    # Spectrum command
    spectrum_parser = subparsers.add_parser('spectrum', help='Get energy spectrum data')
    spectrum_parser.add_argument('statepoint', help='Path to statepoint file')
    spectrum_parser.add_argument('tally_id', type=int, help='Tally ID')
    spectrum_parser.add_argument('--score-index', help='Score index')
    spectrum_parser.add_argument('--nuclide-index', help='Nuclide index')
    
    # Spatial command
    spatial_parser = subparsers.add_parser('spatial', help='Get spatial plot data')
    spatial_parser.add_argument('statepoint', help='Path to statepoint file')
    spatial_parser.add_argument('tally_id', type=int, help='Tally ID')
    spatial_parser.add_argument('axis', choices=['x', 'y', 'z'], help='Axis for spatial plot')
    spatial_parser.add_argument('--score-index', help='Score index')
    spatial_parser.add_argument('--nuclide-index', help='Nuclide index')
    
    # Heatmap command
    heatmap_parser = subparsers.add_parser('heatmap', help='Get 2D heatmap slice data')
    heatmap_parser.add_argument('statepoint', help='Path to statepoint file')
    heatmap_parser.add_argument('tally_id', type=int, help='Tally ID')
    heatmap_parser.add_argument('plane', choices=['xy', 'xz', 'yz'], help='Plane for slice')
    heatmap_parser.add_argument('slice_index', type=int, help='Slice index')
    heatmap_parser.add_argument('--score-index', help='Score index')
    heatmap_parser.add_argument('--nuclide-index', help='Nuclide index')
    
    # Heatmap all command
    heatmap_all_parser = subparsers.add_parser('heatmap-all', help='Get all 2D heatmap slices')
    heatmap_all_parser.add_argument('statepoint', help='Path to statepoint file')
    heatmap_all_parser.add_argument('tally_id', type=int, help='Tally ID')
    heatmap_all_parser.add_argument('plane', choices=['xy', 'xz', 'yz'], help='Plane for slices')
    heatmap_all_parser.add_argument('--score-index', help='Score index')
    heatmap_all_parser.add_argument('--nuclide-index', help='Nuclide index')
    
    # Check command
    check_parser = subparsers.add_parser('check', help='Check if OpenMC integration is available')
    
    # List group structures command
    list_groups_parser = subparsers.add_parser('list-group-structures', help='List available group structures')
    
    # List thermal materials command
    list_thermal_parser = subparsers.add_parser('list-thermal-materials', help='List available thermal scattering materials')
    list_thermal_parser.add_argument('--cross-sections', help='Path to cross_sections.xml')
    
    # Depletion commands
    depletion_summary_parser = subparsers.add_parser('depletion-summary', help='Get depletion summary')
    depletion_summary_parser.add_argument('file', help='Path to depletion_results.h5')
    
    depletion_materials_parser = subparsers.add_parser('depletion-materials', help='List materials in depletion results')
    depletion_materials_parser.add_argument('file', help='Path to depletion_results.h5')
    
    depletion_data_parser = subparsers.add_parser('depletion-data', help='Get depletion data for material')
    depletion_data_parser.add_argument('file', help='Path to depletion_results.h5')
    depletion_data_parser.add_argument('material_index', type=int, help='Material index')
    depletion_data_parser.add_argument('--nuclides', help='Comma-separated nuclide list')
    
    # Geometry commands
    geometry_parser = subparsers.add_parser('geometry', help='Get geometry hierarchy')
    geometry_parser.add_argument('file', help='Path to geometry.xml')
    
    visualize_geometry_parser = subparsers.add_parser('visualize-geometry', help='Visualize OpenMC geometry')
    visualize_geometry_parser.add_argument('file', help='Path to geometry.xml')
    visualize_geometry_parser.add_argument('--port', type=int, help='Server port')
    visualize_geometry_parser.add_argument('--highlight', help='Cell ID(s) to highlight (comma-separated)')
    visualize_geometry_parser.add_argument('--overlaps', help='Path to JSON file with overlap markers')
    
    # XS Plot command
    xs_parser = subparsers.add_parser('xs-plot', help='Plot cross-sections')
    xs_parser.add_argument('--nuclides', help='Comma-separated nuclide names')
    xs_parser.add_argument('--reactions', required=True, help='Comma-separated reaction MT numbers')
    xs_parser.add_argument('--temperature', type=float, default=294.0, help='Temperature in Kelvin')
    xs_parser.add_argument('--energy-min', type=float, default=1e-5, help='Minimum energy in eV')
    xs_parser.add_argument('--energy-max', type=float, default=2e7, help='Maximum energy in eV')
    xs_parser.add_argument('--energy-region', help='Energy region preset (thermal, resonance, epithermal, fast, full)')
    xs_parser.add_argument('--cross-sections', help='Path to cross_sections.xml file')
    xs_parser.add_argument('--temp-comparison', help='Temperature comparison mode: comma-separated temperatures')
    xs_parser.add_argument('--materials', help='JSON string of materials with components')
    xs_parser.add_argument('--flux-spectrum', help='JSON string of flux spectrum for reaction rate calculation')
    xs_parser.add_argument('--library-comparison', help='JSON string of library comparison configuration')
    xs_parser.add_argument('--include-uncertainty', action='store_true', help='Include uncertainty/error data if available')
    xs_parser.add_argument('--include-integrals', action='store_true', help='Calculate and include integral quantities')
    xs_parser.add_argument('--include-derivative', action='store_true', help='Calculate and include derivative/slope data')
    xs_parser.add_argument('--thermal-scattering', help='JSON string of thermal scattering (S(alpha,beta)) request')
    xs_parser.add_argument('--chain-decay', help='JSON string of chain decay/buildup request')
    xs_parser.add_argument('--group-structure', help='Energy group structure name (e.g., 8-group, CASMO-8, or any custom name in group_structures.yaml)')
    
    # List Nuclides command
    nuclides_parser = subparsers.add_parser('list-nuclides', help='List available nuclides')
    nuclides_parser.add_argument('--cross-sections', help='Path to cross_sections.xml')
    
    # Materials command
    materials_parser = subparsers.add_parser('materials', help='Parse materials.xml file')
    materials_parser.add_argument('file', help='Path to materials.xml')
    
    # Material-cell linkage command
    linkage_parser = subparsers.add_parser('material-cell-linkage', help='Get material-cell mapping')
    linkage_parser.add_argument('materials_file', help='Path to materials.xml')
    linkage_parser.add_argument('geometry_file', help='Path to geometry.xml')
    
    # Mix materials command
    mix_parser = subparsers.add_parser('mix-materials', help='Mix multiple materials')
    mix_parser.add_argument('file', help='Path to materials.xml')
    mix_parser.add_argument('--material-ids', required=True, help='Comma-separated material IDs to mix')
    mix_parser.add_argument('--fractions', required=True, help='Comma-separated mixing fractions')
    mix_parser.add_argument('--percent-type', choices=['ao', 'wo', 'vo'], default='ao', help='Fraction type')
    mix_parser.add_argument('--name', help='Name of the new material')
    mix_parser.add_argument('--id', type=int, help='ID of the new material')
    
    # Add material command
    add_mat_parser = subparsers.add_parser('add-material', help='Add a material to materials.xml')
    add_mat_parser.add_argument('file', help='Path to materials.xml')
    add_mat_parser.add_argument('--material-xml', required=True, help='XML snippet of the material')
    
    # Overlap checker commands
    overlaps_parser = subparsers.add_parser('check-overlaps', help='Check for geometry overlaps')
    overlaps_parser.add_argument('geometry', help='Path to geometry.xml or Python model')
    overlaps_parser.add_argument('--samples', type=int, default=100000, help='Number of sample points')
    overlaps_parser.add_argument('--tolerance', type=float, default=1e-6, help='Numerical tolerance')
    overlaps_parser.add_argument('--bounds', help='Bounding box as JSON {"min": [x,y,z], "max": [x,y,z]}')
    overlaps_parser.add_argument('--parallel', action='store_true', help='Use parallel processing')
    
    overlap_viz_parser = subparsers.add_parser('overlap-viz', help='Get overlap visualization data')
    overlap_viz_parser.add_argument('geometry', help='Path to geometry.xml')
    overlap_viz_parser.add_argument('--overlaps', required=True, help='Overlaps JSON array')
    overlap_viz_parser.add_argument('--marker-size', type=float, default=1.0, help='Marker size in cm')
    
    # Statepoint Viewer commands
    statepoint_info_parser = subparsers.add_parser('statepoint-info', help='Get full statepoint information')
    statepoint_info_parser.add_argument('statepoint', help='Path to statepoint file')
    
    k_generation_parser = subparsers.add_parser('k-generation', help='Get k-generation data for convergence plot')
    k_generation_parser.add_argument('statepoint', help='Path to statepoint file')
    
    source_data_parser = subparsers.add_parser('source-data', help='Get source particle data')
    source_data_parser.add_argument('statepoint', help='Path to statepoint file')
    source_data_parser.add_argument('--max-particles', type=int, default=10000, help='Maximum particles to return')
    
    energy_dist_parser = subparsers.add_parser('energy-distribution', help='Get energy distribution histogram')
    energy_dist_parser.add_argument('statepoint', help='Path to statepoint file')
    energy_dist_parser.add_argument('--bins', type=int, default=50, help='Number of energy bins')
    
    viz_sp_source_parser = subparsers.add_parser('visualize-statepoint-source', help='Visualize source from statepoint')
    viz_sp_source_parser.add_argument('statepoint', help='Path to statepoint file')
    viz_sp_source_parser.add_argument('--port', type=int, help='Server port')
    viz_sp_source_parser.add_argument('--max-particles', type=int, default=5000, help='Max particles to visualize')
    
    args = parser.parse_args()
    
    if not args.command:
        parser.print_help()
        return 1
    
    # Route to appropriate command handler
    commands = {
        'info': cmd_info,
        'list': cmd_list,
        'visualize-mesh': cmd_visualize_mesh,
        'visualize-source': cmd_visualize_source,
        'visualize-overlay': cmd_visualize_overlay,
        'spectrum': cmd_spectrum,
        'spatial': cmd_spatial,
        'heatmap': cmd_heatmap,
        'heatmap-all': cmd_heatmap_all,
        'check': cmd_check,
        'list-group-structures': cmd_list_group_structures,
        'list-thermal-materials': cmd_list_thermal_materials,
        'depletion-summary': cmd_depletion_summary,
        'depletion-materials': cmd_depletion_materials,
        'depletion-data': cmd_depletion_data,
        'geometry': cmd_geometry,
        'visualize-geometry': cmd_visualize_geometry,
        'xs-plot': cmd_xs_plot,
        'list-nuclides': cmd_list_nuclides,
        'materials': cmd_materials,
        'material-cell-linkage': cmd_material_cell_linkage,
        'mix-materials': cmd_mix_materials,
        'add-material': cmd_add_material,
        'check-overlaps': cmd_check_overlaps,
        'overlap-viz': cmd_overlap_viz,
        # Statepoint Viewer commands
        'statepoint-info': cmd_statepoint_info,
        'k-generation': cmd_k_generation,
        'source-data': cmd_source_data,
        'energy-distribution': cmd_energy_distribution,
        'visualize-statepoint-source': cmd_visualize_statepoint_source,
    }
    
    handler = commands.get(args.command)
    if handler:
        return handler(args)
    else:
        print(f"Unknown command: {args.command}", file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
