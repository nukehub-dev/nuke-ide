#!/usr/bin/env python3
"""
Common utilities, configurations, and UI components for NukeIDE visualizers.
Shared across visualizer_app.py, openmc_server.py, and openmc_geometry_viz.py.
"""

import os
import socket
from typing import List, Tuple, Dict, Any, Optional, Callable
from dataclasses import dataclass, field

# =============================================================================
# CONSTANTS
# =============================================================================

# Color map presets available in ParaView
COLOR_MAPS = [
    "Viridis", "Plasma", "Inferno", "Magma", "Cividis",
    "Cool to Warm", "Cool to Warm (Extended)", "Warm to Cool",
    "Black-Body Radiation", "X Ray",
    "Blue to Red Rainbow", "Red to Blue Rainbow",
    "Rainbow Desaturated", "Rainbow Uniform",
    "Jet", "Hot", "Cool",
    "Spectral", "RdYlBu", "RdYlGn", "PuOr", "PRGn", "BrBG",
    "PiYG", "RdBu", "Seismic", "Balance",
    "Twilight", "Haze", "Earth", "Ocean",
    "Blue Orange (div)", "Yellow 5", "Green 4", "Purple 3", "Red 2",
    "Steelblue", "Gray 5",
    "Black, Blue and White", "Black, Orange and White", "Black, Body Radiation",
    "2D", "2D Checkerboard", "2D Extents",
]

# Common color maps for different visualization types
COLOR_MAPS_SHORT = ['Plasma', 'Viridis', 'Inferno', 'Jet', 'Hot', 'Cool']

# Large set of distinct colors for cells and UI elements
DISTINCT_COLORS = [
    [0.3, 0.5, 0.9],  # Blue
    [0.3, 0.9, 0.5],  # Green
    [0.9, 0.5, 0.3],  # Orange
    [0.9, 0.3, 0.9],  # Magenta
    [0.3, 0.9, 0.9],  # Cyan
    [0.9, 0.9, 0.3],  # Yellow
    [0.6, 0.4, 0.8],  # Purple
    [0.4, 0.8, 0.6],  # Mint
    [0.8, 0.6, 0.4],  # Brown
    [0.5, 0.5, 0.5],  # Gray
    [0.2, 0.7, 0.2],  # Dark Green
    [0.1, 0.5, 0.8],  # Royal Blue
    [0.8, 0.1, 0.5],  # Pink
    [0.8, 0.8, 0.1],  # Gold
    [0.1, 0.8, 0.8],  # Sky Blue
]

# Default state values
DEFAULT_STATE = {
    'opacity': 1.0,
    'representation': 'Surface',
    'color_by': 'Solid Color',
    'color_map': 'Cool to Warm',
    'show_scalar_bar': False,
    'background_color_hex': '#1a1a26',
    'show_controls': True,
    'camera_update_counter': 0,
    'appearance_update': 0,
    'ui_theme': 'dark',
    'show_axes': False,
    'show_orientation_axes': True,
    'show_bounding_box': False,
    'show_cube_axes': False,
    'point_size': 2.0,
    'line_width': 1.0,
    'ambient_light': 0.2,
    'parallel_projection': False,
    'screenshot_status': '',
}

# View types for camera positioning
VIEW_TYPES = ['isometric', 'front', 'back', 'left', 'right', 'top', 'bottom']

