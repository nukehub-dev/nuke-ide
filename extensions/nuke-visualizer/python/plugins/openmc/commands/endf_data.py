"""ENDF library inspection commands (read-only).

- ``openmc.endf-evaluations <dir>`` — scan an ENDF library directory: which
  sub-libraries are present (decay / nfy / sfy / neutrons) and, per
  sub-library, the nuclides covered, parsed from the ZA-coded filenames
  (``n-001_H_001.endf``, ``dec-092_U_235.endf``, ``nfy-092_U_235.endf``,
  ``sfy-092_U_238.endf``) — no file parsing.
- ``openmc.endf-detail <file>`` — detail for one evaluation, dispatched on
  the filename prefix:
    - ``dec-*``: decay modes, half-life (seconds + years), branching ratios
      (``openmc.data.decay.Decay.from_endf``).
    - ``nfy-*`` / ``sfy-*``: yield energies and the top-N fission products at
      the first energy (``openmc.data.FissionProductYields.from_endf``).
    - ``n-*`` (or any other file): cheap MF/MT section scan of the ENDF text
      records (~0.4 s — a full ``endf.Material`` parse of a big evaluation
      takes seconds and warns on unsupported sections), with reaction labels
      from ``openmc.data.REACTION_NAME``.

Heavy imports (openmc.data) stay lazy and after validation.
"""

import json
import os
import re

from nuke_viz.plugin import arg, command

# Sub-directory name -> kind. 'kind' decides the detail parser.
_SUBLIBRARIES = {
    "neutrons": "neutron",
    "decay": "decay",
    "nfy": "nfy",
    "sfy": "sfy",
    "deuterons": "neutron",
    "gammas": "neutron",
    "helium3s": "neutron",
    "alphas": "neutron",
    "tritons": "neutron",
    "photoat": "photoatomic",
    "atomic_relax": "photoatomic",
    "electrons": "electroatomic",
}

# Filename prefixes per sub-library kind
_PREFIXES = {"neutron": "n", "decay": "dec", "nfy": "nfy", "sfy": "sfy"}

_FILENAME_RE = re.compile(r"^(?P<prefix>[a-z]+)-(?P<z>\d+)_(?P<sym>[A-Za-z]+)_(?P<a>\d+)\.endf$")

# Natural-element pseudo masses from filenames map to A=0 (gnds_name(Z, 0))
_NATURAL_MASS = {"000"}


def _scan_sublibrary(dir_path, sublib_name):
    """List nuclide files in one sub-library directory."""
    kind = _SUBLIBRARIES.get(sublib_name)
    if kind is None:
        return None
    prefix = _PREFIXES.get(kind, sublib_name.rstrip("s"))
    nuclides = []
    for filename in sorted(os.listdir(dir_path)):
        match = _FILENAME_RE.match(filename)
        if not match or match.group("prefix") != prefix:
            continue
        z = int(match.group("z"))
        mass = match.group("a")
        a = 0 if mass in _NATURAL_MASS else int(mass)
        nuclides.append(
            {
                "file": os.path.join(dir_path, filename),
                "z": z,
                "a": a,
                "element": match.group("sym"),
                "name": f"{match.group('sym')}{a}",
            }
        )
    nuclides.sort(key=lambda n: (n["z"], n["a"]))
    return nuclides


def read_endf_evaluations(directory):
    """Scan an ENDF library directory for sub-libraries and nuclides.

    Raises FileNotFoundError when the directory does not exist,
    ValueError when it holds no recognized sub-libraries.
    """
    if not os.path.isdir(directory):
        raise FileNotFoundError(f"Directory not found: {directory}")

    sublibraries = []
    for name in sorted(os.listdir(directory)):
        sub_path = os.path.join(directory, name)
        if not os.path.isdir(sub_path):
            continue
        nuclides = _scan_sublibrary(sub_path, name)
        if nuclides:
            sublibraries.append(
                {
                    "name": name,
                    "kind": _SUBLIBRARIES[name],
                    "nuclideCount": len(nuclides),
                    "nuclides": nuclides,
                }
            )

    if not sublibraries:
        raise ValueError(f"No ENDF sub-libraries (decay/nfy/sfy/neutrons) found in {directory}")

    return {
        "success": True,
        "libraryPath": os.path.abspath(directory),
        "sublibraries": sublibraries,
    }


def _parse_endf_float(text):
    """Parse an ENDF-format float (' 9.223500+4' — no 'E' in the exponent)."""
    text = text.strip()
    # Insert 'E' before the exponent sign (the last +/- that is followed by digits only)
    match = re.match(r"^(?P<mant>[+-]?\d*\.?\d*)(?P<esign>[+-])(?P<exp>\d+)$", text)
    if match:
        return float(f"{match.group('mant')}E{match.group('esign')}{match.group('exp')}")
    return float(text)


def _reaction_names():
    """MT → label map from openmc.data when available, empty dict otherwise."""
    try:
        import openmc.data

        return openmc.data.REACTION_NAME
    except ImportError:
        return {}


