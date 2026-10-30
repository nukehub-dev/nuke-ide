#!/usr/bin/env python3
"""OpenFOAM case scaffolding and region-named STL export for nuke-cad.

Generates a solver-ready OpenFOAM case from a region manifest and optional
mesh, plus per-solid STL exports from a canonical STEP file.  Heavy
dependencies (OCP/build123d) are optional; the module stays importable without
them.

Progress and diagnostics are emitted on stderr; one final JSON object is
printed on stdout (stdout-JSON protocol used across NukeIDE backends).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import traceback
from pathlib import Path
from typing import Any

# Ensure sibling modules are importable when run as a script.
_SCRIPT_DIR = Path(__file__).parent.resolve()
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

# Optional heavy dependencies. The module must remain importable without them.
try:
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.STEPControl import STEPControl_Reader
    from OCP.StlAPI import StlAPI_Writer
    from OCP.TopAbs import TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS
    from ocp_compat import topods_solid

    HAS_OCP = True
except ImportError:
    HAS_OCP = False


def _print_progress(message: str) -> None:
    """Emit a progress line on stderr."""
    print(message, file=sys.stderr, flush=True)


def _require_ocp() -> None:
    """Raise a clear error if OCP is not available."""
    if not HAS_OCP:
        raise RuntimeError("OpenFOAM STL export requires OCP (cadquery-ocp/build123d).")


# ---------------------------------------------------------------------------
# OpenFOAM dictionary templates
# ---------------------------------------------------------------------------


_DEFAULT_SOLVERS: dict[str, dict[str, Any]] = {
    "icoFoam": {
        "application": "icoFoam",
        "turbulenceModel": "laminar",
        "transport": {"nu": 1e-06},
    },
    "simpleFoam": {
        "application": "simpleFoam",
        "turbulenceModel": "kEpsilon",
        "transport": {"nu": 1e-05},
    },
    "buoyantBoussinesqSimpleFoam": {
        "application": "buoyantBoussinesqSimpleFoam",
        "turbulenceModel": "kEpsilon",
        "transport": {"nu": 1e-05, "beta": 3e-03, "TRef": 300.0, "Pr": 0.71},
    },
    "chtMultiRegionSimpleFoam": {
        "application": "chtMultiRegionSimpleFoam",
        "turbulenceModel": "kEpsilon",
        "transport": {"nu": 1e-05, "Pr": 0.71},
    },
}


def _solver_default(solver: str) -> dict[str, Any]:
    """Return default settings for a known solver, or a generic incompressible setup."""
    return _DEFAULT_SOLVERS.get(
        solver, {"application": solver, "turbulenceModel": "laminar", "transport": {"nu": 1e-06}}
    )


def _write_control_dict(case_dir: Path, settings: dict[str, Any]) -> None:
    """Write ``system/controlDict``."""
    system_dir = case_dir / "system"
    system_dir.mkdir(parents=True, exist_ok=True)
    application = settings.get("application", "icoFoam")
    start_time = settings.get("startTime", 0)
    end_time = settings.get("endTime", 100)
    delta_t = settings.get("deltaT", 0.005)
    write_control = settings.get("writeControl", "timeStep")
    write_interval = settings.get("writeInterval", 20)
    purge_write = settings.get("purgeWrite", 0)
    content = f"""/*--------------------------------*- C++ -*----------------------------------*\\
  =========                 |
  \\\\      /  F ield         | OpenFOAM: The Open Source CFD Toolbox
   \\\\    /   O peration     | Website:  https://openfoam.org
    \\\\  /    A nd           | Version:  compatible
     \\\\/     M anipulation  |
\\*---------------------------------------------------------------------------*/
FoamFile
{{
    version     2.0;
    format      ascii;
    class       dictionary;
    location    "system";
    object      controlDict;
}}
// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //

application     {application};

startFrom       startTime;

startTime       {start_time};

stopAt          endTime;

endTime         {end_time};

deltaT          {delta_t};

writeControl    {write_control};

writeInterval   {write_interval};

purgeWrite      {purge_write};

writeFormat     ascii;

writePrecision  6;

writeCompression off;

timeFormat      general;

timePrecision   6;

runTimeModifiable true;

