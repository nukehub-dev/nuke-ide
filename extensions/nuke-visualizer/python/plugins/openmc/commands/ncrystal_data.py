"""NCrystal inspection commands (read-only).

- ``openmc.ncrystal-materials [--dir PATH]`` — list installed ``.ncmat``
  materials. Default: the NCrystal standard data library via
  ``NCrystal.datasrc.browseFiles()`` (respecting custom search directories);
  with ``--dir`` the given directory is scanned for ``.ncmat`` files instead.
- ``openmc.ncrystal-info <cfg-or-file>`` — detail for one material:
  phases, atom composition, temperature, density, structure info.
- ``openmc.ncrystal-xs <cfg> [--emin E] [--emax E] [--points N]`` — sampled
  scatter + absorption cross sections (``crossSectionIsotropic``) at
  log-spaced energies, as JSON arrays. No matplotlib anywhere.

Verified against NCrystal 4.3.4: cfg strings carry all parameters (temp,
dcutoff, mosaicity, ...) — see ``NCrystal.createInfo/createScatter``.
Heavy imports (NCrystal, numpy-only is fine) stay lazy and after validation.
"""

import json
import os

import numpy as np
from nuke_viz.plugin import arg, command


def _require_ncrystal():
    """Import NCrystal lazily, with a clear actionable error."""
    try:
        import NCrystal

        return NCrystal
    except ImportError:
        raise RuntimeError(  # noqa: B904
            "ncrystal not installed (required for NCrystal data inspection)"
        )


def _looks_like_file(cfg_or_file: str) -> bool:
    """True when the argument is a path to an existing file rather than a cfg string."""
    return os.path.isfile(cfg_or_file)


def read_ncrystal_materials(directory=None):
    """List available .ncmat materials.

    Without ``directory``, uses NCrystal's own file browser (standard data
    library plus any registered custom search dirs). With ``directory``,
    scans that directory for ``*.ncmat`` files.
    """
    if directory is not None:
        if not os.path.isdir(directory):
            raise FileNotFoundError(f"Directory not found: {directory}")
        names = sorted(f for f in os.listdir(directory) if f.endswith(".ncmat"))
        return {
            "success": True,
            "source": os.path.abspath(directory),
            "materialCount": len(names),
            "materials": [{"name": name, "cfg": name} for name in names],
        }

    _require_ncrystal()
    from NCrystal.datasrc import browseFiles

    materials = [
        {"name": entry.name, "cfg": entry.name, "source": entry.factName}
        for entry in browseFiles()
        if entry.name.endswith(".ncmat")
    ]
    materials.sort(key=lambda m: m["name"])
    return {
        "success": True,
        "source": "NCrystal data library",
        "materialCount": len(materials),
        "materials": materials,
    }


def _composition_entry(fraction, atom_info):
    """Flatten an NCrystal composition entry to JSON-safe values.

    Entry shape is (fraction, "Al=Al(...)") — the second element's repr is the
    descriptive string; its label before '=' is the element symbol.
    """
    text = str(atom_info)
    element = text.split("=", 1)[0]
    return {"element": element, "fraction": float(fraction), "label": text}


def read_ncrystal_info(cfg_or_file):
    """Detail for one NCrystal material (cfg string or .ncmat file path)."""
    if not _looks_like_file(cfg_or_file) and not cfg_or_file.strip():
        raise ValueError("Empty NCrystal cfg string")

    NC = _require_ncrystal()
    info = NC.createInfo(cfg_or_file)

    phases = []
    for fraction, phase_info in info.getPhases():
        composition = [_composition_entry(f, a) for f, a in phase_info.getComposition()]
        phases.append({"fraction": float(fraction), "composition": composition})

    structure = None
    structure_info = info.getStructureInfo()
    if structure_info is not None:
        structure = {key: float(value) for key, value in structure_info.items()}

    return {
        "success": True,
        "cfg": cfg_or_file,
        "temperature": float(info.getTemperature()),
        "density": float(info.getDensity()),
        "composition": [_composition_entry(f, a) for f, a in info.getComposition()],
        "phases": phases,
        "structure": structure,
    }


def read_ncrystal_xs(cfg, emin=1e-5, emax=1e7, points=200):
    """Sample scatter + absorption cross sections for a cfg string.

    Energies are log-spaced in eV; cross sections in barns. Uses
    ``crossSectionIsotropic`` (the non-deprecated orientation-averaged API).
    """
    if not cfg or not cfg.strip():
        raise ValueError("Empty NCrystal cfg string")
    if not 0 < emin < emax:
        raise ValueError(f"Invalid energy range: emin={emin}, emax={emax}")
    if not 2 <= points <= 10000:
        raise ValueError(f"points must be between 2 and 10000, got {points}")

    NC = _require_ncrystal()
    scatter = NC.createScatter(cfg)
    absorption = NC.createAbsorption(cfg)

    energies = np.logspace(np.log10(emin), np.log10(emax), int(points))
    return {
        "success": True,
        "cfg": cfg,
        "energies": energies.tolist(),
        "scatter": [float(v) for v in scatter.crossSectionIsotropic(energies)],
        "absorption": [float(v) for v in absorption.crossSectionIsotropic(energies)],
    }


def _emit(result):
    print(json.dumps(result))
    return 0


def _emit_error(e):
    print(json.dumps({"success": False, "error": str(e)}))
    return 1


@command("openmc.ncrystal-materials", help="List installed NCrystal .ncmat materials")
@arg(
    "--dir",
    dest="directory",
    help="Scan this directory for .ncmat files instead of the NCrystal data library",
)
def cmd_ncrystal_materials(args):
    """List available NCrystal materials."""
    try:
        return _emit(read_ncrystal_materials(args.directory))
    except Exception as e:
        return _emit_error(e)


@command("openmc.ncrystal-info", help="Detail for one NCrystal material")
@arg("cfg", help="NCrystal cfg string or path to a .ncmat file")
def cmd_ncrystal_info(args):
    """Report phases/composition/temperature/density for one material."""
    try:
        return _emit(read_ncrystal_info(args.cfg))
    except Exception as e:
        return _emit_error(e)


@command("openmc.ncrystal-xs", help="Sample scatter + absorption cross sections")
@arg("cfg", help="NCrystal cfg string (e.g. 'Al_sg225.ncmat;temp=300K')")
@arg("--emin", type=float, default=1e-5, help="Minimum energy [eV] (default 1e-5)")
@arg("--emax", type=float, default=1e7, help="Maximum energy [eV] (default 1e7)")
@arg("--points", type=int, default=200, help="Number of log-spaced points (default 200)")
def cmd_ncrystal_xs(args):
    """Sample cross-section curves for one material."""
    try:
        return _emit(read_ncrystal_xs(args.cfg, args.emin, args.emax, args.points))
    except Exception as e:
        return _emit_error(e)