# Common CSS styles for visualizer UIs
GLOBAL_STYLES = """
    /* Custom scrollbar for dropdowns */
    .v-autocomplete__content::-webkit-scrollbar,
    .v-menu__content::-webkit-scrollbar {
        width: 8px;
    }
    .v-autocomplete__content::-webkit-scrollbar-track,
    .v-menu__content::-webkit-scrollbar-track {
        background: #1e1e2d;
    }
    .v-autocomplete__content::-webkit-scrollbar-thumb,
    .v-menu__content::-webkit-scrollbar-thumb {
        background: #3f3f5f;
        border-radius: 4px;
    }
    .v-autocomplete__content::-webkit-scrollbar-thumb:hover,
    .v-menu__content::-webkit-scrollbar-thumb:hover {
        background: #5a5a8a;
    }

    /* Dropdown menu styling */
    .v-autocomplete__content.v-menu__content,
    .v-menu__content.menuable__content__active {
        border-radius: 8px !important;
        box-shadow: 0 10px 30px rgba(0,0,0,0.5) !important;
        border: 1px solid #3f3f5f !important;
        background-color: #1a1a26 !important;
    }

    /* List item improvements */
    .v-list-item__subtitle {
        font-size: 0.75rem !important;
        opacity: 0.7;
        margin-top: 2px;
    }
    .v-list-item--active {
        background-color: rgba(63, 63, 95, 0.4) !important;
    }

    /* Chip styling */
    .v-chip.v-size--small,
    .v-chip.v-size--x-small {
        border-radius: 4px !important;
        font-weight: 500;
        background-color: #2a2a3d !important;
        border: 1px solid #3f3f5f !important;
    }
    .v-chip.v-size--x-small {
        height: 20px !important;
        font-size: 0.7rem !important;
        padding: 0 6px !important;
    }
    
    /* VAutocomplete improvements */
    .v-autocomplete .v-input__prepend-inner {
        margin-top: 4px !important;
    }
    .v-autocomplete.v-text-field--outlined .v-label {
        top: 8px !important;
    }
    .v-autocomplete .v-select__selections {
        padding-top: 4px !important;
        padding-bottom: 4px !important;
        min-height: 40px !important;
    }
    .v-autocomplete .v-chip {
        margin: 2px 4px !important;
    }
"""


# =============================================================================
# UTILITY FUNCTIONS
# =============================================================================

def find_free_port(start_port: int = 8080, max_port: int = 9000) -> int:
    """Find an available port in the given range."""
    for port in range(start_port, max_port):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(('', port))
                return port
            except OSError:
                continue
    raise RuntimeError(f"No free port found in range {start_port}-{max_port}")


def hex_to_rgb(hex_color: str) -> Optional[List[float]]:
    """Convert hex color to RGB list [r, g, b] with values 0-1."""
    try:
        hex_color = str(hex_color).lstrip('#')
        if len(hex_color) >= 6:
            return [
                int(hex_color[0:2], 16) / 255.0,
                int(hex_color[2:4], 16) / 255.0,
                int(hex_color[4:6], 16) / 255.0
            ]
    except Exception:
        pass
    return None


def get_data_bounds(source) -> List[float]:
    """Get the bounds of the current data source."""
    try:
        if source:
            return source.GetDataInformation().GetBounds()
    except Exception:
        pass
    return [-1, 1, -1, 1, -1, 1]


def calculate_camera_position(view_type: str, bounds: List[float]) -> Tuple[List[float], List[float], List[float]]:
    """Calculate camera position, focal point, and view up based on data bounds.
    
    Args:
        view_type: One of 'isometric', 'front', 'back', 'left', 'right', 'top', 'bottom'
        bounds: Data bounds [xmin, xmax, ymin, ymax, zmin, zmax]
        
    Returns:
        Tuple of (position, focal_point, view_up)
    """
    xmin, xmax, ymin, ymax, zmin, zmax = bounds
    
    # Calculate center
    cx = (xmin + xmax) / 2
    cy = (ymin + ymax) / 2
    cz = (zmin + zmax) / 2
    
    # Calculate diagonal for distance
    dx = xmax - xmin
    dy = ymax - ymin
    dz = zmax - zmin
    diagonal = (dx*dx + dy*dy + dz*dz) ** 0.5
    
    # Distance factor
    distance = diagonal * 1.5 if diagonal > 0 else 5
    
    view_configs = {
        'isometric': ([cx + distance * 0.7, cy + distance * 0.7, cz + distance * 0.7], [cx, cy, cz], [0, 0, 1]),
        'front': ([cx, cy - distance, cz], [cx, cy, cz], [0, 0, 1]),
        'back': ([cx, cy + distance, cz], [cx, cy, cz], [0, 0, 1]),
        'left': ([cx - distance, cy, cz], [cx, cy, cz], [0, 0, 1]),
        'right': ([cx + distance, cy, cz], [cx, cy, cz], [0, 0, 1]),
        'top': ([cx, cy, cz + distance], [cx, cy, cz], [0, 1, 0]),
        'bottom': ([cx, cy, cz - distance], [cx, cy, cz], [0, -1, 0]),
    }
    
    return view_configs.get(view_type, view_configs['isometric'])