// ************************************************************************* //
"""
    (system_dir / "controlDict").write_text(content, encoding="utf-8")


def _write_fv_schemes(case_dir: Path) -> None:
    """Write a conservative default ``system/fvSchemes``."""
    system_dir = case_dir / "system"
    system_dir.mkdir(parents=True, exist_ok=True)
    content = """/*--------------------------------*- C++ -*----------------------------------*\\
  =========                 |
  \\\\      /  F ield         | OpenFOAM: The Open Source CFD Toolbox
   \\\\    /   O peration     | Website:  https://openfoam.org
    \\\\  /    A nd           | Version:  compatible
     \\\\/     M anipulation  |
\\*---------------------------------------------------------------------------*/
FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    location    "system";
    object      fvSchemes;
}
// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //

ddtSchemes
{
    default         steadyState;
}

gradSchemes
{
    default         Gauss linear;
    grad(p)         Gauss linear;
    grad(U)         cellLimited Gauss linear 1;
}

divSchemes
{
    default         none;
    div(phi,U)      bounded Gauss upwind;
    div(phi,k)      bounded Gauss upwind;
    div(phi,epsilon) bounded Gauss upwind;
    div((nuEff*dev2(T(grad(U))))) Gauss linear;
}

laplacianSchemes
{
    default         Gauss linear corrected;
}

interpolationSchemes
{
    default         linear;
}

snGradSchemes
{
    default         corrected;
}

wallDist
{
    method          meshWave;
}

// ************************************************************************* //
"""
    (system_dir / "fvSchemes").write_text(content, encoding="utf-8")


def _write_fv_solution(case_dir: Path, solver: str) -> None:
    """Write ``system/fvSolution`` with solver-appropriate linear settings."""
    system_dir = case_dir / "system"
    system_dir.mkdir(parents=True, exist_ok=True)
    is_simple = "simple" in solver.lower()
    n_correctors = 2 if is_simple else 1
    content = f"""/*--------------------------------*- C++ -*----------------------------------*\\
  =========                 |
  \\\\      /  F ield         | OpenFOAM: The Open Source CFD Toolbox
   \\\\    /   O peration     | Website:  https://openfoam.org
    \\\\  /    A nd           | Version:  compatible
     \\\\/     M anipulation  |
\\*---------------------------------------------------------------------------*/
FoamFile
{{
    version     2.0;
    format      ascii;
    class       dictionary;
    location    "system";
    object      fvSolution;
}}
// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //

solvers
{{
    p
    {{
        solver          GAMG;
        tolerance       1e-07;
        relTol          0.1;
        smoother        GaussSeidel;
        nPreSweeps      0;
        nPostSweeps     2;
        cacheAgglomeration on;
        agglomerator    faceAreaPair;
        nCellsInCoarsestLevel 100;
        mergeLevels     1;
    }}

    U
    {{
        solver          smoothSolver;
        smoother        symGaussSeidel;
        tolerance       1e-08;
        relTol          0.1;
    }}

    k
    {{
        solver          smoothSolver;
        smoother        symGaussSeidel;
        tolerance       1e-08;
        relTol          0.1;
    }}

    epsilon
    {{
        solver          smoothSolver;
        smoother        symGaussSeidel;
        tolerance       1e-08;
        relTol          0.1;
    }}
}}

SIMPLE
{{
    nNonOrthogonalCorrectors {n_correctors};
    residualControl
    {{
        p               1e-6;
        U               1e-6;
    }}
}}

relaxationFactors
{{
    fields
    {{
        p               0.3;
    }}
    equations
    {{
        U               0.7;
        k               0.7;
        epsilon         0.7;
    }}
}}

