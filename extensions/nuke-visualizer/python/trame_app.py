#!/usr/bin/env python3
"""
Trame visualization server for NukeIDE.
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


def create_app(file_path=None, port=None):
    """Create trame application with optional file loading."""
    
    # Import trame modules
    try:
        from trame.app import get_server
        from trame.ui.vuetify2 import SinglePageLayout
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
    
    # Create visualization pipeline - ensure offscreen rendering
    display = simple.Show(reader)
    view = simple.GetActiveViewOrCreate('RenderView')
    view.Background = [0.1, 0.1, 0.15]  # Dark background
    
    simple.ResetCamera()
    
    # UI setup
    with SinglePageLayout(server) as layout:
        layout.title.set_text(f"NukeIDE - {title}")
        
        # Hide the default footer (Powered by trame)
        layout.footer.hide()
        
        with layout.content:
            # Main visualization view - uses remote rendering
            view_widget = pv_widgets.VtkRemoteView(
                view,
                interactive_ratio=1,
                style="width: 100%; height: 100%; position: absolute; top: 0; left: 0;",
            )
    
    return server, port


def main():
    parser = argparse.ArgumentParser(description='Trame visualization server for NukeIDE')
    parser.add_argument('--port', type=int, default=None, help='Port to run server on (auto-detect if not specified)')
    parser.add_argument('--file', type=str, help='File to load (supports VTK formats, STL, PLY, OBJ)')
    parser.add_argument('--host', type=str, default='localhost', help='Host to bind to')
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
        server, actual_port = create_app(args.file, port)
    except Exception as e:
        print(f"Failed to create application: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    
    # Print startup message for widget to capture
    url = f"http://{args.host}:{port}"
    print("=" * 60)
    print(f"Starting trame server on {url}")
    print("=" * 60)
    print(f"Press Ctrl+C to stop")
    print("=" * 60)
    
    try:
        server.start(port=args.port, host=args.host, open_browser=False, show_connection_info=False)
    except KeyboardInterrupt:
        print("\nServer stopped by user")
    except Exception as e:
        print(f"Server error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