def get_available_arrays(source) -> List[str]:
    """Get list of available point and cell data arrays from the source."""
    available = ['Solid Color']
    
    if source is None:
        return available
    
    try:
        # Get point data arrays
        point_data = source.PointData
        for i in range(point_data.GetNumberOfArrays()):
            array = point_data.GetArray(i)
            if array and array.GetName():
                available.append(f"Point: {array.GetName()}")
        
        # Get cell data arrays
        cell_data = source.CellData
        for i in range(cell_data.GetNumberOfArrays()):
            array = cell_data.GetArray(i)
            if array and array.GetName():
                available.append(f"Cell: {array.GetName()}")
    except Exception as e:
        print(f"Warning: Could not get data arrays: {e}")
    
    return available


# =============================================================================
# STATE MANAGEMENT
# =============================================================================

@dataclass
class VisualizerState:
    """Container for visualizer state variables with defaults."""
    opacity: float = 1.0
    representation: str = 'Surface'
    color_by: str = 'Solid Color'
    color_map: str = 'Cool to Warm'
    show_scalar_bar: bool = False
    background_color_hex: str = '#1a1a26'
    show_controls: bool = True
    camera_update_counter: int = 0
    appearance_update: int = 0
    ui_theme: str = 'dark'
    sidebar_color: str = '#1e1e1e'
    sidebar_dark: bool = True
    show_axes: bool = False
    show_orientation_axes: bool = True
    show_bounding_box: bool = False
    show_cube_axes: bool = False
    point_size: float = 2.0
    line_width: float = 1.0
    ambient_light: float = 0.2
    parallel_projection: bool = False
    clip_enabled: bool = False
    clip_origin_x: float = 0.0
    clip_origin_y: float = 0.0
    clip_origin_z: float = 0.0
    clip_normal_x: float = 1.0
    clip_normal_y: float = 0.0
    clip_normal_z: float = 0.0
    clip_invert: bool = False
    screenshot_status: str = ''
    has_timesteps: bool = False
    current_timestep: int = 0
    timestep_values: List = field(default_factory=list)
    available_arrays: List[str] = field(default_factory=lambda: ['Solid Color'])
    
    def apply_to_state(self, state):
        """Apply all values to a trame state object."""
        for key, value in self.__dict__.items():
            setattr(state, key, value)
    
    @classmethod
    def from_defaults(cls, **overrides) -> 'VisualizerState':
        """Create state with optional overrides."""
        state = cls()
        for key, value in overrides.items():
            if hasattr(state, key):
                setattr(state, key, value)
        return state


def init_common_state(state, theme: str = 'dark', **overrides):
    """Initialize common state variables on a trame state object.
    
    Args:
        state: The trame state object
        theme: UI theme - 'dark' or 'light'
        **overrides: Additional state variables to override defaults
    """
    vs = VisualizerState.from_defaults(ui_theme=theme, **overrides)
    
    # Set theme-dependent colors
    if theme == 'light':
        vs.sidebar_color = '#f5f5f5'
        vs.sidebar_dark = False
        vs.background_color_hex = '#ffffff'
    
    vs.apply_to_state(state)
    return vs


