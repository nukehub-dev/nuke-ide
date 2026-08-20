// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
// 1. Redistributions of source code must retain the above copyright notice,
//    this list of conditions and the following disclaimer.
//
// 2. Redistributions in binary form must reproduce the above copyright notice,
//    this list of conditions and the following disclaimer in the documentation
//    and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
// ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
// LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
// CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
// SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
// INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
// CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
// ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
// POSSIBILITY OF SUCH DAMAGE.
// SPDX-License-Identifier: BSD-2-Clause
// *****************************************************************************

/**
 * JSON-RPC protocol shared between the nuke-cad frontend and backend.
 *
 * @module nuke-cad/common
 */

export const NukeCadBackendServicePath = '/services/nuke-cad';

export const NukeCadBackendService = Symbol('NukeCadBackendService');

/** Axis-aligned bounding box returned by the geometry service. */
export interface CadBoundingBox {
    readonly min: number[];
    readonly max: number[];
}

/** Mesh quality report returned by the meshing service. */
export interface MeshQualityReport {
    readonly elementCount: number;
    readonly nodeCount: number;
    readonly elementTypes: Record<string, number>;
    readonly blocks: { readonly name: string; readonly elementCount: number; readonly dimension: number }[];
    readonly sidesets?: { readonly name: string; readonly elementCount: number }[];
    readonly quality: {
        readonly minDihedralDeg: number;
        readonly maxDihedralDeg: number;
        readonly minAspectRatio: number;
        readonly maxAspectRatio: number;
        readonly meanAspectRatio: number;
    };
}

/** Built-in or custom material definition for a FEM analysis. */
export interface FemMaterial {
    readonly name: string;
    readonly youngsModulus?: number;
    readonly poissonsRatio?: number;
    readonly density?: number;
    readonly conductivity?: number;
    readonly expansion?: number;
}

/** Boundary condition applied to a named surface set. */
export interface FemBoundaryCondition {
    readonly id: string;
    readonly type: 'fixed' | 'displacement' | 'pressure' | 'temperature' | 'heatFlux';
    readonly surfaceName: string;
    readonly magnitude?: number;
    readonly vector?: number[];
    readonly temperature?: number;
}

/** Settings for the CalculiX analysis step. */
export interface FemStepSettings {
    readonly stepType: 'static' | 'heatTransfer' | 'frequency';
    readonly time?: number;
    readonly initialTimeIncrement?: number;
    readonly gravity?: {
        readonly magnitude: number;
        readonly vector: number[];
    };
}

/** Request to set up and optionally run a CalculiX FEM analysis. */
export interface FemRunRequest {
    /** Absolute path to the gmsh .msh file. */
    readonly mshPath: string;
    /** Material assignment for each mesh block name. */
    readonly materials: Record<string, string | FemMaterial>;
    /** Boundary conditions applied to named surface sets. */
    readonly boundaryConditions: FemBoundaryCondition[];
    /** Analysis step settings. */
    readonly step: FemStepSettings;
    /** Whether to run ccx after writing the input deck. */
    readonly run?: boolean;
    /** Optional explicit path to the ccx executable. */
    readonly ccxPath?: string;
    /**
     * Optional caller-chosen job id for cancellation via {@link NukeCadBackendService.cancelJob}.
     * The backend generates one when omitted and echoes it back on the result.
     */
    readonly jobId?: string;
    /** Optional backend process timeout in seconds (kills the ccx process tree); the backend default applies when omitted. */
    readonly processTimeoutSeconds?: number;
}

/** Result of a CalculiX FEM setup/run request. */
export interface FemRunResult {
    readonly success: boolean;
    readonly error?: string;
    /** Job id under which the backend ran (or is still running) this request; pass it to {@link NukeCadBackendService.cancelJob}. */
    readonly jobId?: string;
    readonly inpPath?: string;
    readonly frdPath?: string;
    readonly datPath?: string;
    readonly vtkPath?: string;
    readonly logPath?: string;
    readonly stdout?: string;
    readonly stderr?: string;
    readonly warnings?: string[];
}