// ************************************************************************* //
"""
    (system_dir / "fvSolution").write_text(content, encoding="utf-8")


def _write_transport_properties(case_dir: Path, transport: dict[str, Any]) -> None:
    """Write ``constant/transportProperties`` for incompressible solvers."""
    constant_dir = case_dir / "constant"
    constant_dir.mkdir(parents=True, exist_ok=True)
    lines = [
        "    nu              nu [ 0 2 -1 0 0 0 0 ] {nu};".format(nu=transport.get("nu", 1e-06))
    ]
    if "beta" in transport:
        lines.append(
            "    beta            beta [ 0 0 0 -1 0 0 0 ] {beta};".format(beta=transport["beta"])
        )
    if "TRef" in transport:
        lines.append(
            "    TRef            TRef [ 0 0 0 1 0 0 0 ] {tref};".format(tref=transport["TRef"])
        )
    if "Pr" in transport:
        lines.append("    Pr              Pr [ 0 0 0 0 0 0 0 ] {pr};".format(pr=transport["Pr"]))
    content = (
        """/*--------------------------------*- C++ -*----------------------------------*\\
  =========                 |
  \\\\      /  F ield         | OpenFOAM: The Open Source CFD Toolbox
   \\\\    /   O peration     | Website:  https://openfoam.org
    \\\\  /    A nd           | Version:  compatible
     \\\\/     M anipulation  |
\\*---------------------------------------------------------------------------*/
FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    location    "constant";
    object      transportProperties;
}
// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //

transportModel  Newtonian;

"""
        + "\n".join(lines)
        + """

// ************************************************************************* //
"""
    )
    (constant_dir / "transportProperties").write_text(content, encoding="utf-8")


def _boundary_entries(boundaries: list[dict[str, Any]]) -> str:
    """Build the boundaryField block for an OpenFOAM field file."""
    entries: list[str] = []
    for bc in boundaries:
        name = bc.get("name", "patch")
        bctype = bc.get("type", "patch")
        entries.append(f"    {name}")
        entries.append("    {")
        entries.append(f"        type            {bctype};")
        value = bc.get("value")
        if value is not None:
            entries.append(f"        value           uniform {value};")
        entries.append("    }")
    return "\n".join(entries)


def _write_field_file(
    case_dir: Path,
    field: str,
    dimensions: str,
    internal_value: str,
    boundaries: list[dict[str, Any]],
) -> None:
    """Write a field file under ``0/``."""
    zero_dir = case_dir / "0"
    zero_dir.mkdir(parents=True, exist_ok=True)
    boundary_block = _boundary_entries(boundaries)
    content = f"""/*--------------------------------*- C++ -*----------------------------------*\\
  =========                 |
  \\\\      /  F ield         | OpenFOAM: The Open Source CFD Toolbox
   \\\\    /   O peration     | Website:  https://openfoam.org
    \\\\  /    A nd           | Version:  compatible
     \\\\/     M anipulation  |
\\*---------------------------------------------------------------------------*/
FoamFile
{{
    version     2.0;
    format      ascii;
    class       volScalarField;
    location    "0";
    object      {field};
}}
// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //

dimensions      {dimensions};

internalField   uniform {internal_value};

boundaryField
{{
{boundary_block}
}}

// ************************************************************************* //
"""
    (zero_dir / field).write_text(content, encoding="utf-8")


def _write_vector_field_file(
    case_dir: Path,
    field: str,
    dimensions: str,
    internal_value: str,
    boundaries: list[dict[str, Any]],
) -> None:
    """Write a vector field file under ``0/``."""
    zero_dir = case_dir / "0"
    zero_dir.mkdir(parents=True, exist_ok=True)
    entries: list[str] = []
    for bc in boundaries:
        name = bc.get("name", "patch")
        bctype = bc.get("type", "fixedValue")
        value = bc.get("value")
        entries.append(f"    {name}")
        entries.append("    {")
        entries.append(f"        type            {bctype};")
        if value is not None:
            entries.append(f"        value           uniform {value};")
        entries.append("    }")
    boundary_block = "\n".join(entries)
    content = f"""/*--------------------------------*- C++ -*----------------------------------*\\
  =========                 |
  \\\\      /  F ield         | OpenFOAM: The Open Source CFD Toolbox
   \\\\    /   O peration     | Website:  https://openfoam.org
    \\\\  /    A nd           | Version:  compatible
     \\\\/     M anipulation  |
\\*---------------------------------------------------------------------------*/
FoamFile
{{
    version     2.0;
    format      ascii;
    class       volVectorField;
    location    "0";
    object      {field};
}}
// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //

dimensions      {dimensions};

internalField   uniform {internal_value};

boundaryField
{{
{boundary_block}
}}