# =============================================================================
# UI COMPONENT BUILDERS
# =============================================================================

class UIComponents:
    """Factory class for creating common UI components with trame/vuetify."""
    
    @staticmethod
    def background_color_picker(vuetify, v_model_binding: Tuple = ("background_color_hex", "#1a1a26")):
        """Create a VColorPicker for background color selection."""
        return vuetify.VColorPicker(
            v_model=v_model_binding,
            hide_inputs=True,
            hide_mode_switch=True,
            show_swatches=True,
            swatches_max_height=100,
            mode="hexa",
            elevation=0,
            classes="ma-0 pa-0",
            style="background: transparent; max-width: 100%;",
        )
    
    @staticmethod
    def opacity_slider(vuetify, v_model_binding: Tuple = ("opacity", 1.0), **kwargs):
        """Create an opacity slider."""
        defaults = {
            'label': "Opacity",
            'min': 0,
            'max': 1,
            'step': 0.05,
            'thumb_label': True,
            'dense': True,
            'hide_details': True,
            'classes': kwargs.pop('classes', 'mb-4')
        }
        defaults.update(kwargs)
        return vuetify.VSlider(v_model=v_model_binding, **defaults)
    
    @staticmethod
    def point_size_slider(vuetify, v_model_binding: Tuple = ("point_size", 2.0), **kwargs):
        """Create a point size slider."""
        defaults = {
            'label': "Point Size",
            'min': 1,
            'max': 20,
            'step': 0.5,
            'dense': True,
            'hide_details': True,
            'classes': kwargs.pop('classes', 'mb-4')
        }
        defaults.update(kwargs)
        return vuetify.VSlider(v_model=v_model_binding, **defaults)
    
    @staticmethod
    def line_width_slider(vuetify, v_model_binding: Tuple = ("line_width", 1.0), **kwargs):
        """Create a line width slider."""
        defaults = {
            'label': "Line Width",
            'min': 0.5,
            'max': 10,
            'step': 0.5,
            'dense': True,
            'hide_details': True,
            'classes': kwargs.pop('classes', 'mb-4')
        }
        defaults.update(kwargs)
        return vuetify.VSlider(v_model=v_model_binding, **defaults)
    
    @staticmethod
    def ambient_light_slider(vuetify, v_model_binding: Tuple = ("ambient_light", 0.2), **kwargs):
        """Create an ambient light slider."""
        defaults = {
            'label': "Ambient",
            'min': 0,
            'max': 1,
            'step': 0.05,
            'dense': True,
            'hide_details': True,
            'classes': kwargs.pop('classes', 'mb-4')
        }
        defaults.update(kwargs)
        return vuetify.VSlider(v_model=v_model_binding, **defaults)
    
    @staticmethod
    def representation_selector(vuetify, v_model_binding: Tuple = ("representation", "Surface"), **kwargs):
        """Create a representation selector dropdown."""
        defaults = {
            'items': (['Surface', 'Surface With Edges', 'Wireframe', 'Points'],),
            'label': "Representation",
            'dense': True,
            'outlined': True,
            'classes': "mb-4"
        }
        defaults.update(kwargs)
        return vuetify.VSelect(v_model=v_model_binding, **defaults)
    
    @staticmethod
    def color_by_selector(vuetify, items_binding: Tuple = ("available_arrays",), 
                          v_model_binding: Tuple = ("color_by", "Solid Color"), **kwargs):
        """Create a color-by selector dropdown."""
        defaults = {
            'items': items_binding,
            'label': "Color By",
            'dense': True,
            'outlined': True,
            'classes': "mb-4"
        }
        defaults.update(kwargs)
        return vuetify.VSelect(v_model=v_model_binding, **defaults)
    
    @staticmethod
    def color_map_selector(vuetify, color_maps: List[str] = None, 
                           v_model_binding: Tuple = ("color_map", "Cool to Warm"), **kwargs):
        """Create a color map selector dropdown."""
        maps = color_maps or COLOR_MAPS
        defaults = {
            'items': (maps,),
            'label': "Color Map",
            'dense': True,
            'outlined': True,
            'classes': "mb-2"
        }
        defaults.update(kwargs)
        return vuetify.VSelect(v_model=v_model_binding, **defaults)
    
    @staticmethod
    def color_map_selector_short(vuetify, v_model_binding: Tuple = ("color_map", "Plasma"), **kwargs):
        """Create a color map selector with short list (for source viz)."""
        return UIComponents.color_map_selector(vuetify, COLOR_MAPS_SHORT, v_model_binding, **kwargs)
    
    @staticmethod
    def camera_buttons(vuetify, reset_callback, isometric_callback, 
                       front_callback, side_callback, top_callback, **kwargs):
        """Create camera control buttons.
        
        Returns a list of components to be added to the layout.
        """
        from trame.widgets import html
        
        components = []
        
        # Reset and Isometric row
        with vuetify.VRow(dense=True, classes=kwargs.get('row_classes', '')) as row1:
            with vuetify.VCol(cols=6):
                components.append(vuetify.VBtn(
                    "Reset", click=reset_callback,
                    block=True, small=True, outlined=True, classes="mb-2"
                ))
            with vuetify.VCol(cols=6):
                components.append(vuetify.VBtn(
                    "Isometric", click=isometric_callback,
                    block=True, small=True, outlined=True, classes="mb-2"
                ))
        components.append(row1)
        
        # Front/Side/Top row
        with vuetify.VRow(dense=True) as row2:
            with vuetify.VCol(cols=4):
                components.append(vuetify.VBtn(
                    "Front", click=front_callback,
                    block=True, small=True, text=True
                ))
            with vuetify.VCol(cols=4):
                components.append(vuetify.VBtn(
                    "Side", click=side_callback,
                    block=True, small=True, text=True
                ))
            with vuetify.VCol(cols=4):
                components.append(vuetify.VBtn(
                    "Top", click=top_callback,
                    block=True, small=True, text=True
                ))
        components.append(row2)
        
        return components
    
    @staticmethod
    def appearance_toggles(vuetify, **kwargs):
        """Create common appearance toggle checkboxes."""
        return [
            vuetify.VCheckbox(
                v_model=("show_orientation_axes", True),
                label="Show 3D Axis Indicator",
                dense=True,
                classes="mb-2"
            ),
            vuetify.VCheckbox(
                v_model=("show_bounding_box", False),
                label="Show Data Bounds Outline",
                dense=True,
                classes="mb-2"
            ),
            vuetify.VCheckbox(
                v_model=("show_cube_axes", False),
                label="Show Coordinate Grid",
                dense=True,
                classes="mb-4"
            ),
        ]
    
    @staticmethod
    def screenshot_button(vuetify, callback, **kwargs):
        """Create a screenshot button with status display."""
        from trame.widgets import html
        
        components = [
            vuetify.VSubheader("Export", classes="text-subtitle-1 mb-2"),
            vuetify.VBtn(
                "Save Screenshot",
                click=callback,
                block=True,
                small=True,
                color="primary",
                classes="mb-2"
            ),
        ]
        
        # Status container (conditional)
        with vuetify.VContainer(v_if=("screenshot_status",), classes="text-center") as status:
            vuetify.VSubheader(
                ("screenshot_status",),
                classes="text-caption justify-center"
            )
        components.append(status)
        
        return components


