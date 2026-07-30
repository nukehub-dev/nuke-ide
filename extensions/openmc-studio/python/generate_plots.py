#!/usr/bin/env python3
"""OpenMC Native Plot Generator.

Builds plots.xml from plot configuration JSON, runs ``openmc -p`` to render
the plots, optionally converts voxel HDF5 output to VTK, and prints exactly
one JSON result object to stdout. Progress is streamed to stderr.

Usage:
    python generate_plots.py <working_directory> --plots-config PATH [--convert-vtk]

Options:
    --plots-config PATH       Path to a JSON file with plot configurations (required)
    --convert-vtk             Convert voxel .h5 output to .vti via openmc.voxel_to_vtk
"""

import argparse
import json
import os
import sys
import traceback
from pathlib import Path


def log_progress(message: str):
    """Print a progress message to stderr for real-time communication.

    Args:
        message: Progress message to emit.
    """
    print(f"{message}", file=sys.stderr, flush=True)


def _load_domains(config, geometry, materials):
    """Resolve domain IDs to geometry objects for wireframe plots.

    Args:
        config: Plot configuration dict with ``wireframeIds`` and ``colorBy``.
        geometry: Loaded openmc.Geometry.
        materials: Loaded openmc.Materials.

    Returns:
        List of openmc.Cell or openmc.Material domain objects.
    """
    import openmc

    ids = config.get("wireframeIds") or []
    color_by = config.get("colorBy", "cell")
    domains = []
    if color_by == "material":
        materials_by_id = {m.id: m for m in materials}
        domains = [materials_by_id[i] for i in ids if i in materials_by_id]
    else:
        cells = geometry.get_all_cells()
        domains = [cells[i] for i in ids if i in cells]
    if len(domains) != len(ids):
        # Fall back to throw-away domains carrying just the IDs so export works
        cls = openmc.Material if color_by == "material" else openmc.Cell
        domains = [cls(i) for i in ids]
    return domains


def build_plot(config, geometry, materials):
    """Build an openmc plot object from a plot configuration dict.

    Args:
        config: Plot configuration dict (see OpenMCPlotConfig in the TypeScript schema).
        geometry: Loaded openmc.Geometry (for wireframe domains).
        materials: Loaded openmc.Materials (for wireframe domains).

    Returns:
        An openmc.SlicePlot, openmc.VoxelPlot, openmc.SolidRayTracePlot, or
        openmc.WireframeRayTracePlot instance.
    """
    import openmc

    plot_type = config["type"]
    plot_id = int(config["id"])
    color_by = config.get("colorBy", "cell")
    if color_by not in ("cell", "material"):
        color_by = "material"

    if plot_type == "slice":
        plot = openmc.SlicePlot(plot_id=plot_id, name=config.get("name", ""))
        plot.basis = config.get("basis", "xy")
        plot.origin = tuple(config.get("origin", [0, 0, 0]))
        width = config.get("width", 10)
        height = config.get("height", width)
        plot.width = (width, height)
        plot.pixels = tuple(config.get("pixels", [1000, 1000]))
    elif plot_type == "voxel":
        plot = openmc.VoxelPlot(plot_id=plot_id, name=config.get("name", ""))
        lower_left = config.get("lowerLeft")
        upper_right = config.get("upperRight")
        if lower_left and upper_right:
            plot.origin = tuple(
                (ll + ur) / 2 for ll, ur in zip(lower_left, upper_right, strict=True)
            )
            plot.width = tuple(ur - ll for ll, ur in zip(lower_left, upper_right, strict=True))
        else:
            plot.origin = tuple(config.get("origin", [0, 0, 0]))
            plot.width = (10, 10, 10)
        plot.pixels = tuple(config.get("voxels", [50, 50, 50]))
    elif plot_type == "solid-raytrace":
        plot = openmc.SolidRayTracePlot(plot_id=plot_id, name=config.get("name", ""))
        plot.pixels = tuple(config.get("pixels", [1000, 1000]))
        if config.get("lightPosition"):
            plot.light_position = tuple(config["lightPosition"])
        if config.get("diffuseFraction") is not None:
            plot.diffuse_fraction = float(config["diffuseFraction"])
        plot.opaque_domains = config.get("opaqueIds") or []
    elif plot_type == "wireframe-raytrace":
        plot = openmc.WireframeRayTracePlot(plot_id=plot_id, name=config.get("name", ""))
        plot.pixels = tuple(config.get("pixels", [1000, 1000]))
        plot.wireframe_thickness = int(config.get("wireframeThickness", 1))
        if config.get("wireframeColor"):
            plot.wireframe_color = tuple(int(c) for c in config["wireframeColor"])
        if config.get("wireframeIds"):
            plot.wireframe_domains = _load_domains(config, geometry, materials)
    else:
        raise ValueError(f"Unknown plot type: {plot_type}")

    if plot_type in ("solid-raytrace", "wireframe-raytrace"):
        plot.camera_position = tuple(config.get("cameraPosition", [1, 0, 0]))
        plot.look_at = tuple(config.get("lookAt", [0, 0, 0]))
        if config.get("up"):
            plot.up = tuple(config["up"])
        plot.horizontal_field_of_view = float(config.get("horizontalFieldOfView", 70))
        if config.get("orthographicWidth"):
            plot.orthographic_width = float(config["orthographicWidth"])

    plot.color_by = color_by
    # Explicit output filenames so the generated files are predictable
    suffix = ".h5" if plot_type == "voxel" else ".png"
    plot.filename = f"plot_{plot_id}{suffix}"

    return plot