/** Declarative job request for the generic run-layer. */
export interface JobRunRequest {
    /** Absolute path to the working directory (created if missing). */
    readonly workingDirectory: string;
    /** Command and arguments to execute. */
    readonly command: string[];
    /** Optional extra environment variables. */
    readonly env?: Record<string, string>;
    /** Glob patterns for output files to report back. */
    readonly artifacts?: string[];
    /** Optional timeout in seconds (enforced inside the job runner). */
    readonly timeout?: number;
    /** Optional path to tee stdout/stderr into. */
    readonly logFile?: string;
    /**
     * Optional caller-chosen job id for cancellation via {@link NukeCadBackendService.cancelJob}.
     * The backend generates one when omitted and echoes it back on the result.
     */
    readonly jobId?: string;
    /** Optional backend process timeout in seconds (kills the job process tree); the backend default applies when omitted. */
    readonly processTimeoutSeconds?: number;
}

/** Result of a generic job run. */
export interface JobRunResult {
    readonly success: boolean;
    readonly error?: string;
    /** Job id under which the backend ran (or is still running) this request; pass it to {@link NukeCadBackendService.cancelJob}. */
    readonly jobId?: string;
    readonly exitCode?: number | null;
    readonly artifacts: string[];
    readonly logFile?: string;
    readonly stdout?: string;
    readonly stderr?: string;
}

/** OpenFOAM boundary condition entry. */
export interface FoamBoundaryCondition {
    readonly name: string;
    readonly type: 'inlet' | 'outlet' | 'wall' | 'symmetry' | 'patch' | string;
    readonly value?: string;
}

/** Request to scaffold an OpenFOAM case. */
export interface FoamCaseRequest {
    /** Absolute path to the case directory to create. */
    readonly caseDir: string;
    /** OpenFOAM solver application (icoFoam, simpleFoam, ...). */
    readonly solver: string;
    /** Optional controlDict overrides. */
    readonly settings?: Record<string, unknown>;
    /** Boundary conditions for the field files. */
    readonly boundaries?: FoamBoundaryCondition[];
    /** Fields to create (U, p, T). Defaults to [U, p]. */
    readonly writeFields?: string[];
    /** Optional path to a polyMesh directory to copy into constant/polyMesh. */
    readonly meshPath?: string;
}

/** Result of an OpenFOAM case scaffolding request. */
export interface FoamCaseResult {
    readonly success: boolean;
    readonly error?: string;
    readonly caseDir: string;
    readonly solver: string;
    readonly files: string[];
}

/** Request to export per-solid STL files from a STEP file. */
export interface FoamStlExportRequest {
    /** Absolute path to the source STEP file. */
    readonly stepPath: string;
    /** Absolute path to the output directory. */
    readonly outputDir: string;
    /** Optional 1-based solid index -> name map. */
    readonly names?: Record<string, string>;
    readonly linearDeflection?: number;
    readonly angularDeflection?: number;
}

/** Result of a per-solid STL export. */
export interface FoamStlExportResult {
    readonly success: boolean;
    readonly error?: string;
    readonly outputDir: string;
    readonly stlFiles: string[];
}

/** Status of a single feature in a document build result. */
export type FeatureResultStatus = 'built' | 'failed' | 'stale';

/** Per-feature result returned by a document build. */
export interface FeatureResult {
    /** Feature id from the document feature tree. */
    readonly featureId: string;
    /** Build status of the feature. */
    readonly status: FeatureResultStatus;
    /** Human-readable error message when ``status`` is ``failed``. */
    readonly error?: string;
}

/** Status of a single topological reference resolution. */
export type ReferenceResolutionStatus = 'matched' | 'ambiguous' | 'unmatched';

/** A candidate offered for an ambiguous reference repair. */
export interface ReferenceResolutionCandidate {
    /** Stable candidate id from the rebuilt B-rep (e.g. ``face_0003``). */
    readonly candidateId: string;
    /** Similarity score in [0, 1]. */
    readonly score: number;
}

/** Per-reference resolution status returned by a document build. */
export interface ReferenceResolutionResult {
    /** Feature id that owns the reference (datum, sketch, or feature). */
    readonly featureId: string;
    /** Document path of the reference (e.g. ``datum.d1.reference``). */
    readonly path: string;
    /** Topological kind being resolved. */
    readonly kind: 'face' | 'edge';
    /** Resolution status. */
    readonly status: ReferenceResolutionStatus;
    /** Matched candidate id when ``status`` is ``matched``. */
    readonly candidateId?: string;
    /** Best similarity score in [0, 1]. */
    readonly score?: number;
    /** Score of the next-best candidate; meaningful when ``status`` is ``ambiguous``. */
    readonly runnerUpScore?: number;
    /** Top candidates when ``status`` is ``ambiguous`` (sorted by descending score). */
    readonly candidates?: ReferenceResolutionCandidate[];
}