# =============================================================================
# STATE CHANGE HANDLERS
# =============================================================================

class StateHandlers:
    """Factory for creating common state change handlers."""
    
    @staticmethod
    def create_opacity_handler(pipeline):
        """Create opacity change handler."""
        def handler(opacity, **kwargs):
            try:
                display = pipeline.get('display')
                if display:
                    display.Opacity = float(opacity)
            except Exception as e:
                print(f"Error updating opacity: {e}")
        return handler
    
    @staticmethod
    def create_representation_handler(pipeline, state):
        """Create representation change handler."""
        def handler(representation, **kwargs):
            try:
                display = pipeline.get('display')
                if display:
                    display.Representation = representation
                    state.appearance_update = state.appearance_update + 1 if hasattr(state, 'appearance_update') else 1
            except Exception as e:
                print(f"Error updating representation: {e}")
        return handler
    
    @staticmethod
    def create_background_handler(pipeline, state=None):
        """Create background color change handler."""
        def handler(background_color_hex, **kwargs):
            try:
                view = pipeline.get('view')
                if view:
                    rgb = hex_to_rgb(background_color_hex)
                    if rgb:
                        try:
                            view.UseColorPaletteForBackground = 0
                        except:
                            pass
                        view.Background = rgb
            except Exception as e:
                print(f"Error updating background: {e}")
        return handler
    
    @staticmethod
    def create_color_by_handler(pipeline, state, simple):
        """Create color-by change handler."""
        def handler(color_by, **kwargs):
            try:
                display = pipeline.get('display')
                view = pipeline.get('view')
                if not display or not view:
                    return
                
                if color_by == 'Solid Color':
                    simple.ColorBy(display, None)
                elif color_by.startswith('Point: '):
                    array_name = color_by[7:]
                    simple.ColorBy(display, ('POINTS', array_name))
                    lut = simple.GetColorTransferFunction(array_name)
                    lut.ApplyPreset(state.color_map, True)
                elif color_by.startswith('Cell: '):
                    array_name = color_by[6:]
                    simple.ColorBy(display, ('CELLS', array_name))
                    lut = simple.GetColorTransferFunction(array_name)
                    lut.ApplyPreset(state.color_map, True)
            except Exception as e:
                print(f"Error updating color by: {e}")
        return handler
    
    @staticmethod
    def create_color_map_handler(pipeline, state, simple):
        """Create color map change handler."""
        def handler(color_map, **kwargs):
            try:
                color_by = state.color_by
                if color_by == 'Solid Color':
                    return
                
                array_name = None
                if color_by.startswith('Point: '):
                    array_name = color_by[7:]
                elif color_by.startswith('Cell: '):
                    array_name = color_by[6:]
                
                if array_name:
                    lut = simple.GetColorTransferFunction(array_name)
                    lut.ApplyPreset(color_map, True)
            except Exception as e:
                print(f"Error updating color map: {e}")
        return handler
    
    @staticmethod
    def create_scalar_bar_handler(pipeline, state, simple):
        """Create scalar bar visibility handler."""
        def handler(show_scalar_bar, **kwargs):
            try:
                color_by = state.color_by
                view = pipeline.get('view')
                
                if color_by == 'Solid Color' or not view:
                    return
                
                array_name = None
                if color_by.startswith('Point: '):
                    array_name = color_by[7:]
                elif color_by.startswith('Cell: '):
                    array_name = color_by[6:]
                
                if array_name:
                    lut = simple.GetColorTransferFunction(array_name)
                    scalar_bar = simple.GetScalarBar(lut, view)
                    if scalar_bar:
                        scalar_bar.Visibility = bool(show_scalar_bar)
            except Exception as e:
                print(f"Error updating scalar bar: {e}")
        return handler
    
    @staticmethod
    def create_orientation_axes_handler(pipeline):
        """Create orientation axes visibility handler."""
        def handler(show_orientation_axes, **kwargs):
            try:
                view = pipeline.get('view')
                if view:
                    view.OrientationAxesVisibility = bool(show_orientation_axes)
            except Exception as e:
                print(f"Error updating orientation axes: {e}")
        return handler
    
    @staticmethod
    def create_point_size_handler(pipeline):
        """Create point size change handler."""
        def handler(point_size, **kwargs):
            try:
                display = pipeline.get('display')
                if display:
                    display.PointSize = float(point_size)
            except Exception as e:
                print(f"Error updating point size: {e}")
        return handler
    
    @staticmethod
    def create_line_width_handler(pipeline):
        """Create line width change handler."""
        def handler(line_width, **kwargs):
            try:
                display = pipeline.get('display')
                if display:
                    display.LineWidth = float(line_width)
            except Exception as e:
                print(f"Error updating line width: {e}")
        return handler
    
    @staticmethod
    def create_ambient_light_handler(pipeline):
        """Create ambient light change handler."""
        def handler(ambient_light, **kwargs):
            try:
                display = pipeline.get('display')
                if display:
                    display.Ambient = float(ambient_light)
            except Exception as e:
                print(f"Error updating ambient light: {e}")
        return handler
    
    @staticmethod
    def create_parallel_projection_handler(pipeline, state):
        """Create parallel projection change handler."""
        def handler(parallel_projection, **kwargs):
            try:
                view = pipeline.get('view')
                if view:
                    view.CameraParallelProjection = 1 if parallel_projection else 0
                    if hasattr(state, 'camera_update_counter'):
                        state.camera_update_counter += 1
            except Exception as e:
                print(f"Error updating projection mode: {e}")
        return handler


