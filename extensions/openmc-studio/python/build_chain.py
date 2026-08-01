#!/usr/bin/env python3
"""
OpenMC Depletion Chain Builder

Builds a custom depletion chain XML in one of two modes:

- ``--from-chain PATH``  Subset mode: filter an existing chain XML to a
  nuclide list. Fission-product-yield borrow parents (``parent=`` attributes
  in the source chain) are pulled in automatically — without them the subset
  chain fails to load (openmc.deplete.Nuclide.from_xml validates the
  reference).
- ``--from-endf DIR``    ENDF mode: build from ENDF text sub-library files in
  the official layout (``DIR/decay/``, ``DIR/nfy/``, and ``DIR/neutron/`` or
  ``DIR/neutrons/`` — ENDF-B-VIII vs ENDF-B-VII naming).
  NOTE: OpenMC's Chain.from_endf reads ENDF text files only — incident
  HDF5 data (e.g. U235.h5) carries no decay or fission-yield data and cannot
  be used to build a chain.

Usage:
    python build_chain.py --output PATH (--from-chain SRC | --from-endf DIR) [--nuclides U235,U238]

Progress streams to stderr; exactly one JSON object is printed to stdout.
"""

import argparse
import glob
import json
import sys
import traceback
from pathlib import Path
from xml.etree import ElementTree as ET


def log_progress(message: str):
    """Print progress message to stderr for real-time communication.

    Args:
        message: Progress message to emit.
    """
    print(f"{message}", file=sys.stderr, flush=True)


def _json_safe(obj):
    """Fallback JSON encoder for numpy scalars/arrays (without importing numpy).

    Args:
        obj: Object that failed default JSON serialization.

    Returns:
        A JSON-serializable equivalent.
    """
    if hasattr(obj, "item"):
        return obj.item()
    if hasattr(obj, "tolist"):
        return obj.tolist()
    return str(obj)


def compute_fpy_closure(chain_xml_path, wanted):
    """Compute the nuclide set a subset chain must contain.

    Starts from ``wanted`` and adds fission-product-yield borrow parents
    (``<neutron_fission_yields parent=...>``) recursively, so the exported
    subset chain loads without dangling references. Pure stdlib — no openmc
    import required.

    Args:
        chain_xml_path: Path to the source chain XML.
        wanted: Iterable of nuclide names to include.

    Returns:
        Tuple of (resolved set of nuclide names, sorted list of borrow
        parents that were added).

    Raises:
        ValueError: If a wanted nuclide is not present in the source chain.
    """
    root = ET.parse(chain_xml_path).getroot()
    available = set()
    parents = {}
    for elem in root.iter("nuclide"):
        name = elem.get("name")
        if not name:
            continue
        available.add(name)
        fpy = elem.find("neutron_fission_yields")
        if fpy is not None and fpy.get("parent"):
            parents[name] = fpy.get("parent")

    missing = [n for n in wanted if n not in available]
    if missing:
        raise ValueError(f"Nuclide(s) not present in source chain: {', '.join(sorted(missing))}")

    resolved = set(wanted)
    added = set()
    stack = list(wanted)
    while stack:
        parent = parents.get(stack.pop())
        if parent and parent not in resolved:
            resolved.add(parent)
            added.add(parent)
            stack.append(parent)
    return resolved, sorted(added)


def compute_target_closure(chain, wanted):
    """Extend a nuclide set with decay, reaction, and fission-yield products.

    A subset chain must contain the targets of every decay mode and reaction
    of its nuclides AND every fission product they yield — the depletion
    operator indexes all of them by name and fails on dangling ones. Note
    this means subsets containing fissile nuclides legitimately grow large
    (fission products); the alternative of cutting yields would break yield
    conservation. Works on a loaded openmc.deplete.Chain.

    Args:
        chain: The source openmc.deplete.Chain.
        wanted: Iterable of nuclide names to start from.

    Returns:
        The resolved set of nuclide names.
    """
    by_name = {n.name: n for n in chain.nuclides}
    resolved = set(wanted)
    stack = [n for n in wanted if n in by_name]
    while stack:
        nuc = by_name[stack.pop()]
        targets = [t for _, t, _ in nuc.decay_modes] + [r.target for r in nuc.reactions]
        # Fission-yield borrow parent (from_endf/from_xml mark it as _fpy)
        fpy_parent = getattr(nuc, "_fpy", None)
        if fpy_parent:
            targets.append(fpy_parent)
        if nuc.yield_data is not None:
            targets.extend(nuc.yield_data.products)
        for target in targets:
            if target is not None and target in by_name and target not in resolved:
                resolved.add(target)
                stack.append(target)
    return resolved


def _split_nuclides(raw):
    """Parse a comma/space-separated nuclide list.

    Args:
        raw: The raw --nuclides argument.

    Returns:
        List of trimmed nuclide names (empty list when unset).
    """
    if not raw:
        return []
    return [n.strip() for n in raw.replace(" ", ",").split(",") if n.strip()]


