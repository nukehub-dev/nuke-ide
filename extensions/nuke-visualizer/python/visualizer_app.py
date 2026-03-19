#!/usr/bin/env python3
"""
Visualizer visualization server for NukeIDE.
Enhanced with interactive control panel for opacity, color maps, clipping, etc.
"""

import sys
import os
import argparse
import socket
from pathlib import Path

# Force headless/offscreen rendering BEFORE importing vtk or paraview
os.environ['DISPLAY'] = ''  # Disable X11 display
os.environ['QT_QPA_PLATFORM'] = 'offscreen'  # Qt offscreen platform
os.environ['VTK_USE_OFFSCREEN'] = '1'  # VTK offscreen rendering

def find_free_port(start_port=8080, max_port=9000):
    """Find an available port in the given range."""
    for port in range(start_port, max_port):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(('', port))
                return port
            except OSError:
                continue
    raise RuntimeError(f"No free port found in range {start_port}-{max_port}")


def check_dependencies():
    """Check if required dependencies are installed."""
    errors = []
    
    # Check trame
    try:
        import trame
    except ImportError:
        errors.append("trame not installed. Run: pip install trame trame-vuetify")
    
    # Check ParaView
    try:
        from paraview import simple
    except ImportError:
        errors.append("ParaView Python API not available. Make sure pvpython is in PATH or use pvpython instead of python.")
    
    if errors:
        print("=" * 60)
        print("ERROR: Missing dependencies")
        print("=" * 60)
        for error in errors:
            print(f"  - {error}")
        print("=" * 60)
        return False
    
    return True


# Color map presets available in ParaView
COLOR_MAPS = [
    "Viridis",
    "Plasma",
    "Inferno",
    "Magma",
    "Cividis",
    "Cool to Warm",
    "Cool to Warm (Extended)",
    "Warm to Cool",
    "Black-Body Radiation",
    "X Ray",
    "Blue to Red Rainbow",
    "Red to Blue Rainbow",
    "Rainbow Desaturated",
    "Rainbow Uniform",
    "Jet",
    "Hot",
    "Cool",
    "Spectral",
    "RdYlBu",
    "RdYlGn",
    "PuOr",
    "PRGn",
    "BrBG",
    "PiYG",
    "RdBu",
    "Seismic",
    "Balance",
    "Twilight",
    "Haze",
    "Earth",
    "Ocean",
    "Blue Orange (div)",
    "Yellow 5",
    "Green 4",
    "Purple 3",
    "Red 2",
    "Steelblue",
    "Gray 5",
    "Black, Blue and White",
    "Black, Orange and White",
    "Black, Body Radiation",
    "2D",
    "2D Checkerboard",
    "2D Extents",
]


def get_available_arrays(source):
    """Get list of available point and cell data arrays from the source."""
    available = ['Solid Color']
    
    if source is None:
        return available
    
    try:
        # Get point data arrays
        point_data = source.PointData
        for i in range(point_data.GetNumberOfArrays()):
            array = point_data.GetArray(i)
            if array:
                array_name = array.GetName()
                if array_name:
                    available.append(f"Point: {array_name}")
        
        # Get cell data arrays
        cell_data = source.CellData
        for i in range(cell_data.GetNumberOfArrays()):
            array = cell_data.GetArray(i)
            if array:
                array_name = array.GetName()
                if array_name:
                    available.append(f"Cell: {array_name}")
    except Exception as e:
        print(f"Warning: Could not get data arrays: {e}")
    
    return available