# =============================================================================
# CONTROLLER FUNCTIONS
# =============================================================================

def create_reset_camera_controller(pipeline, update_view_func):
    """Create reset camera controller function."""
    def reset_camera():
        try:
            view = pipeline.get('view')
            if view:
                from paraview import simple
                simple.ResetCamera(view)
                simple.Render(view)
            update_view_func(push_camera=True)
            return True
        except Exception as e:
            print(f"Error resetting camera: {e}")
            return False
    return reset_camera


def create_set_camera_view_controller(pipeline, state, update_view_func):
    """Create set camera view controller function."""
    def set_camera_view(view_type):
        try:
            view = pipeline.get('view')
            if not view:
                return False
            
            source = pipeline.get('source') or pipeline.get('original_source')
            bounds = get_data_bounds(source)
            
            position, focal_point, view_up = calculate_camera_position(view_type, bounds)
            
            view.CameraPosition = position
            view.CameraFocalPoint = focal_point
            view.CameraViewUp = view_up
            
            from paraview import simple
            simple.Render(view)
            update_view_func(push_camera=True)
            
            return True
        except Exception as e:
            print(f"Error setting camera view: {e}")
            return False
    return set_camera_view


def create_capture_screenshot_controller(pipeline):
    """Create screenshot capture controller function."""
    def capture_screenshot(filename=None, width=None, height=None, transparent=False):
        try:
            view = pipeline.get('view')
            if not view:
                return {'success': False, 'error': 'No view available'}
            
            original_bg = view.Background[:]
            original_size = view.ViewSize[:]
            
            try:
                if transparent:
                    view.Background = [0, 0, 0]
                
                if width and height:
                    view.ViewSize = [int(width), int(height)]
                
                from paraview import simple
                simple.Render(view)
                
                if not filename:
                    import tempfile
                    fd, filename = tempfile.mkstemp(suffix='.png')
                    os.close(fd)
                
                simple.SaveScreenshot(filename, view,
                    ImageResolution=view.ViewSize,
                    TransparentBackground=transparent)
                
                import base64
                with open(filename, 'rb') as f:
                    image_data = base64.b64encode(f.read()).decode('utf-8')
                
                return {
                    'success': True,
                    'data': image_data,
                    'format': 'png',
                    'filename': filename
                }
                
            finally:
                view.Background = original_bg
                if width and height:
                    view.ViewSize = original_size
                    
        except Exception as e:
            print(f"Error capturing screenshot: {e}")
            return {'success': False, 'error': str(e)}
    return capture_screenshot


