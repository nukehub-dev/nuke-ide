"""
Depletion result commands.
"""

import json

from nuke_viz.plugin import arg, command


@command("openmc.depletion-summary", help="Get depletion summary")
@arg("file", help="Path to depletion_results.h5")
def cmd_depletion_summary(args):
    """Get summary of depletion results."""
    try:
        from plugins.openmc.lib.reader import OpenMCDepletionReader

        reader = OpenMCDepletionReader()
        summary = reader.load_summary(args.file)
        print(json.dumps(summary))
        return 0
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        return 1


@command("openmc.depletion-materials", help="List materials in depletion results")
@arg("file", help="Path to depletion_results.h5")
def cmd_depletion_materials(args):
    """List materials in depletion results."""
    try:
        from plugins.openmc.lib.reader import OpenMCDepletionReader

        reader = OpenMCDepletionReader()
        materials = reader.list_materials(args.file)
        print(json.dumps({"materials": materials}))
        return 0
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        return 1


@command("openmc.depletion-data", help="Get depletion data for material")
@arg("file", help="Path to depletion_results.h5")
@arg("material_index", type=int, help="Material index")
@arg("--nuclides", help="Comma-separated nuclide list")
def cmd_depletion_data(args):
    """Get depletion data for a specific material."""
    try:
        from plugins.openmc.lib.reader import OpenMCDepletionReader

        reader = OpenMCDepletionReader()

        nuclide_filter = None
        if args.nuclides:
            nuclide_filter = [n.strip() for n in args.nuclides.split(",")]

        data = reader.load_material_data(args.file, args.material_index, nuclide_filter)
        summary = reader.load_summary(args.file)

        print(json.dumps({"summary": summary, "materialData": data}))
        return 0
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        return 1


@command(
    "openmc.depletion-contact-dose",
    help="Photon contact dose rate for an activated material",
)
@arg("file", help="Path to depletion_results.h5")
@arg("material_index", type=int, help="Material index")
@arg(
    "--dose-quantity",
    choices=["absorbed-air", "effective"],
    default="absorbed-air",
    help="Dose quantity (absorbed-air Gy/h or effective Sv/h)",
)
@arg("--build-up", type=float, default=2.0, help="Photon build-up factor (default 2.0)")
@arg("--by-nuclide", action="store_true", help="Include per-nuclide contributions")
@arg("--chain-file", help="Depletion chain XML (default OPENMC_CHAIN_FILE)")
def cmd_depletion_contact_dose(args):
    """Compute contact dose rates for a material over every depletion state."""
    try:
        from plugins.openmc.lib.depletion_analysis import (
            depletion_results,
            summarize_contact_dose,
        )

        with depletion_results(args.file, args.chain_file) as (results, _chain):
            payload = summarize_contact_dose(
                results,
                args.material_index,
                dose_quantity=args.dose_quantity,
                build_up=args.build_up,
                by_nuclide=args.by_nuclide,
            )
        payload["file"] = args.file
        print(json.dumps(payload))
        return 0
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        return 1


@command(
    "openmc.depletion-decay-spectrum",
    help="Decay-photon spectrum for an activated material at one time step",
)
@arg("file", help="Path to depletion_results.h5")
@arg("material_index", type=int, help="Material index")
@arg("time_index", type=int, help="Depletion time index")
@arg("--chain-file", help="Depletion chain XML (default OPENMC_CHAIN_FILE)")
def cmd_depletion_decay_spectrum(args):
    """Return decay-photon lines and continuous components for plotting/CSV."""
    try:
        from plugins.openmc.lib.depletion_analysis import (
            depletion_results,
            summarize_decay_spectrum,
        )

        with depletion_results(args.file, args.chain_file) as (results, _chain):
            payload = summarize_decay_spectrum(results, args.material_index, args.time_index)
        payload["file"] = args.file
        print(json.dumps(payload))
        return 0
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        return 1