// ************************************************************************* //
"""
    (zero_dir / field).write_text(content, encoding="utf-8")


# ---------------------------------------------------------------------------
# Case scaffolding
# ---------------------------------------------------------------------------


def build_case(request: dict[str, Any]) -> dict[str, Any]:
    """Create an OpenFOAM case directory from a declarative request.

    Request fields:
        caseDir (str): directory to scaffold.
        solver (str): OpenFOAM solver name (icoFoam, simpleFoam, ...).
        settings (dict): controlDict overrides.
        boundaries (list): boundary conditions with name/type/value.
        writeFields (list): which fields to create (U, p, T).
        meshPath (str | None): optional mesh to copy/link into constant/polyMesh.
    """
    case_dir = Path(request.get("caseDir", os.getcwd())).resolve()
    case_dir.mkdir(parents=True, exist_ok=True)

    solver = request.get("solver", "icoFoam")
    settings = request.get("settings") or {}
    boundaries = request.get("boundaries") or []
    write_fields = request.get("writeFields") or ["U", "p"]
    mesh_path = request.get("meshPath")

    defaults = _solver_default(solver)
    merged_settings = {**defaults, **settings, "application": solver}

    _print_progress(f"Scaffolding OpenFOAM case for {solver} in {case_dir}")
    _write_control_dict(case_dir, merged_settings)
    _write_fv_schemes(case_dir)
    _write_fv_solution(case_dir, solver)
    _write_transport_properties(case_dir, defaults["transport"])

    # Default boundary definitions for the generic patches if none supplied.
    wall_boundaries = [b for b in boundaries if b.get("name")]
    if not wall_boundaries:
        wall_boundaries = [{"name": "walls", "type": "wall", "value": None}]

    if "U" in write_fields:
        # Default inlet velocity if a boundary named 'inlet' exists.
        u_boundaries = []
        for bc in wall_boundaries:
            name = bc.get("name", "patch")
            bctype = bc.get("type", "fixedValue")
            value = bc.get("value", "(0 0 0)")
            if bctype == "inlet":
                bctype = "fixedValue"
            elif bctype == "outlet":
                bctype = "zeroGradient"
            elif bctype == "wall":
                bctype = "noSlip"
            u_boundaries.append({"name": name, "type": bctype, "value": value})
        _write_vector_field_file(case_dir, "U", "[0 1 -1 0 0 0 0]", "(0 0 0)", u_boundaries)

    if "p" in write_fields:
        p_boundaries = []
        for bc in wall_boundaries:
            name = bc.get("name", "patch")
            bctype = bc.get("type", "fixedValue")
            value = bc.get("value", "0")
            if bctype == "inlet":
                bctype = "zeroGradient"
            elif bctype == "outlet":
                bctype = "fixedValue"
                value = "0"
            elif bctype == "wall":
                bctype = "zeroGradient"
            p_boundaries.append({"name": name, "type": bctype, "value": value})
        _write_field_file(case_dir, "p", "[0 2 -2 0 0 0 0]", "0", p_boundaries)

    if "T" in write_fields:
        t_boundaries = []
        for bc in wall_boundaries:
            name = bc.get("name", "patch")
            bctype = bc.get("type", "fixedValue")
            value = bc.get("value", "300")
            if bctype == "inlet":
                bctype = "fixedValue"
            elif bctype == "outlet":
                bctype = "zeroGradient"
            elif bctype == "wall":
                bctype = "zeroGradient"
            t_boundaries.append({"name": name, "type": bctype, "value": value})
        _write_field_file(case_dir, "T", "[0 0 0 1 0 0 0]", "300", t_boundaries)

    if mesh_path:
        mesh_src = Path(mesh_path).resolve()
        if mesh_src.is_dir():
            import shutil

            poly_mesh_dst = case_dir / "constant" / "polyMesh"
            if poly_mesh_dst.exists():
                shutil.rmtree(poly_mesh_dst)
            shutil.copytree(mesh_src, poly_mesh_dst)
            _print_progress(f"Copied mesh from {mesh_src}")
        else:
            _print_progress(f"Mesh path {mesh_path} is not a directory; skipping copy")

    return {
        "success": True,
        "caseDir": str(case_dir),
        "solver": solver,
        "files": sorted(str(p.relative_to(case_dir)) for p in case_dir.rglob("*") if p.is_file()),
    }


# ---------------------------------------------------------------------------
# STL export
# ---------------------------------------------------------------------------


def _shape_from_step(step_path: str) -> Any:
    """Load a STEP file and return the root TopoDS_Shape."""
    path = Path(step_path)
    reader = STEPControl_Reader()
    status = reader.ReadFile(str(path))
    if status != IFSelect_RetDone:
        raise RuntimeError(f"STEP reader returned status {status} for {path}")
    reader.TransferRoots()
    return reader.OneShape()


def _sanitize_stl_name(name: Any, fallback: str) -> str:
    """Make a solid name safe to use as an STL file name.

    Strips path separators, whitespace, and anything outside
    ``[A-Za-z0-9._-]`` so region names cannot escape the output directory.
    """
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", str(name)).strip("._")
    return cleaned or fallback


def export_stl(request: dict[str, Any]) -> dict[str, Any]:
    """Export one STL file per solid from a STEP file.

    Request fields:
        stepPath (str): source STEP file.
        outputDir (str): directory for STL files.
        names (dict[int, str] | None): optional id -> name map; default is solid_N.
        linearDeflection (float): tessellation quality.
        angularDeflection (float): tessellation quality.
    """
    step_path = request.get("stepPath", "")
    if not Path(step_path).is_file():
        return {"success": False, "error": f"STEP file not found: {step_path}"}

    try:
        _require_ocp()
    except RuntimeError as exc:
        return {"success": False, "error": str(exc)}

    output_dir = Path(request.get("outputDir", os.getcwd())).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    names = request.get("names") or {}
    linear_deflection = float(request.get("linearDeflection", 0.1))
    angular_deflection = float(request.get("angularDeflection", 0.5))

    try:
        shape = _shape_from_step(step_path)
    except RuntimeError as exc:
        return {"success": False, "error": str(exc)}
    BRepMesh_IncrementalMesh(shape, linear_deflection, False, angular_deflection, True)

    writer = StlAPI_Writer()
    writer.ASCIIMode = False

    explorer = TopExp_Explorer(shape, TopAbs_SOLID)
    stl_files: list[str] = []
    solid_index = 0
    while explorer.More():
        solid_index += 1
        solid = topods_solid(TopoDS, explorer.Current())
        raw_name = names.get(str(solid_index), names.get(solid_index, f"solid_{solid_index}"))
        name = _sanitize_stl_name(raw_name, f"solid_{solid_index}")
        stl_path = output_dir / f"{name}.stl"
        if not writer.Write(solid, str(stl_path)):
            return {
                "success": False,
                "error": f"Failed to write STL for solid '{raw_name}' to {stl_path}",
            }
        stl_files.append(str(stl_path))
        explorer.Next()

    if not stl_files:
        return {"success": False, "error": f"No solids found in STEP file: {step_path}"}

    return {
        "success": True,
        "outputDir": str(output_dir),
        "stlFiles": stl_files,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> int:
    """CLI entry point for OpenFOAM scaffolding and STL export."""
    parser = argparse.ArgumentParser(description="OpenFOAM case scaffolding for nuke-cad.")
    parser.add_argument("--request", required=True, help="Path to JSON request file.")
    args = parser.parse_args()

    request_path = Path(args.request).resolve()
    try:
        with open(request_path, encoding="utf-8") as f:
            request = json.load(f)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"success": False, "error": f"Invalid request file: {exc}"}))
        return 1

    operation = request.get("operation", "buildCase")
    try:
        if operation == "buildCase":
            result = build_case(request)
        elif operation == "exportStl":
            result = export_stl(request)
        elif operation == "listSolvers":
            result = {"success": True, "solvers": sorted(_DEFAULT_SOLVERS.keys())}
        else:
            result = {"success": False, "error": f"Unknown operation: {operation}"}
    except Exception as exc:  # noqa: BLE001
        _print_progress(traceback.format_exc())
        result = {"success": False, "error": str(exc)}

    print(json.dumps(result))
    return 0 if result.get("success") else 1


if __name__ == "__main__":
    sys.exit(main())
