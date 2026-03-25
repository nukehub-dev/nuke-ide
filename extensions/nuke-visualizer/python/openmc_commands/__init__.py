"""
OpenMC server commands package.
Organized into submodules by functionality.
"""

# Import refactored commands from submodules
from .basic import cmd_info, cmd_list, cmd_check
from .tally_viz import cmd_visualize_mesh, cmd_visualize_source, cmd_visualize_overlay
from .spectrum import cmd_spectrum, cmd_spatial, cmd_heatmap, cmd_heatmap_all
from .geometry import cmd_geometry, cmd_visualize_geometry, cmd_check_overlaps, cmd_overlap_viz
from .materials import cmd_materials, cmd_list_nuclides, cmd_list_group_structures, cmd_list_thermal_materials, cmd_material_cell_linkage, cmd_mix_materials, cmd_add_material
from .depletion import cmd_depletion_summary, cmd_depletion_materials, cmd_depletion_data
from .xs_plot import cmd_xs_plot

__all__ = [
    # Basic
    'cmd_info', 'cmd_list', 'cmd_check',
    # Tally visualization
    'cmd_visualize_mesh', 'cmd_visualize_source', 'cmd_visualize_overlay',
    # Spectrum/plotting
    'cmd_spectrum', 'cmd_spatial', 'cmd_heatmap', 'cmd_heatmap_all',
    # Geometry
    'cmd_geometry', 'cmd_visualize_geometry', 'cmd_check_overlaps', 'cmd_overlap_viz',
    # Materials
    'cmd_materials', 'cmd_list_nuclides', 'cmd_list_group_structures', 
    'cmd_list_thermal_materials', 'cmd_material_cell_linkage',
    'cmd_mix_materials', 'cmd_add_material',
    # Depletion
    'cmd_depletion_summary', 'cmd_depletion_materials', 'cmd_depletion_data',
    # Cross-section plotting
    'cmd_xs_plot',
]