def run_generate_plots(args):
    """Build plots.xml, run OpenMC in plotting mode, and collect outputs.

    Args:
        args: Parsed command-line arguments.

    Returns:
        Dictionary with the list of generated files.
    """
    import openmc

    working_dir = Path(args.working_directory).absolute()
    os.chdir(working_dir)

    configs = json.loads(Path(args.plots_config).read_text())
    if not isinstance(configs, list) or len(configs) == 0:
        raise ValueError("Plot configuration file must contain a non-empty JSON array")

    log_progress(f"Loading geometry for domain resolution from {working_dir}")
    materials = openmc.Materials.from_xml("materials.xml")
    geometry = openmc.Geometry.from_xml("geometry.xml", materials)

    plots = [build_plot(config, geometry, materials) for config in configs]

    log_progress(f"Exporting plots.xml with {len(plots)} plot(s)")
    openmc.Plots(plots).export_to_xml()

    log_progress("Running OpenMC in plotting mode (openmc -p)...")
    openmc.plot_geometry(cwd=working_dir)

    files = []
    for config in configs:
        plot_id = int(config["id"])
        plot_type = config["type"]
        if plot_type == "voxel":
            h5_path = working_dir / f"plot_{plot_id}.h5"
            if h5_path.exists():
                files.append(
                    {"plotId": plot_id, "type": plot_type, "path": str(h5_path), "kind": "h5"}
                )
                if args.convert_vtk:
                    vti_path = working_dir / f"plot_{plot_id}.vti"
                    log_progress(f"Converting {h5_path.name} to {vti_path.name}")
                    openmc.voxel_to_vtk(h5_path, output=vti_path)
                    if vti_path.exists():
                        files.append(
                            {
                                "plotId": plot_id,
                                "type": plot_type,
                                "path": str(vti_path),
                                "kind": "vti",
                            }
                        )
        else:
            png_path = working_dir / f"plot_{plot_id}.png"
            if png_path.exists():
                files.append(
                    {"plotId": plot_id, "type": plot_type, "path": str(png_path), "kind": "png"}
                )

    log_progress(f"Generated {len(files)} file(s)")
    return {"success": True, "files": files}


def main():
    """Entry point: parse arguments, generate plots, print JSON result."""
    parser = argparse.ArgumentParser(description="OpenMC native plot generator")
    parser.add_argument("working_directory", help="Directory containing the model XML files")
    parser.add_argument(
        "--plots-config", required=True, help="Path to a JSON file with plot configurations"
    )
    parser.add_argument(
        "--convert-vtk", action="store_true", help="Convert voxel .h5 output to .vti"
    )

    args = parser.parse_args()

    if not Path(args.working_directory).is_dir():
        print(
            json.dumps(
                {
                    "success": False,
                    "error": f"Working directory not found: {args.working_directory}",
                }
            )
        )
        sys.exit(0)

    if not Path(args.plots_config).is_file():
        print(
            json.dumps(
                {"success": False, "error": f"Plots config file not found: {args.plots_config}"}
            )
        )
        sys.exit(0)

    try:
        result = run_generate_plots(args)
        print(json.dumps(result))
    except ImportError as e:
        print(
            json.dumps(
                {"success": False, "error": f"Missing dependency: {e}. Please install openmc."}
            )
        )
        sys.exit(0)
    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"success": False, "error": str(e), "traceback": traceback.format_exc()}))
        sys.exit(0)


if __name__ == "__main__":
    main()