def _scan_neutron_detail(path):
    """Cheap MF/MT section scan of an ENDF evaluation (text records only)."""
    sections = set()
    za = None
    with open(path) as f:
        for line in f:
            if len(line) < 75:
                continue
            try:
                mf = int(line[70:72])
                mt = int(line[72:75])
            except ValueError:
                continue
            if za is None and mf == 1 and mt == 451:
                try:
                    za = _parse_endf_float(line[:11])
                except ValueError:
                    pass
            if mt > 0:
                sections.add((mf, mt))

    reaction_names = _reaction_names()
    reactions = [
        {
            "mf": mf,
            "mt": mt,
            "label": reaction_names.get(mt, f"MT {mt}") if mf == 3 else f"MF{mf} MT{mt}",
        }
        for mf, mt in sorted(sections)
    ]
    return {
        "za": int(za) if za is not None else None,
        "sectionCount": len(sections),
        "reactions": reactions,
    }


def _ufloat_pair(value):
    return float(getattr(value, "nominal_value", value)), float(getattr(value, "std_dev", 0.0))


_SECONDS_PER_YEAR = 365.25 * 24 * 3600


def _scan_decay_detail(path):
    """Decay modes, half-life, branching ratios via openmc.data.decay."""
    from openmc.data.decay import Decay

    decay = Decay.from_endf(path)
    half_life = None
    if decay.half_life is not None:
        mean, std = _ufloat_pair(decay.half_life)
        half_life = {"seconds": mean, "secondsStdDev": std, "years": mean / _SECONDS_PER_YEAR}

    modes = []
    for mode in decay.modes:
        branching, branching_std = _ufloat_pair(mode.branching_ratio)
        modes.append(
            {
                "modes": list(mode.modes),
                "daughter": mode.daughter,
                "branchingRatio": branching,
                "branchingStdDev": branching_std,
            }
        )

    return {
        "nuclide": decay.nuclide.get("name")
        if isinstance(decay.nuclide, dict)
        else str(decay.nuclide),
        "halfLife": half_life,
        "modes": modes,
        "stable": bool(decay.nuclide.get("stable", False))
        if isinstance(decay.nuclide, dict)
        else False,
    }


def _scan_fpy_detail(path, top_n=25):
    """Yield energies and top products via openmc.data.FissionProductYields."""
    from openmc.data import FissionProductYields

    fpy = FissionProductYields.from_endf(path)
    nuclide = fpy.nuclide.get("name") if isinstance(fpy.nuclide, dict) else str(fpy.nuclide)

    energy_entries = []
    for energy, yields in zip(fpy.energies, fpy.independent, strict=True):
        items = sorted(
            yields.items(),
            key=lambda kv: -float(getattr(kv[1], "nominal_value", kv[1])),
        )
        total = sum(float(getattr(v, "nominal_value", v)) for v in yields.values())
        top = [
            {
                "nuclide": name,
                "yield": float(getattr(value, "nominal_value", value)),
                "yieldStdDev": float(getattr(value, "std_dev", 0.0)),
            }
            for name, value in items[:top_n]
        ]
        energy_entries.append(
            {
                "energy": float(energy),
                "productCount": len(yields),
                "totalYield": total,
                "topProducts": top,
            }
        )

    return {
        "nuclide": nuclide,
        "energyCount": len(energy_entries),
        "energies": energy_entries,
    }


def read_endf_detail(path, top_n=25):
    """Detail for one ENDF evaluation file, dispatched on the filename prefix.

    Raises FileNotFoundError when the file is missing, ValueError when the
    file cannot be classified or parsed.
    """
    if not os.path.isfile(path):
        raise FileNotFoundError(f"File not found: {path}")

    filename = os.path.basename(path)
    match = _FILENAME_RE.match(filename)
    prefix = match.group("prefix") if match else None

    if prefix == "dec":
        kind = "decay"
        detail = _scan_decay_detail(path)
    elif prefix in ("nfy", "sfy"):
        kind = prefix
        detail = _scan_fpy_detail(path, top_n=top_n)
    else:
        kind = "neutron"
        detail = _scan_neutron_detail(path)

    return {"success": True, "file": path, "kind": kind, **detail}


def _emit(result):
    print(json.dumps(result))
    return 0


def _emit_error(e):
    print(json.dumps({"success": False, "error": str(e)}))
    return 1


@command("openmc.endf-evaluations", help="Scan an ENDF library directory")
@arg("directory", help="Path to the ENDF library root (contains decay/, nfy/, neutrons/, ...)")
def cmd_endf_evaluations(args):
    """List sub-libraries and nuclides of an ENDF library."""
    try:
        return _emit(read_endf_evaluations(args.directory))
    except Exception as e:
        return _emit_error(e)


@command("openmc.endf-detail", help="Detail for one ENDF evaluation file")
@arg("file", help="Path to the .endf evaluation file")
@arg("--top", type=int, default=25, help="Top N fission products per energy (default 25)")
def cmd_endf_detail(args):
    """Report decay / fission-yield / reaction detail for one evaluation."""
    try:
        return _emit(read_endf_detail(args.file, top_n=args.top))
    except Exception as e:
        return _emit_error(e)