def build_subset(args):
    """Build a subset chain from an existing chain XML.

    Args:
        args: Parsed arguments (from_chain, nuclides, output).

    Returns:
        Result dictionary.
    """
    source = Path(args.from_chain)
    if not source.exists():
        raise FileNotFoundError(f"Source chain not found: {source}")

    import openmc.deplete

    wanted = _split_nuclides(args.nuclides)
    log_progress(f"Loading source chain from {source}")
    chain = openmc.deplete.Chain.from_xml(str(source))
    total = len(chain.nuclides)

    borrow_parents = []
    if wanted:
        resolved, borrow_parents = compute_fpy_closure(str(source), wanted)
        resolved = compute_target_closure(chain, resolved)
        if borrow_parents:
            log_progress(f"Including FPY borrow parents: {', '.join(borrow_parents)}")
        chain.nuclides = [n for n in chain.nuclides if n.name in resolved]
        skipped = total - len(chain.nuclides)
        log_progress(f"Subset: {len(chain.nuclides)} of {total} nuclides kept ({skipped} filtered)")
    else:
        log_progress(f"Keeping all {total} nuclides from the source chain")

    output = Path(args.output).absolute()
    output.parent.mkdir(parents=True, exist_ok=True)
    chain.export_to_xml(str(output))
    log_progress(f"Chain written to {output}")

    return {
        "success": True,
        "mode": "subset",
        "sourceChain": str(source),
        "sourceNuclideCount": total,
        "nuclideCount": len(chain.nuclides),
        "borrowParentsIncluded": borrow_parents,
        "outputPath": str(output),
    }


def build_from_endf(args):
    """Build a chain from ENDF sub-library files.

    Args:
        args: Parsed arguments (from_endf, nuclides, output).

    Returns:
        Result dictionary.

    Raises:
        FileNotFoundError: If the ENDF directory or a required sub-library
            directory is missing.
    """
    endf_dir = Path(args.from_endf)
    if not endf_dir.is_dir():
        raise FileNotFoundError(f"ENDF directory not found: {endf_dir}")

    decay_files = sorted(glob.glob(str(endf_dir / "decay" / "*")))
    fpy_files = sorted(glob.glob(str(endf_dir / "nfy" / "*")))
    # ENDF-B-VII uses neutrons/, ENDF-B-VIII uses neutron/ — accept both
    neutron_files = sorted(glob.glob(str(endf_dir / "neutron" / "*"))) or sorted(
        glob.glob(str(endf_dir / "neutrons" / "*"))
    )
    for kind, files in (("decay", decay_files), ("nfy", fpy_files), ("neutron", neutron_files)):
        if not files:
            raise FileNotFoundError(
                f"No ENDF {kind} files found under {endf_dir} — expected decay/ nfy/ neutron/ or neutrons/ sub-libraries"
            )

    import openmc.deplete

    log_progress(
        f"Building chain from ENDF: {len(decay_files)} decay, {len(fpy_files)} fission-yield, {len(neutron_files)} neutron files"
    )
    chain = openmc.deplete.Chain.from_endf(decay_files, fpy_files, neutron_files, progress=False)

    wanted = _split_nuclides(args.nuclides)
    if wanted:
        available = {n.name for n in chain.nuclides}
        missing = [n for n in wanted if n not in available]
        if missing:
            raise ValueError(f"Nuclide(s) not present in built chain: {', '.join(sorted(missing))}")
        # Same contract as subset mode: keep the chain self-consistent
        resolved = compute_target_closure(chain, wanted)
        chain.nuclides = [n for n in chain.nuclides if n.name in resolved]

    output = Path(args.output).absolute()
    output.parent.mkdir(parents=True, exist_ok=True)
    chain.export_to_xml(str(output))
    log_progress(f"Chain written to {output} ({len(chain.nuclides)} nuclides)")

    return {
        "success": True,
        "mode": "endf",
        "nuclideCount": len(chain.nuclides),
        "outputPath": str(output),
    }


def build_chain(args):
    """Dispatch to the requested builder mode.

    Args:
        args: Parsed command-line arguments.

    Returns:
        Result dictionary.

    Raises:
        ValueError: If the arguments are inconsistent.
    """
    if args.from_chain and args.from_endf:
        raise ValueError("Choose only one of --from-chain and --from-endf")
    if args.from_chain:
        return build_subset(args)
    if args.from_endf:
        return build_from_endf(args)
    raise ValueError("One of --from-chain or --from-endf is required")


def main():
    """Main entry point for CLI usage."""
    parser = argparse.ArgumentParser(
        description="Build a custom OpenMC depletion chain XML",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    python build_chain.py --from-chain chain_casl.xml --nuclides U235,U238 --output small_chain.xml
    python build_chain.py --from-endf /data/ENDF-B-VIII.0 --output full_chain.xml
        """,
    )
    parser.add_argument("--from-chain", help="Source chain XML to subset")
    parser.add_argument(
        "--from-endf", help="ENDF directory with decay/ nfy/ neutron/ sub-libraries"
    )
    parser.add_argument(
        "--nuclides", help="Comma-separated nuclides to include (default: all from source)"
    )
    parser.add_argument("--output", required=True, help="Output chain XML path")

    args = parser.parse_args()

    try:
        result = build_chain(args)
        print(json.dumps(result, default=_json_safe))
        return 0
    except Exception as e:
        log_progress(f"FAILED: {e}")
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"success": False, "error": str(e)}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