/** Result of a geometry build request. */
export interface GeometryBuildResult {
    /** Whether the build succeeded. */
    readonly success: boolean;
    /** Human-readable error message when ``success`` is false. */
    readonly error?: string;
    /** Full traceback when available. */
    readonly traceback?: string;
    /** Absolute path to the source script. */
    readonly scriptPath?: string;
    /** Absolute path to the output directory. */
    readonly outputDirectory?: string;
    /** Absolute path to the generated STEP file. */
    readonly stepPath?: string;
    /** Absolute path to the generated tessellation stream. */
    readonly tessPath?: string;
    /** Number of solid volumes in the model. */
    readonly solidCount?: number;
    /** Total number of faces across all solids. */
    readonly faceCount?: number;
    /** Total number of triangles in the tessellation. */
    readonly triangleCount?: number;
    /** Model bounding box. */
    readonly boundingBox?: CadBoundingBox;
    /** Diagnostics and non-fatal issues. */
    readonly warnings?: string[];
    /** Region manifest payload when one exists and is valid. */
    readonly regionManifest?: RegionManifestData;
    /** Mapping of selector -> 1-based solid indices. */
    readonly selectorMap?: Record<string, number[]>;
    /** Per-feature build status for document builds. */
    readonly featureResults?: FeatureResult[];
    /** Per-reference resolution status for document builds with TopologyRefs. */
    readonly referenceResults?: ReferenceResolutionResult[];
    /**
     * Projected construction primitives for sketches that declare externalRefs.
     * Keyed by sketch id; primitives carry ``construction: true`` and are already
     * expressed in the sketch's local coordinate system.
     */
    readonly projectedPrimitives?: Record<string, Record<string, unknown>[]>;
    /** Absolute path to the generated DAGMC .h5m file. */
    readonly dagmcPath?: string;
    /** Whether the DAGMC export succeeded (non-fatal if false). */
    readonly dagmcSuccess?: boolean;
    /** DAGMC export warnings. */
    readonly dagmcWarnings?: string[];
    /** DAGMC export error when dagmcSuccess is false. */
    readonly dagmcError?: string;
    /** Absolute path to the generated gmsh native mesh. */
    readonly meshPath?: string;
    /** Absolute path to the generated ExodusII mesh. */
    readonly exodusPath?: string;
    /** Absolute path to the generated CalculiX/Abaqus input. */
    readonly inpPath?: string;
    /** Absolute path to the generated VTK unstructured grid. */
    readonly vtkPath?: string;
    /** Absolute path to the generated mesh quality report. */
    readonly meshReportPath?: string;
    /** Whether the FEM mesh export succeeded (non-fatal if false). */
    readonly meshSuccess?: boolean;
    /** FEM mesh export warnings. */
    readonly meshWarnings?: string[];
    /** FEM mesh export error when meshSuccess is false. */
    readonly meshError?: string;
    /** FEM mesh quality report. */
    readonly meshReport?: MeshQualityReport;
    /** Captured stderr/stdout from the geometry service. */
    output?: string;
}

/** Request to build/update geometry from a script or STEP file. */
export interface GeometryBuildRequest {
    /** Absolute path to the build123d/CadQuery script or STEP file. */
    readonly scriptPath: string;
    /** Source type; defaults to ``script``. Use ``step`` for existing STEP files. */
    readonly sourceType?: 'script' | 'step';
    /** Optional output directory; defaults to the source file's directory. */
    readonly outputDirectory?: string;
    /** BRepMesh faceting tolerance. */
    readonly tolerance?: number;
    /** Whether to export DAGMC .h5m (default true for script builds; STEP imports default to false for fast viewport load). */
    readonly exportDagmc?: boolean;
    /** Whether to export FEM volume meshes (default true for script builds; STEP imports default to false). */
    readonly exportMesh?: boolean;
    /** Meshing engine: ``gmsh`` or ``netgen``. */
    readonly meshEngine?: string;
    /** Global target element size for the volume mesh. */
    readonly meshSize?: number;
    /** Minimum element size for the volume mesh. */
    readonly meshMinSize?: number;
    /** Maximum element size for the volume mesh. */
    readonly meshMaxSize?: number;
    /** Element order (1 = linear, 2 = quadratic). */
    readonly meshOrder?: number;
    /**
     * Length scale applied to exported mesh vertices.
     * Default 1.0 (model units are cm); use 0.01 to convert cm to m for
     * transport solvers that expect meters.
     */
    readonly lengthScale?: number;
}