def create_app(file_path=None, port=None, theme='dark'):
    """Create trame application with interactive control panel.
    
    Args:
        file_path: Path to file to visualize
        port: Port to run server on
        theme: UI theme - 'dark' or 'light'
    """
    
    # Import trame modules
    try:
        from trame.app import get_server
    except ImportError as e:
        print(f"Error: trame not installed. Run: pip install trame trame-vuetify")
        sys.exit(1)
    
    # Import ParaView
    try:
        from paraview import simple
        from trame.widgets import paraview as pv_widgets
    except ImportError:
        print("Error: ParaView Python API not available.")
        print("Make sure you are running this script with pvpython or that ParaView is in PYTHONPATH.")
        sys.exit(1)
    
    server = get_server(client_type="vue2")
    state = server.state
    
    # Initialize state variables (serializable only)
    state.opacity = 1.0
    state.representation = 'Surface'
    state.available_arrays = ['Solid Color']
    state.color_by = 'Solid Color'
    state.color_map = 'Cool to Warm'
    state.show_scalar_bar = False
    state.show_controls = True
    state.background_color = [0.1, 0.1, 0.15]  # Dark background (RGB 0-1)
    state.background_color_hex = '#1a1a26'  # Hex for UI (Dark Blue)
    state.camera_update_counter = 0  # Used to trigger client-side camera updates
    state.appearance_update = 0  # Used to trigger appearance-related updates
    state.ui_theme = theme  # 'dark' or 'light'
    state.sidebar_color = '#1e1e1e' if theme == 'dark' else '#f5f5f5'
    state.sidebar_dark = theme == 'dark'
    print(f"UI Theme: {theme}, sidebar_color: {state.sidebar_color}, sidebar_dark: {state.sidebar_dark}")
    
    # Visibility toggles
    state.show_axes = False
    state.show_orientation_axes = True
    state.show_bounding_box = False  # Show data bounds outline
    state.show_cube_axes = False     # Show grid cube axes
    
    # Appearance details
    state.point_size = 2.0
    state.line_width = 1.0
    state.ambient_light = 0.2  # 0 to 1
    state.parallel_projection = False
    
    # Clipping state
    state.clip_enabled = False
    state.clip_origin_x = 0.0
    state.clip_origin_y = 0.0
    state.clip_origin_z = 0.0
    state.clip_normal_x = 1.0
    state.clip_normal_y = 0.0
    state.clip_normal_z = 0.0
    state.clip_invert = False
    
    # Time step state (for transient simulations like Cardinal/Exodus)
    state.timestep_values = []  # List of available timesteps
    state.current_timestep = 0  # Current timestep index
    state.has_timesteps = False  # Whether file has timesteps
    
    # Screenshot status
    state.screenshot_status = ""  # Status message for screenshot
    
    # Store non-serializable VTK objects in a separate dictionary (not in state)
    pipeline = {
        'source': None,
        'display': None,
        'view': None,
        'clip_filter': None,
        'original_source': None,
        'view_widget': None,
    }
    
    # ParaView pipeline setup
    reader = None
    title = "Default View"
    
    if file_path and os.path.exists(file_path):
        file_ext = Path(file_path).suffix.lower()
        title = Path(file_path).name
        print(f"Loading file: {file_path} (type: {file_ext})")
        
        try:
            if file_ext in ['.vtk', '.vtu', '.vtp', '.vts', '.vtr', '.pvtu', '.pvtp']:
                reader = simple.OpenDataFile(file_path)
                print(f"Loaded VTK file: {file_path}")
            elif file_ext == '.stl':
                reader = simple.STLReader(FileNames=[file_path])
                print(f"Loaded STL file: {file_path}")
            elif file_ext == '.ply':
                reader = simple.PLYReader(FileNames=[file_path])
                print(f"Loaded PLY file: {file_path}")
            elif file_ext == '.obj':
                reader = simple.OBJReader(FileName=file_path)
                print(f"Loaded OBJ file: {file_path}")
            else:
                # Try generic reader
                reader = simple.OpenDataFile(file_path)
                print(f"Loaded file: {file_path}")
                
        except Exception as e:
            print(f"Warning: Could not load file {file_path}: {e}")
            reader = None
    
    # Create default visualization if no file or failed to load
    if reader is None:
        print("Creating default sphere visualization")
        reader = simple.Sphere()
        reader.ThetaResolution = 32
        reader.PhiResolution = 32
    
    # Store source reference (not in state!)
    pipeline['source'] = reader
    pipeline['original_source'] = reader
    
    # Get available data arrays
    state.available_arrays = get_available_arrays(reader)
    print(f"Available arrays: {state.available_arrays}")
    
    # Check for timesteps (for transient data like Exodus/Cardinal)
    try:
        if hasattr(reader, 'TimestepValues') and reader.TimestepValues:
            timesteps = list(reader.TimestepValues)
            if len(timesteps) > 1:
                state.timestep_values = timesteps
                state.has_timesteps = True
                state.current_timestep = 0
                print(f"Detected {len(timesteps)} timesteps")
            else:
                state.has_timesteps = False
        else:
            state.has_timesteps = False
    except Exception as e:
        print(f"Could not detect timesteps: {e}")
        state.has_timesteps = False
    
    # Helper function to convert hex to RGB
    def hex_to_rgb(hex_color):
        hex_color = hex_color.lstrip('#')
        return [
            int(hex_color[0:2], 16) / 255.0,
            int(hex_color[2:4], 16) / 255.0,
            int(hex_color[4:6], 16) / 255.0
        ]
    
    # Create visualization pipeline
    display = simple.Show(reader)
    view = simple.GetActiveViewOrCreate('RenderView')
    
    # Set initial background color from hex
    initial_bg = hex_to_rgb(state.background_color_hex)
    print(f"Setting initial background color: {initial_bg} (from {state.background_color_hex})")
    view.Background = initial_bg
    
    # Store references (not in state!)
    pipeline['display'] = display
    pipeline['view'] = view
    
    # Set initial representation
    display.Representation = state.representation
    display.Opacity = state.opacity
    
    # Render to apply initial settings
    simple.Render(view)
    simple.ResetCamera()
    
    # Define view update function
    def update_view(push_camera=False):
        """Update the view after state changes.
        
        Args:
            push_camera: If True, also push camera state to client.
                        This should be True after programmatic camera changes.
        """
        try:
            view = pipeline.get('view')
            view_widget = pipeline.get('view_widget')
            
            if view:
                # Render the view
                simple.Render(view)
                
            if view_widget:
                # For camera changes, increment counter to trigger state change
                # This forces the VtkRemoteView to refresh with new camera state
                if push_camera:
                    state.camera_update_counter += 1
                else:
                    # Just update widget for non-camera changes
                    view_widget.update()
                        
        except Exception as e:
            print(f"Error updating view: {e}")
    
    # Define state change handlers
    @state.change("opacity")
    def on_opacity_change(opacity, **kwargs):
        """Handle opacity slider change."""
        try:
            display = pipeline.get('display')
            if display:
                display.Opacity = float(opacity)
                update_view()
        except Exception as e:
            print(f"Error updating opacity: {e}")
    
    @state.change("representation")
    def on_representation_change(representation, **kwargs):
        """Handle representation change."""
        try:
            display = pipeline.get('display')
            if display:
                # Map representation names to valid VTK representations
                rep_map = {
                    'Surface': 'Surface',
                    'Surface With Edges': 'Surface With Edges',
                    'Wireframe': 'Wireframe',
                    'Points': 'Points'
                }
                vtk_rep = rep_map.get(representation, 'Surface')
                display.Representation = vtk_rep
                
                print(f"Representation changed to: {vtk_rep}")
                state.appearance_update += 1
        except Exception as e:
            print(f"Error updating representation: {e}")
    
    @state.change("color_by")
    def on_color_by_change(color_by, **kwargs):
        """Handle color by change."""
        try:
            display = pipeline.get('display')
            view = pipeline.get('view')
            if not display or not view:
                return
            
            if color_by == 'Solid Color':
                simple.ColorBy(display, None)
            elif color_by.startswith('Point: '):
                array_name = color_by[7:]  # Remove 'Point: ' prefix
                simple.ColorBy(display, ('POINTS', array_name))
                # Apply current color map
                lut = simple.GetColorTransferFunction(array_name)
                lut.ApplyPreset(state.color_map, True)
            elif color_by.startswith('Cell: '):
                array_name = color_by[6:]  # Remove 'Cell: ' prefix
                simple.ColorBy(display, ('CELLS', array_name))
                # Apply current color map
                lut = simple.GetColorTransferFunction(array_name)
                lut.ApplyPreset(state.color_map, True)
            
            update_view()
        except Exception as e:
            print(f"Error updating color by: {e}")
    
    @state.change("color_map")
    def on_color_map_change(color_map, **kwargs):
        """Handle color map change."""
        try:
            color_by = state.color_by
            if color_by == 'Solid Color':
                return
            
            # Extract array name
            if color_by.startswith('Point: '):
                array_name = color_by[7:]
            elif color_by.startswith('Cell: '):
                array_name = color_by[6:]
            else:
                return
            
            lut = simple.GetColorTransferFunction(array_name)
            lut.ApplyPreset(color_map, True)
            update_view()
        except Exception as e:
            print(f"Error updating color map: {e}")
    
    @state.change("show_scalar_bar")
    def on_scalar_bar_change(show_scalar_bar, **kwargs):
        """Handle scalar bar visibility change."""
        try:
            color_by = state.color_by
            view = pipeline.get('view')
            
            if color_by == 'Solid Color' or not view:
                return
            
            # Extract array name
            if color_by.startswith('Point: '):
                array_name = color_by[7:]
            elif color_by.startswith('Cell: '):
                array_name = color_by[6:]
            else:
                return
            
            lut = simple.GetColorTransferFunction(array_name)
            scalar_bar = simple.GetScalarBar(lut, view)
            if scalar_bar:
                scalar_bar.Visibility = bool(show_scalar_bar)
                update_view()
        except Exception as e:
            print(f"Error updating scalar bar: {e}")
    
    @state.change("background_color")
    def on_background_change(background_color, **kwargs):
        """Handle background color change."""
        try:
            view = pipeline.get('view')
            if view:
                view.Background = background_color
                update_view()
        except Exception as e:
            print(f"Error updating background: {e}")
    
    def hex_to_rgb(hex_color):
        """Convert hex color to RGB list [r, g, b] with values 0-1 safely."""
        try:
            hex_color = str(hex_color).lstrip('#')
            if len(hex_color) == 6:
                return [
                    int(hex_color[0:2], 16) / 255.0,
                    int(hex_color[2:4], 16) / 255.0,
                    int(hex_color[4:6], 16) / 255.0
                ]
        except Exception:
            pass
        return None  # Return None if the user is halfway through typing
    
    @state.change("background_color_hex")
    def on_background_color_hex_change(background_color_hex, **kwargs):
        """Handle background color change from hex input."""
        try:
            view = pipeline.get('view')
            if view:
                # Convert hex to RGB safely
                rgb = hex_to_rgb(background_color_hex)
                if rgb:  # Only update if we have a complete, valid color
                    try:
                        # Force ParaView to use our color instead of the default theme palette
                        view.UseColorPaletteForBackground = 0
                    except:
                        pass
                    
                    view.Background = rgb
                    print(f"Background changed to: {background_color_hex} -> {rgb}")
                    # Use update_view helper to force the widget to refresh
                    update_view()
            else:
                print("Warning: No view available to change background")
        except Exception as e:
            print(f"Error updating background color: {e}")
    
    @state.change("show_axes")
    def on_show_axes_change(show_axes, **kwargs):
        """Handle axes visibility toggle."""
        try:
            view = pipeline.get('view')
            if view:
                # Try to toggle axes grid
                try:
                    view.AxesGrid.Visibility = bool(show_axes)
                except:
                    pass  # Axes grid might not be available
                state.appearance_update += 1
        except Exception as e:
            print(f"Error updating axes visibility: {e}")
    
    @state.change("show_orientation_axes")
    def on_show_orientation_axes_change(show_orientation_axes, **kwargs):
        """Handle orientation axes (3D axis indicator) visibility."""
        try:
            view = pipeline.get('view')
            if view:
                view.OrientationAxesVisibility = bool(show_orientation_axes)
                state.appearance_update += 1
        except Exception as e:
            print(f"Error updating orientation axes: {e}")
    
    @state.change("show_bounding_box")
    def on_show_bounding_box_change(show_bounding_box, **kwargs):
        """Handle bounding box (outline around data) visibility."""
        try:
            view = pipeline.get('view')
            display = pipeline.get('display')
            if view:
                # Try to toggle center axes visibility (outline around data)
                try:
                    if hasattr(view, 'CenterAxesVisibility'):
                        view.CenterAxesVisibility = bool(show_bounding_box)
                except:
                    pass
                # Also try to toggle the bounds outline on the display
                if display:
                    try:
                        if hasattr(display, 'UseOutline'):
                            display.UseOutline = bool(show_bounding_box)
                    except:
                        pass
                state.appearance_update += 1
        except Exception as e:
            print(f"Error updating bounding box: {e}")
    
    @state.change("show_cube_axes")
    def on_show_cube_axes_change(show_cube_axes, **kwargs):
        """Handle cube axes (grid with labels) visibility."""
        try:
            view = pipeline.get('view')
            if view:
                # Try to toggle cube axes visibility
                try:
                    view.CubeAxesVisibility = bool(show_cube_axes)
                except:
                    # Cube axes might not be available, try AxesGrid
                    try:
                        if hasattr(view, 'AxesGrid'):
                            view.AxesGrid.Visibility = bool(show_cube_axes)
                    except:
                        pass
                state.appearance_update += 1
        except Exception as e:
            print(f"Error updating cube axes: {e}")
    
    @state.change("point_size")
    def on_point_size_change(point_size, **kwargs):
        try:
            display = pipeline.get('display')
            if display:
                display.PointSize = float(point_size)
                state.appearance_update += 1
        except Exception as e:
            print(f"Error updating point size: {e}")
            
    @state.change("line_width")
    def on_line_width_change(line_width, **kwargs):
        try:
            display = pipeline.get('display')
            if display:
                display.LineWidth = float(line_width)
                state.appearance_update += 1
        except Exception as e:
            print(f"Error updating line width: {e}")
            
    @state.change("ambient_light")
    def on_ambient_light_change(ambient_light, **kwargs):
        try:
            display = pipeline.get('display')
            if display:
                display.Ambient = float(ambient_light)
                state.appearance_update += 1
        except Exception as e:
            print(f"Error updating ambient light: {e}")
            
    @state.change("parallel_projection")
    def on_parallel_projection_change(parallel_projection, **kwargs):
        try:
            view = pipeline.get('view')
            if view:
                # Use standard ParaView property for orthographic view
                view.CameraParallelProjection = 1 if parallel_projection else 0
                state.camera_update_counter += 1
                state.appearance_update += 1
        except Exception as e:
            print(f"Error updating projection mode: {e}")
    
    @state.change("current_timestep")
    def on_timestep_change(current_timestep, **kwargs):
        """Handle timestep change for transient data."""
        try:
            source = pipeline.get('source')
            if source and state.has_timesteps and hasattr(source, 'TimestepValues'):
                timesteps = source.TimestepValues
                if timesteps and 0 <= current_timestep < len(timesteps):
                    # Get the view and set the timestep
                    view = pipeline.get('view')
                    if view:
                        view.ViewTime = timesteps[current_timestep]
                        update_view()
        except Exception as e:
            print(f"Error updating timestep: {e}")
    
    @state.change("clip_enabled", "clip_origin_x", "clip_origin_y", "clip_origin_z",
                  "clip_normal_x", "clip_normal_y", "clip_normal_z", "clip_invert")
    def on_clip_change(clip_enabled, clip_origin_x, clip_origin_y, clip_origin_z,
                       clip_normal_x, clip_normal_y, clip_normal_z, clip_invert, **kwargs):
        """Handle clip plane changes."""
        try:
            original_source = pipeline.get('original_source')
            
            if not original_source:
                return
            
            # Remove existing clip if present
            existing_clip = pipeline.get('clip_filter')
            if existing_clip:
                simple.Delete(existing_clip)
                pipeline['clip_filter'] = None
            
            if clip_enabled:
                # Create clip filter
                clip = simple.Clip(Input=original_source)
                clip.ClipType = 'Plane'
                clip.ClipType.Origin = [float(clip_origin_x), float(clip_origin_y), float(clip_origin_z)]
                clip.ClipType.Normal = [float(clip_normal_x), float(clip_normal_y), float(clip_normal_z)]
                clip.Invert = bool(clip_invert)
                
                pipeline['clip_filter'] = clip
                pipeline['source'] = clip
                
                # Show clipped data, hide original
                display = simple.Show(clip)
                simple.Hide(original_source)
                
                # Transfer display properties
                display.Representation = state.representation
                display.Opacity = state.opacity
                
                pipeline['display'] = display
            else:
                # Show original, hide clip
                simple.Show(original_source)
                pipeline['source'] = original_source
                display = simple.GetDisplayProperties(original_source)
                pipeline['display'] = display
            
            update_view()
        except Exception as e:
            print(f"Error updating clip: {e}")
    
    # Define controller methods
    def get_data_bounds():
        """Get the bounds of the current data."""
        try:
            source = pipeline.get('original_source') or pipeline.get('source')
            if source:
                return source.GetDataInformation().GetBounds()
        except:
            pass
        return [-1, 1, -1, 1, -1, 1]  # Default bounds
    
    def calculate_camera_position(view_type, bounds):
        """Calculate camera position based on data bounds."""
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
        
        # Distance factor (multiply by this to get reasonable view)
        distance = diagonal * 1.5
        if distance < 1:
            distance = 5
        
        if view_type == 'isometric':
            # Isometric view: equal angles to all axes
            pos = [cx + distance * 0.7, cy + distance * 0.7, cz + distance * 0.7]
            return pos, [cx, cy, cz], [0, 0, 1]
        elif view_type == 'front':
            # Front view: looking along -Y axis
            return [cx, cy - distance, cz], [cx, cy, cz], [0, 0, 1]
        elif view_type == 'back':
            # Back view: looking along +Y axis
            return [cx, cy + distance, cz], [cx, cy, cz], [0, 0, 1]
        elif view_type == 'left':
            # Left view: looking along +X axis
            return [cx - distance, cy, cz], [cx, cy, cz], [0, 0, 1]
        elif view_type == 'right':
            # Right view: looking along -X axis  
            return [cx + distance, cy, cz], [cx, cy, cz], [0, 0, 1]
        elif view_type == 'top':
            # Top view: looking along -Z axis
            return [cx, cy, cz + distance], [cx, cy, cz], [0, 1, 0]
        elif view_type == 'bottom':
            # Bottom view: looking along +Z axis
            return [cx, cy, cz - distance], [cx, cy, cz], [0, -1, 0]
        
        return [cx + distance, cy, cz], [cx, cy, cz], [0, 0, 1]
    
    @server.controller.add("reset_camera")
    def reset_camera():
        """Reset camera to default position."""
        try:
            view = pipeline.get('view')
            if view:
                simple.ResetCamera(view)
                simple.Render(view)
            # Pass push_camera=True to sync the new camera position to client
            update_view(push_camera=True)
            return True
        except Exception as e:
            print(f"Error resetting camera: {e}")
            return False
    
    @server.controller.add("set_camera_view")
    def set_camera_view(view_type):
        """Set camera to preset view."""
        try:
            view = pipeline.get('view')
            if not view:
                return False
            
            # Get data bounds for proper positioning
            bounds = get_data_bounds()
            
            # Calculate camera position
            position, focal_point, view_up = calculate_camera_position(view_type, bounds)
            
            # Set camera properties on the view proxy directly
            view.CameraPosition = position
            view.CameraFocalPoint = focal_point
            view.CameraViewUp = view_up
            
            # Render to apply changes
            simple.Render(view)
            
            # Pass push_camera=True to sync the new camera position to client
            update_view(push_camera=True)
            
            return True
        except Exception as e:
            print(f"Error setting camera view: {e}")
            return False
    
    @server.controller.add("capture_screenshot")
    def capture_screenshot(filename=None, width=None, height=None, transparent=False):
        """Capture screenshot of current view.
        
        Args:
            filename: Optional filename to save screenshot. If None, returns base64.
            width: Optional width in pixels
            height: Optional height in pixels
            transparent: Whether to use transparent background
            
        Returns:
            dict with 'success', 'data' (base64 or path), 'format'
        """
        try:
            view = pipeline.get('view')
            if not view:
                return {'success': False, 'error': 'No view available'}
            
            # Store original settings
            original_bg = view.Background[:]
            original_size = view.ViewSize[:]
            
            try:
                # Set transparent background if requested
                if transparent:
                    view.Background = [0, 0, 0]
                
                # Set custom resolution if provided
                if width and height:
                    view.ViewSize = [int(width), int(height)]
                
                # Render the view
                simple.Render(view)
                
                # Generate filename if not provided
                if not filename:
                    import tempfile
                    import os
                    fd, filename = tempfile.mkstemp(suffix='.png')
                    os.close(fd)
                
                # Save screenshot
                simple.SaveScreenshot(filename, view, 
                    ImageResolution=view.ViewSize,
                    TransparentBackground=transparent)
                
                # Read file and convert to base64
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
                # Restore original settings
                view.Background = original_bg
                if width and height:
                    view.ViewSize = original_size
                
        except Exception as e:
            print(f"Error capturing screenshot: {e}")
            return {'success': False, 'error': str(e)}
    
    @server.controller.add("toggle_controls")
    def toggle_controls():
        """Toggle control panel visibility."""
        state.show_controls = not state.show_controls
        return state.show_controls
    
    # UI setup
    from trame.ui.vuetify2 import VAppLayout
    from trame.widgets import vuetify2 as vuetify
    from trame.widgets import html
    
    with VAppLayout(server) as layout:
        # Control panel drawer - styled based on theme
        with vuetify.VNavigationDrawer(
            v_model=("show_controls", True),
            app=True,
            width=320,
            clipped=True,
            color=("sidebar_color",),  # Use state variable for theme-aware color
            dark=("sidebar_dark",),  # Use state variable for dark mode
        ):
            with vuetify.VContainer(classes="pa-4"):
                # Header with Hide Button
                with vuetify.VRow(classes="ma-0 mb-2", align="center", justify="space-between"):
                    vuetify.VSubheader("Display Controls", classes="text-h6 pa-0")
                    with vuetify.VBtn(
                        click=toggle_controls,
                        small=True,
                        icon=True
                    ):
                        vuetify.VIcon("mdi-chevron-left")
                vuetify.VDivider(classes="mb-4")
                
                # Opacity Slider
                vuetify.VSlider(
                    label="Opacity",
                    v_model=("opacity", 1.0),
                    min=0,
                    max=1,
                    step=0.05,
                    thumb_label=True,
                    dense=True,
                    classes="mb-4"
                )
                
                # Representation Selector
                vuetify.VSelect(
                    v_model=("representation", "Surface"),
                    items=(['Surface', 'Surface With Edges', 'Wireframe', 'Points'],),
                    label="Representation",
                    dense=True,
                    outlined=True,
                    classes="mb-4"
                )
                
                # Color By Selector
                vuetify.VSelect(
                    v_model=("color_by", "Solid Color"),
                    items=("available_arrays",),
                    label="Color By",
                    dense=True,
                    outlined=True,
                    classes="mb-4"
                )
                
                # Color Map Selector (only shown when coloring by array)
                with vuetify.VContainer(v_if=("color_by !== 'Solid Color'",)):
                    vuetify.VSelect(
                        v_model=("color_map", "Cool to Warm"),
                        items=(COLOR_MAPS,),
                        label="Color Map",
                        dense=True,
                        outlined=True,
                        classes="mb-2"
                    )
                    
                    vuetify.VCheckbox(
                        v_model=("show_scalar_bar", False),
                        label="Show Color Legend",
                        dense=True,
                        classes="mb-4"
                    )
                
                vuetify.VDivider(classes="my-4")
                
                # Clipping Section
                vuetify.VSubheader("Clipping", classes="text-subtitle-1 mb-2")
                
                vuetify.VCheckbox(
                    v_model=("clip_enabled", False),
                    label="Enable Clip Plane",
                    dense=True,
                    classes="mb-2"
                )
                
                with vuetify.VContainer(v_if=("clip_enabled",), classes="pl-4"):
                    vuetify.VSubheader("Origin", classes="text-caption pa-0")
                    with vuetify.VRow(dense=True):
                        with vuetify.VCol(cols=4):
                            vuetify.VTextField(
                                v_model=("clip_origin_x", 0.0),
                                label="X",
                                type="number",
                                dense=True,
                                outlined=True
                            )
                        with vuetify.VCol(cols=4):
                            vuetify.VTextField(
                                v_model=("clip_origin_y", 0.0),
                                label="Y",
                                type="number",
                                dense=True,
                                outlined=True
                            )
                        with vuetify.VCol(cols=4):
                            vuetify.VTextField(
                                v_model=("clip_origin_z", 0.0),
                                label="Z",
                                type="number",
                                dense=True,
                                outlined=True
                            )
                    
                    vuetify.VSubheader("Normal", classes="text-caption pa-0 mt-2")
                    with vuetify.VRow(dense=True):
                        with vuetify.VCol(cols=4):
                            vuetify.VTextField(
                                v_model=("clip_normal_x", 1.0),
                                label="X",
                                type="number",
                                dense=True,
                                outlined=True
                            )
                        with vuetify.VCol(cols=4):
                            vuetify.VTextField(
                                v_model=("clip_normal_y", 0.0),
                                label="Y",
                                type="number",
                                dense=True,
                                outlined=True
                            )
                        with vuetify.VCol(cols=4):
                            vuetify.VTextField(
                                v_model=("clip_normal_z", 0.0),
                                label="Z",
                                type="number",
                                dense=True,
                                outlined=True
                            )
                    
                    vuetify.VCheckbox(
                        v_model=("clip_invert", False),
                        label="Invert Clip",
                        dense=True,
                        classes="mt-2"
                    )
                
                vuetify.VDivider(classes="my-4")
                
                # Camera Section
                vuetify.VSubheader("Camera", classes="text-subtitle-1 mb-2")
                
                with vuetify.VRow(dense=True):
                    with vuetify.VCol(cols=6):
                        vuetify.VBtn(
                            "Reset",
                            click=reset_camera,
                            block=True,
                            small=True,
                            outlined=True,
                            classes="mb-2"
                        )
                    with vuetify.VCol(cols=6):
                        vuetify.VBtn(
                            "Isometric",
                            click=lambda: set_camera_view('isometric'),
                            block=True,
                            small=True,
                            outlined=True,
                            classes="mb-2"
                        )
                
                with vuetify.VRow(dense=True):
                    with vuetify.VCol(cols=4):
                        vuetify.VBtn(
                            "Front",
                            click=lambda: set_camera_view('front'),
                            block=True,
                            small=True,
                            text=True
                        )
                    with vuetify.VCol(cols=4):
                        vuetify.VBtn(
                            "Side",
                            click=lambda: set_camera_view('right'),
                            block=True,
                            small=True,
                            text=True
                        )
                    with vuetify.VCol(cols=4):
                        vuetify.VBtn(
                            "Top",
                            click=lambda: set_camera_view('top'),
                            block=True,
                            small=True,
                            text=True
                        )
                
                vuetify.VDivider(classes="my-4")
                
                # Background Color Picker - using VColorPicker like openmc_geometry_viz.py
                with vuetify.VContainer(classes="ma-0 pa-0 mb-4", style="overflow: hidden;"):
                    vuetify.VColorPicker(
                        v_model=("background_color_hex", "#1a1a26"),
                        hide_inputs=True,
                        hide_mode_switch=True,
                        show_swatches=True,
                        swatches_max_height=100,
                        mode="hexa",
                        elevation=0,
                        classes="ma-0 pa-0",
                        style="background: transparent; max-width: 100%;",
                    )
                
                vuetify.VDivider(classes="my-4")
                
                # Projection Mode
                vuetify.VCheckbox(
                    v_model=("parallel_projection", False),
                    label="Parallel Projection (2D/Ortho)",
                    dense=True,
                    classes="mb-2"
                )
                
                # Detail sliders (Point Size, Line Width, Lighting)
                with vuetify.VRow(dense=True, classes="mt-2"):
                    with vuetify.VCol(cols=12):
                        vuetify.VSlider(
                            v_model=("point_size", 2.0),
                            min=1, max=20, step=0.5,
                            label="Point Size",
                            dense=True, hide_details=True,
                            classes="mb-4"
                        )
                        vuetify.VSlider(
                            v_model=("line_width", 1.0),
                            min=0.5, max=10, step=0.5,
                            label="Line Width",
                            dense=True, hide_details=True,
                            classes="mb-4"
                        )
                        vuetify.VSlider(
                            v_model=("ambient_light", 0.2),
                            min=0, max=1, step=0.05,
                            label="Ambient",
                            dense=True, hide_details=True,
                            classes="mb-4"
                        )
                
                vuetify.VDivider(classes="my-4")
                
                # Orientation Axes Toggle (small XYZ in corner)
                vuetify.VCheckbox(
                    v_model=("show_orientation_axes", True),
                    label="Show 3D Axis Indicator",
                    dense=True,
                    classes="mb-2"
                )
                
                # Bounding Box Toggle (outline around data)
                vuetify.VCheckbox(
                    v_model=("show_bounding_box", False),
                    label="Show Data Bounds Outline",
                    dense=True,
                    classes="mb-2"
                )
                
                # Cube Axes Toggle (grid with labels)
                vuetify.VCheckbox(
                    v_model=("show_cube_axes", False),
                    label="Show Coordinate Grid",
                    dense=True,
                    classes="mb-4"
                )
                
                vuetify.VDivider(classes="my-4")
                
                # Time Navigation Section (for transient data like Cardinal/Exodus)
                with vuetify.VContainer(v_if=("has_timesteps",)):
                    vuetify.VSubheader("Time Navigation", classes="text-subtitle-1 mb-2")
                    
                    with vuetify.VRow(dense=True, align="center"):
                        with vuetify.VCol(cols=3):
                            vuetify.VBtn(
                                "|<<",
                                click=lambda: setattr(state, 'current_timestep', 0),
                                small=True,
                                text=True
                            )
                        with vuetify.VCol(cols=3):
                            vuetify.VBtn(
                                "<",
                                click=lambda: setattr(state, 'current_timestep', max(0, state.current_timestep - 1)),
                                small=True,
                                text=True
                            )
                        with vuetify.VCol(cols=3):
                            vuetify.VBtn(
                                ">",
                                click=lambda: setattr(state, 'current_timestep', min(len(state.timestep_values) - 1, state.current_timestep + 1)),
                                small=True,
                                text=True
                            )
                        with vuetify.VCol(cols=3):
                            vuetify.VBtn(
                                ">>|",
                                click=lambda: setattr(state, 'current_timestep', len(state.timestep_values) - 1),
                                small=True,
                                text=True
                            )
                    
                    vuetify.VSlider(
                        v_model=("current_timestep", 0),
                        min=0,
                        max=("len(timestep_values) - 1",),
                        step=1,
                        thumb_label=True,
                        dense=True,
                        classes="mt-2"
                    )
                    
                    vuetify.VDivider(classes="my-4")
                
                # Screenshot Section
                vuetify.VSubheader("Export", classes="text-subtitle-1 mb-2")
                
                def save_screenshot():
                    """Capture and save screenshot to file."""
                    from datetime import datetime
                    import os
                    
                    # Generate filename with timestamp
                    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                    filename = f"screenshot_{timestamp}.png"
                    filepath = os.path.join(os.getcwd(), filename)
                    
                    result = capture_screenshot(filename=filepath)
                    if result.get('success'):
                        print(f"Screenshot saved: {filepath}")
                        state.screenshot_status = f"Saved: {filename}"
                    else:
                        print(f"Screenshot failed: {result.get('error')}")
                        state.screenshot_status = f"Error: {result.get('error')}"
                
                # Screenshot status message
                state.screenshot_status = ""
                
                vuetify.VBtn(
                    "Save Screenshot",
                    click=save_screenshot,
                    block=True,
                    small=True,
                    color="primary",
                    classes="mb-2"
                )
                
                # Screenshot status display
                with vuetify.VContainer(v_if=("screenshot_status",), classes="text-center"):
                    vuetify.VSubheader(
                        ("screenshot_status",),
                        classes="text-caption justify-center"
                    )
        
        # Main content area
        with vuetify.VMain():
            # Toggle button when controls are hidden
            with vuetify.VContainer(
                v_if=("!show_controls",),
                classes="ma-2 pa-0",
                style="position: absolute; top: 0; left: 0; z-index: 100;"
            ):
                with vuetify.VBtn(
                    click=toggle_controls,
                    small=True,
                    fab=True,
                    color="primary"
                ):
                    vuetify.VIcon("mdi-chevron-right")
            
            # Main visualization view
            view_widget = pv_widgets.VtkRemoteView(
                view,
                interactive_ratio=1,
                style="width: 100%; height: 100%; position: absolute; top: 0; left: 0;",
            )
            
            # Store view_widget reference for updates
            pipeline['view_widget'] = view_widget
            
            # Add view update controller
            @server.controller.add("view_update")
            def view_update():
                view_widget.update()
            
            # Watch for camera update counter changes to force view refresh
            @state.change("camera_update_counter")
            def on_camera_update(camera_update_counter, **kwargs):
                try:
                    # Render the view to ensure camera changes are applied
                    simple.Render(view)
                    # Update the widget to refresh the view
                    view_widget.update()
                except Exception as e:
                    print(f"Warning: camera update failed: {e}")
            
            # Watch for appearance update to force view refresh (background color, etc.)
            @state.change("appearance_update")
            def on_appearance_update(appearance_update, **kwargs):
                try:
                    # Render the view to ensure appearance changes are applied
                    simple.Render(view)
                    # Update the widget to refresh the view
                    view_widget.update()
                    print(f"Appearance update triggered")
                except Exception as e:
                    print(f"Warning: appearance update failed: {e}")
    
    return server, port