# =============================================================================
# UPDATE VIEW HELPERS
# =============================================================================

def create_update_view(pipeline, state, simple):
    """Create a standard update_view function.
    
    Args:
        pipeline: Dictionary containing 'view' and optionally 'view_widget'
        state: Trame state object (may contain 'view_widget')
        simple: ParaView simple module
        
    Returns:
        Function that updates the view
    """
    def update_view(push_camera=False):
        try:
            view = pipeline.get('view')
            # Check pipeline first, then state for view_widget
            view_widget = pipeline.get('view_widget') or getattr(state, 'view_widget', None)
            
            if view:
                simple.Render(view)
            
            if view_widget:
                if push_camera and hasattr(state, 'camera_update_counter'):
                    state.camera_update_counter += 1
                else:
                    view_widget.update()
        except Exception as e:
            print(f"Error updating view: {e}")
    
    return update_view


# =============================================================================
# SCREENSHOT HELPERS
# =============================================================================

def save_screenshot_with_timestamp(capture_func, state, directory=None):
    """Save a screenshot with auto-generated timestamp filename.
    
    Args:
        capture_func: The capture screenshot function
        state: State object to update with status
        directory: Directory to save to (defaults to cwd)
    """
    from datetime import datetime
    
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"screenshot_{timestamp}.png"
    filepath = os.path.join(directory or os.getcwd(), filename)
    
    result = capture_func(filename=filepath)
    if result.get('success'):
        print(f"Screenshot saved: {filepath}")
        state.screenshot_status = f"Saved: {filename}"
    else:
        print(f"Screenshot failed: {result.get('error')}")
        state.screenshot_status = f"Error: {result.get('error')}"