/** Request to build geometry from a ``.nuke-cad`` document. */
export interface BuildDocumentRequest {
    /** Absolute path to the ``.nuke-cad`` document (carried in ``scriptPath`` for service dispatch). */
    readonly scriptPath: string;
    /** Optional output directory; defaults to the document file's directory. */
    readonly outputDirectory?: string;
    /** BRepMesh faceting tolerance. */
    readonly tolerance?: number;
    /** Whether to export DAGMC .h5m (default true). */
    readonly exportDagmc?: boolean;
    /** Whether to export FEM volume meshes (default true). */
    readonly exportMesh?: boolean;
    /** Meshing engine: ``gmsh`` or ``netgen``. */
    readonly meshEngine?: string;
    /** Global target element size for the volume mesh. */
    readonly meshSize?: number;
    /** Minimum element size for the volume mesh. */
    readonly meshMinSize?: number;
    /** Maximum element size for the volume mesh. */
    readonly meshMaxSize?: number;
    /** Element order (1 = linear, 2 = quadratic). */
    readonly meshOrder?: number;
    /**
     * Length scale applied to exported mesh vertices.
     * Default 1.0 (model units are cm); use 0.01 to convert cm to m for
     * transport solvers that expect meters.
     */
    readonly lengthScale?: number;
}

/** Single volume entry in the region manifest. */
export interface RegionManifestVolume {
    readonly selector: string;
    readonly name?: string;
    readonly material?: string;
    readonly tags?: string[];
    /** Optional per-region target element size for meshing. */
    readonly meshSize?: number;
}

/** Single surface entry in the region manifest. */
export interface RegionManifestSurface {
    readonly selector: string;
    readonly name?: string;
    readonly role?: string;
}

/** Region manifest payload. */
export interface RegionManifestData {
    readonly version: number;
    readonly volumes: RegionManifestVolume[];
    readonly surfaces: RegionManifestSurface[];
}

/** Backend service exposed via JSON-RPC. */
export interface NukeCadBackendService {
    /**
     * Build/update geometry from a script and return artifact paths + metadata.
     */
    buildGeometry(request: GeometryBuildRequest): Promise<GeometryBuildResult>;

    /**
     * Build/update geometry from a ``.nuke-cad`` document.
     *
     * The request's ``scriptPath`` carries the absolute path to the document;
     * this keeps the service dispatch identical to ``buildGeometry`` while the
     * backend passes ``--from-document`` to the geometry service.
     */
    buildDocument(request: BuildDocumentRequest): Promise<GeometryBuildResult>;

    /**
     * Set up and optionally run a CalculiX FEM analysis from a gmsh mesh.
     */
    runFem(request: FemRunRequest): Promise<FemRunResult>;

    /**
     * Return the built-in FEM material database.
     */
    listFemMaterials(): Promise<FemMaterial[]>;

    /**
     * Run a generic declarative job through the nuke-cad run-layer.
     */
    runJob(request: JobRunRequest): Promise<JobRunResult>;

    /**
     * Cancel a running job started via {@link runFem} or {@link runJob}.
     *
     * Stop contract for the panels: pass a `jobId` on the request (or read the
     * one echoed back on the result) and call this RPC with it. The backend
     * kills the job's whole process tree (ccx, gmsh, ...) and the pending call
     * resolves with `success: false` and a cancellation error.
     *
     * @param jobId - The job id from the request/result
     * @returns Whether a running job with that id was found and signalled
     */
    cancelJob(jobId: string): Promise<boolean>;

    /**
     * Scaffold a new OpenFOAM case directory.
     */
    buildFoamCase(request: FoamCaseRequest): Promise<FoamCaseResult>;

    /**
     * Export per-solid STL files from a STEP file for OpenFOAM patch geometry.
     */
    exportFoamStl(request: FoamStlExportRequest): Promise<FoamStlExportResult>;

    /**
     * Return the built-in set of OpenFOAM solver templates.
     */
    listFoamSolvers(): Promise<string[]>;

    /**
     * Check whether the active Python environment has the CAD toolchain.
     * `missing` lists absent required packages; `missingOptional` lists absent
     * optional packages (missing optionals never block `ready`).
     */
    checkCadEnvironment(): Promise<{ readonly ready: boolean; readonly missing: string[]; readonly missingOptional: string[] }>;
}