def main():
    parser = argparse.ArgumentParser(description='Visualizer visualization server for NukeIDE')
    parser.add_argument('--port', type=int, default=None, help='Port to run server on (auto-detect if not specified)')
    parser.add_argument('--file', type=str, help='File to load (supports VTK formats, STL, PLY, OBJ)')
    parser.add_argument('--host', type=str, default='127.0.0.1', help='Host to report in URL')
    parser.add_argument('--theme', type=str, default='dark', choices=['dark', 'light'], help='UI theme (dark or light)')
    args = parser.parse_args()
    
    print("=" * 60)
    print("NukeIDE Visualizer Server")
    print("=" * 60)
    
    # Check dependencies first
    if not check_dependencies():
        sys.exit(1)
    
    # Find available port if not specified
    port = args.port
    if port is None:
        port = find_free_port()
    
    try:
        server, actual_port = create_app(args.file, port, theme=args.theme)
    except Exception as e:
        print(f"Failed to create application: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    
    # Print startup message for widget to capture
    url = f"http://{args.host}:{port}"
    print("=" * 60)
    print(f"Starting visualizer server on {url}")
    print("=" * 60)
    print(f"Press Ctrl+C to stop")
    print("=" * 60)
    
    try:
        server.start(port=port, host='0.0.0.0', open_browser=False, show_connection_info=False)
    except KeyboardInterrupt:
        print("\nServer stopped by user")
    except Exception as e:
        print(f"Server error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