# =============================================================================
# LAYOUT HELPERS
# =============================================================================

def create_control_panel(vuetify, server, show_controls_binding: Tuple = ("show_controls", True),
                         width: int = 320, theme: str = 'dark'):
    """Create a standard control panel navigation drawer.
    
    Usage:
        with create_control_panel(vuetify, server) as drawer:
            # Add your controls here
            pass
    """
    color = '#1e1e1e' if theme == 'dark' else '#f5f5f5'
    is_dark = theme == 'dark'
    
    return vuetify.VNavigationDrawer(
        v_model=show_controls_binding,
        app=True,
        width=width,
        clipped=True,
        color=color,
        dark=is_dark
    )


def create_main_content(vuetify, pv_widgets, view, toggle_controls_callback):
    """Create the main content area with toggle button and view widget."""
    components = []
    
    # Toggle button when controls are hidden
    with vuetify.VContainer(
        v_if=("!show_controls",),
        classes="ma-2 pa-0",
        style="position: absolute; top: 0; left: 0; z-index: 100;"
    ) as toggle_btn:
        with vuetify.VBtn(
            click=toggle_controls_callback,
            small=True,
            fab=True,
            color="primary"
        ):
            vuetify.VIcon("mdi-chevron-right")
    components.append(toggle_btn)
    
    # Main view widget
    view_widget = pv_widgets.VtkRemoteView(
        view,
        interactive_ratio=1,
        style="width: 100%; height: 100%; position: absolute; top: 0; left: 0;"
    )
    components.append(view_widget)
    
    return components, view_widget


# =============================================================================
# DEPENDENCY CHECKS
# =============================================================================

def check_trame_dependencies() -> Tuple[bool, List[str]]:
    """Check if required trame dependencies are installed.
    
    Returns:
        Tuple of (success, list of error messages)
    """
    errors = []
    
    try:
        import trame
    except ImportError:
        errors.append("trame not installed. Run: pip install trame trame-vuetify")
    
    try:
        from paraview import simple
    except ImportError:
        errors.append("ParaView Python API not available.")
    
    return len(errors) == 0, errors


def check_openmc_dependencies() -> Tuple[bool, str]:
    """Check if OpenMC dependencies are available.
    
    Returns:
        Tuple of (success, message)
    """
    try:
        import h5py
        return True, "OpenMC integration available"
    except ImportError:
        return False, "h5py not installed. Run: pip install h5py"
