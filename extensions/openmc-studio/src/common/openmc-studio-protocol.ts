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
 * OpenMC Studio Protocol
 *
 * Defines the JSON-RPC protocol for communication between the frontend
 * (TypeScript) and backend (Node.js/Python) of the OpenMC Studio extension.
 *
 * @module openmc-studio/common
 */

import {
    OpenMCState,
    OpenMCProjectFile,
    OpenMCProjectTemplate,
    OpenMCSurface,
    OpenMCCell,
    OpenMCPlotConfig,
    OpenMCTransferRate,
    OpenMCCmfdSettings,
    OPENMC_STATE_SCHEMA_VERSION,
    DAGMCInfo
} from './openmc-state-schema';

export { OPENMC_STATE_SCHEMA_VERSION };

// ============================================================================
// Volume Calculation & Native Plotting
// ============================================================================

/** Stochastic volume calculation run request */
export interface VolumeCalculationRequest {
    /** Working directory containing the model XML files */
    workingDirectory: string;
    /** Domain type for the volume calculation */
    domainType: 'cell' | 'material' | 'universe';
    /** Domain IDs to calculate volumes of */
    domainIds: number[];
    /** Number of samples */
    samples: number;
    /** Sampling bounding box lower-left (auto-detected by OpenMC when absent) */
    lowerLeft?: [number, number, number];
    /** Sampling bounding box upper-right */
    upperRight?: [number, number, number];
    /** Trigger type to halt the calculation early */
    triggerType?: 'std_dev' | 'variance' | 'rel_err';
    /** Trigger threshold */
    triggerThreshold?: number;
}

/** Volume result for one domain */
export interface VolumeDomainResult {
    /** Domain ID */
    id: number;
    /** Estimated volume in cm³ */
    volume: number;
    /** Standard deviation of the estimate */
    stdDev: number;
    /** Atom count estimates per nuclide */
    atoms?: Record<string, { value: number; stdDev: number }>;
}

/** Stochastic volume calculation run result */
export interface VolumeCalculationResult {
    success: boolean;
    results?: VolumeDomainResult[];
    /** Path to the volume_1.h5 results file */
    volumeFile?: string;
    error?: string;
    /** Captured script output (progress lines) */
    output?: string;
}

/** Native plot generation request */
export interface PlotGenerationRequest {
    /** Working directory containing the model XML files */
    workingDirectory: string;
    /** Plot configurations to generate */
    plots: OpenMCPlotConfig[];
    /** Whether to convert voxel plots to VTK (.vti) after generation */
    convertVoxelToVtk?: boolean;
}

/** A generated plot output file */
export interface GeneratedPlotFile {
    /** Plot ID this file belongs to */
    plotId: number;
    /** Plot type */
    type: string;
    /** Absolute file path */
    path: string;
    /** File kind */
    kind: 'png' | 'h5' | 'vti';
}

/** Native plot generation result */
export interface PlotGenerationResult {
    success: boolean;
    files?: GeneratedPlotFile[];
    error?: string;
    /** Captured script output (progress lines) */
    output?: string;
}

/** NCrystal material import result */
export interface NCrystalImportResult {
    success: boolean;
    /** Imported material composition */
    material?: {
        nuclides: { name: string; fraction: number; fractionType: 'ao' | 'wo' }[];
        /** Density in g/cm³ */
        density: number;
        densityUnit: string;
        /** Temperature in K */
        temperature?: number;
    };
    error?: string;
}

/** MGXS library generation request */
export interface MgxsGenerationRequest {
    /** Working directory containing the model XML files */
    workingDirectory: string;
    /** MGXS generation method */
    method: 'material_wise' | 'stochastic_slab' | 'infinite_medium';
    /** Energy group structure name (e.g. 'CASMO-2', 'XMAS-172') */
    groups: string;
    /** Particles for the generation runs */
    particles?: number;
    /** Transport correction */
    correction?: 'none' | 'P0';
    /** Temperatures in K for MGXS generation */
    temperatures?: number[];
    /** Output library filename (default mgxs.h5) */
    output?: string;
    /** Also convert the model to random ray */
    randomRay?: boolean;
}

/** MGXS library generation result */
export interface MgxsGenerationResult {
    success: boolean;
    /** Absolute path to the generated mgxs.h5 library */
    mgxsPath?: string;
    /** Whether random ray conversion was applied */
    randomRayApplied?: boolean;
    error?: string;
    /** Captured script output (progress lines) */
    output?: string;
}

/** Material name → XS data set name in the generated library */
export interface MgXsDataMapping {
    /** Material name in the project */
    materialName: string;
    /** XS data set (group) name in mgxs.h5 */
    xsDataName: string;
}

/** CE → multi-group project conversion request (python/convert_to_multigroup_project.py) */
export interface MgConversionRequest {
    /** Working directory containing the generated model XML files */
    workingDirectory: string;
    /** MGXS generation method */
    method?: 'material_wise' | 'stochastic_slab' | 'infinite_medium';
    /** Energy group structure name (e.g. 'CASMO-2') */
    groups?: string;
    /** Particles for the generation runs */
    particles?: number;
    /** Output library filename (default mgxs.h5) */
    output?: string;
}

/** CE → multi-group project conversion result */
export interface MgConversionResult {
    success: boolean;
    /** Absolute path to the generated mgxs.h5 library */
    mgxsPath?: string;
    /** Material → XS data set mapping (materials with a library group) */
    xsDataNames?: MgXsDataMapping[];
    error?: string;
    /** Captured script output (progress lines) */
    output?: string;
}

/** Result of reading the XS-data mapping from an existing MGXS library */
export interface MgxsDataNamesResult {
    success: boolean;
    xsDataNames?: MgXsDataMapping[];
    error?: string;
}

/** Fine-grained MGXS library generation request (python/generate_mgxs_library.py) */
export interface MgxsLibraryGenerationRequest {
    /** Working directory containing the model XML files */
    workingDirectory: string;
    /** Group structure name (e.g. 'CASMO-2') or comma-separated edges in eV */
    groups?: string;
    /** Cross-section types (openmc.mgxs.MGXS_TYPES names) */
    mgxsTypes?: string[];
    /** Spatial domain type for homogenization */
    domainType?: 'material' | 'cell' | 'universe';
    /** Domain IDs (default: all domains of the domain type) */
    domainIds?: number[];
    /** Compute cross sections per nuclide in each domain */
    byNuclide?: boolean;
    /** Legendre order for scattering matrices */
    legendreOrder?: number;
    /** Tally estimator override */
    estimator?: 'analog' | 'tracklength' | 'collision';
    /** Transport correction */
    correction?: 'none' | 'P0';
    /** Particles per generation for the generation run */
    particles?: number;
    /** Output library filename (default mgxs.h5) */
    output?: string;
}

/** Fine-grained MGXS library generation result */
export interface MgxsLibraryGenerationResult {
    success: boolean;
    /** Absolute path to the generated library */
    mgxsPath?: string;
    /** Cross-section types included (incl. auto-appended scatter/multiplicity) */
    mgxsTypes?: string[];
    /** Domain type used */
    domainType?: string;
    /** Domain IDs computed over */
    domainIds?: number[];
    /** Whether by-nuclide decomposition was used */
    byNuclide?: boolean;
    /** Statepoint used for post-processing */
    statepoint?: string;
    error?: string;
    /** Captured script output (progress lines) */
    output?: string;
}

/** Chain builder request (python/build_chain.py) */
export interface ChainBuildRequest {
    /** Subset mode: source chain XML to filter */
    fromChain?: string;
    /** ENDF mode: directory with decay/ nfy/ neutron/ sub-libraries */
    fromEndf?: string;
    /** Nuclides to include (default: all from source) */
    nuclides?: string[];
    /** Output chain XML path */
    output: string;
}

/** Chain builder result */
export interface ChainBuildResult {
    success: boolean;
    /** Builder mode used */
    mode?: 'subset' | 'endf';
    /** Nuclides in the built chain */
    nuclideCount?: number;
    /** Source chain nuclide count (subset mode) */
    sourceNuclideCount?: number;
    /** FPY borrow parents pulled into a subset chain */
    borrowParentsIncluded?: string[];
    /** Absolute path to the built chain XML */
    outputPath?: string;
    error?: string;
    /** Captured script output (progress lines) */
    output?: string;
}

/** Depletion run settings extracted from the settings.xml `<depletion>` block */
export interface DepletionRunSettings {
    /** Depletion chain XML file path */
    chainFile?: string;
    /** Time steps in seconds */
    timeSteps: number[];
    /** Power level in Watts */
    power?: number;
    /** Power density in W/g */
    powerDensity?: number;
    /** Operator type */
    operator?: 'coupled' | 'independent' | 'openmc';
    /** Solver method */
    solver?: string;
    /** Transport normalization mode */
    normalization?: string;
    /** Custom fission Q values per nuclide [eV] */
    fissionQ?: Record<string, number>;
    /** Distinguish burnable materials that share the same composition */
    diffBurnableMats?: boolean;
    /** How volumes are assigned to differentiated materials */
    diffVolumeMethod?: 'divide equally' | 'match cell';
    /** Flux file paths for the independent operator */
    fluxFiles?: string[];
    /** MicroXS file paths for the independent operator */
    microxsFiles?: string[];
    /** Compute fluxes and micro cross sections from the model via a transport solve */
    generateFromModel?: boolean;
    /** External transfer rates between materials */
    transferRates?: OpenMCTransferRate[];
}

// ============================================================================
// Service Symbols
// ============================================================================

/** Service identifier for dependency injection */
export const OpenMCStudioBackendService = Symbol('OpenMCStudioBackendService');
/** JSON-RPC endpoint path for the OpenMC Studio backend service */
export const OPENMC_STUDIO_BACKEND_PATH = '/services/openmc-studio';

// ============================================================================
// XML Generation
// ============================================================================

/**
 * Request/response types for generating OpenMC XML files from simulation state.
 * @see {@link XMLGenerationService}
 */

/** Request to generate XML files from state */
export interface XMLGenerationRequest {
    /** Complete simulation state */
    state: OpenMCState;
    /** Output directory path */
    outputDirectory: string;
    /** Which files to generate */
    files: {
        geometry?: boolean;
        materials?: boolean;
        settings?: boolean;
        tallies?: boolean;
        plots?: boolean;
    };
    /** Whether to overwrite existing files */
    overwrite?: boolean;
    /** Optional comment header for generated files */
    headerComment?: string;
    /**
     * OpenMC version compatibility, probed per python environment
     * ({@link OpenMCCompatProbeService}). Defaults to the release-compatible
     * form ({@link DEFAULT_OPENMC_COMPAT}) when unspecified.
     */
    randomRayCompat?: OpenMCCompat;
    /**
     * Path to the neutron cross_sections.xml library. When provided, element
     * symbols in materials are expanded only to isotopes present in the library,
     * and abundances are renormalized to exclude missing isotopes.
     */
    crossSectionsPath?: string;
}

/**
 * OpenMC version compatibility, detected at runtime per python environment
 * (never version parsing). Covers the settings.xml format skew between
 * release 0.15.3 and post-0.15.3 dev plus feature support gates.
 */
export interface OpenMCCompat {
    /**
     * ray_source emission: `direct` = release 0.15.3 (`<random_ray><source>`);
     * `wrapper` = post-0.15.3 dev (`<ray_source><source>`,
     * settings.py:2006+ / src/settings.cpp:284-289)
     */
    raySourceFormat: 'direct' | 'wrapper';
    /** Whether the environment supports `<adjoint_source>` (post-0.15.3 only) */
    adjointSource: boolean;
    /** Whether `openmc.TokamakSource` exists (0.15.4+) */
    tokamakSource: boolean;
    /** Whether random ray `sample_method: 's2'` is accepted */
    s2SampleMethod: boolean;
}

/** Release-compatible default (stable releases are the common case). */
export const DEFAULT_OPENMC_COMPAT: OpenMCCompat = {
    raySourceFormat: 'direct',
    adjointSource: false,
    tokamakSource: false,
    s2SampleMethod: false
};

/** Result of XML generation */
export interface XMLGenerationResult {
    /** Whether generation was successful */
    success: boolean;
    /** Paths to generated files */
    generatedFiles: string[];
    /** Warnings during generation */
    warnings?: string[];
    /** Error message if failed */
    error?: string;
    /** Validation results */
    validation?: XMLValidationResult;
}

/** XML validation result */
export interface XMLValidationResult {
    /** Whether XML is valid */
    valid: boolean;
    /** Validation errors */
    errors: string[];
    /** Validation warnings */
    warnings: string[];
}

// ============================================================================
// XML Import
// ============================================================================

/**
 * Request/response types for importing existing OpenMC XML files into state.
 * @see {@link OpenMCStudioBackendService.importXML}
 */

/** Request to import XML files into state */
export interface XMLImportRequest {
    /** Directory containing XML files */
    directory: string;
    /** Specific files to import (default: auto-detect) */
    files?: {
        geometry?: string;
        materials?: string;
        settings?: string;
        tallies?: string;
        plots?: string;
    };
    /** Import options */
    options?: {
        /** Merge with existing state or replace */
        mergeStrategy?: 'replace' | 'merge' | 'preserve';
        /** Validate after import */
        validate?: boolean;
    };
}

/** Result of XML import */
export interface XMLImportResult {
    /** Whether import was successful */
    success: boolean;
    /** Imported state */
    state?: OpenMCState;
    /** Errors during import */
    errors: string[];
    /** Warnings during import */
    warnings: string[];
}

// ============================================================================
// Simulation Runner
// ============================================================================

/**
 * Request/response types for running OpenMC simulations.
 * Supports both blocking and non-blocking execution modes.
 * @see {@link OpenMCRunnerService}
 */

/** Simulation run request */
export interface SimulationRunRequest {
    /** Working directory containing XML files */
    workingDirectory: string;
    openmcPath?: string;
    /** MPI configuration */
    mpi?: {
        enabled: boolean;
        processes?: number;
        hosts?: string[];
    };
    /** OpenMC command-line arguments */
    args?: string[];
    /** Statepoint file to restart the simulation from (passed as CLI `-r`) */
    restartFile?: string;
    /**
     * CMFD acceleration config (C-API feature, not in settings.xml). When
     * `enabled`, the backend routes the run through `python/run_cmfd.py`
     * instead of the `openmc` binary; `meshRef` must already be resolved to
     * an inline mesh spec by the caller.
     */
    cmfd?: OpenMCCmfdSettings;
    /** Environment variables */
    env?: { [key: string]: string };
}

/** Simulation progress update */
export interface SimulationProgress {
    /** Current batch number */
    batch: number;
    /** Total batches */
    totalBatches: number;
    /** Current generation (for eigenvalue) */
    generation?: number;
    /** k-effective value (for eigenvalue) */
    kEff?: number;
    /** k-effective standard deviation */
    kEffStd?: number;
    /** Time elapsed in seconds */
    elapsedTime: number;
    /** Estimated time remaining in seconds */
    estimatedTimeRemaining?: number;
    /** Whether simulation is complete */
    complete: boolean;
    /** Whether simulation failed */
    error?: string;
    /** Current particles being simulated */
    particlesSimulated?: number;
    /** Total particles to simulate */
    totalParticles?: number;
}

/** Simulation run result */
export interface SimulationRunResult {
    /** Whether run was successful */
    success: boolean;
    /** Exit code */
    exitCode?: number;
    /** Standard output */
    stdout: string;
    /** Standard error */
    stderr: string;
    /** Output files generated */
    outputFiles: string[];
    /** Error message if failed */
    error?: string;
    /** Timing information */
    timing?: {
        startTime: string;
        endTime: string;
        duration: number;
    };
}

/** Start simulation response (non-blocking) */
export interface StartSimulationResponse {
    /** Process ID for tracking/cancelling */
    processId: string;
    /** Whether start was successful */
    success: boolean;
    /** Error message if failed to start */
    error?: string;
}

/** Simulation log result */
export interface SimulationLogResult {
    /** Whether log was found */
    success: boolean;
    /** Log file content */
    logContent?: string;
    /** Path to log file */
    logPath?: string;
    /** Error message if failed */
    error?: string;
    /** Whether simulation is still running */
    isRunning?: boolean;
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Request/response types for validating simulation state.
 * Performs geometry, materials, settings, and tally checks.
 * @see {@link OpenMCStudioBackendService.validateState}
 */

/** Validation request */
export interface ValidationRequest {
    /** State to validate */
    state: OpenMCState;
    /** Validation level: 'basic', 'standard', 'strict' */
    level?: 'basic' | 'standard' | 'strict';
    /** Specific checks to run */
    checks?: {
        geometry?: boolean;
        materials?: boolean;
        settings?: boolean;
        tallies?: boolean;
        overlaps?: boolean;
    };
}

/** Validation issue severity */
export type ValidationSeverity = 'error' | 'warning' | 'info';

/** Validation issue */
export interface ValidationIssue {
    /** Severity level */
    severity: ValidationSeverity;
    /** Issue category */
    category: 'geometry' | 'materials' | 'settings' | 'tallies' | 'depletion' | 'general';
    /** Error code for documentation reference */
    code?: string;
    /** Human-readable message */
    message: string;
    /** Path to affected element in state */
    path?: string;
    /** Suggested fix */
    suggestion?: string;
}

/** Validation result */
export interface ValidationResult {
    /** Whether state is valid */
    valid: boolean;
    /** List of validation issues */
    issues: ValidationIssue[];
    /** Summary counts */
    summary: {
        errors: number;
        warnings: number;
        info: number;
    };
}

// ============================================================================
// Geometry Validation
// ============================================================================

/**
 * Request/response types for geometry overlap detection.
 * @see {@link OpenMCStudioBackendService.checkOverlaps}
 */

/** Overlap check request */
export interface OverlapCheckRequest {
    /** Geometry to check */
    geometry: {
        surfaces: OpenMCSurface[];
        cells: OpenMCCell[];
    };
    /** Number of sample points */
    samplePoints?: number;
    /** Bounding box to limit check (optional) */
    bounds?: {
        min: [number, number, number];
        max: [number, number, number];
    };
}

/** Overlap check result */
export interface OverlapCheckResult {
    /** Whether check completed */
    complete: boolean;
    /** Overlaps found */
    overlaps: Array<{
        coordinates: [number, number, number];
        cellIds: number[];
        cellNames: string[];
    }>;
    /** Number of sample points checked */
    samplesChecked: number;
    /** Time taken in seconds */
    elapsedTime: number;
    /** Error if check failed */
    error?: string;
}

// ============================================================================
// Project Management
// ============================================================================

/**
 * Request/response types for project lifecycle operations.
 * @see {@link OpenMCStudioBackendService.createProject}
 * @see {@link OpenMCStudioBackendService.loadProject}
 * @see {@link OpenMCStudioBackendService.saveProject}
 */

/** Project creation request */
export interface ProjectCreateRequest {
    /** Project directory */
    directory: string;
    /** Project name */
    name: string;
    /** Template to use */
    template?: string;
    /** Optional description */
    description?: string;
    /** Author */
    author?: string;
}

/** Project creation result */
export interface ProjectCreateResult {
    /** Whether creation was successful */
    success: boolean;
    /** Path to created project file */
    projectFile?: string;
    /** Initial state */
    initialState?: OpenMCState;
    /** Error message if failed */
    error?: string;
}

/** Project save request */
export interface ProjectSaveRequest {
    /** Project file path */
    projectPath: string;
    /** Complete state to save */
    state: OpenMCState;
    /** Whether to also generate XML files */
    generateXml?: boolean;
}

/** Project load result */
export interface ProjectLoadResult {
    /** Whether load was successful */
    success: boolean;
    /** Loaded project file */
    project?: OpenMCProjectFile;
    /** Error message if failed */
    error?: string;
}

// ============================================================================
// Template Management
// ============================================================================

/**
 * Request/response types for project template operations.
 * @see {@link OpenMCStudioBackendService.getTemplates}
 * @see {@link OpenMCStudioBackendService.applyTemplate}
 */

/** Available templates response */
export interface TemplatesResponse {
    /** List of available templates */
    templates: OpenMCProjectTemplate[];
}

/** Template application request */
export interface ApplyTemplateRequest {
    /** Template ID */
    templateId: string;
    /** Base state to apply template to (optional) */
    baseState?: OpenMCState;
    /** Template parameters */
    parameters?: { [key: string]: any };
}

// ============================================================================
// WWINP Import/Export
// ============================================================================

/**
 * Request/response types for MCNP WWINP weight window file operations.
 * @see {@link OpenMCStudioBackendService.importWWINP}
 * @see {@link OpenMCStudioBackendService.exportWWINP}
 */

/** Request to import MCNP WWINP file */
export interface WWINPImportRequest {
    /** Path to WWINP file */
    filePath: string;
}

/** Result of WWINP import */
export interface WWINPImportResult {
    /** Whether import was successful */
    success: boolean;
    /** Imported weight windows data */
    weightWindows?: {
        meshId: number;
        lowerBound: number | number[];
        upperBound?: number | number[];
        energyBounds?: number[];
        particleType?: 'neutron' | 'photon';
    };
    /** Error message if failed */
    error?: string;
}

/** Request to export to MCNP WWINP file */
export interface WWINPExportRequest {
    /** Path to output WWINP file */
    filePath: string;
    /** Weight windows to export */
    weightWindows: {
        meshId: number;
        lowerBound: number | number[];
        upperBound?: number | number[];
        survivalWeight?: number;
        particleType?: 'neutron' | 'photon';
        energyBounds?: number[];
    };
    /** Available meshes for dimension info */
    meshes: any[];
}

/** Result of WWINP export */
export interface WWINPExportResult {
    /** Whether export was successful */
    success: boolean;
    /** Error message if failed */
    error?: string;
}

// ============================================================================
// Backend Service Interface
// ============================================================================

/**
 * Main backend service interface for OpenMC Studio.
 * Defines the JSON-RPC contract between frontend and backend.
 * Implemented by {@link OpenMCStudioBackendServiceImpl}.
 * @see {@link OpenMCStudioBackendService}
 */

/** Backend service interface for OpenMC Studio */
export interface OpenMCStudioBackendService {
    // === Configuration ===

    /** Set Python configuration (shared with nuke-visualizer) */
    setPythonConfig(config: { pythonPath?: string; condaEnv?: string }): Promise<void>;

    /**
     * Get the probed OpenMC version compatibility for the configured python
     * environment (cached per python command; release-compatible default when
     * undetectable). Lets the UI gate dev-only features (tokamak sources,
     * random ray adjoint / s2 sampling) before XML generation.
     */
    getOpenMCCompat(): Promise<OpenMCCompat>;

    // === XML Generation ===

    /** Generate XML files from state */
    generateXML(request: XMLGenerationRequest): Promise<XMLGenerationResult>;

    /** Import XML files into state */
    importXML(request: XMLImportRequest): Promise<XMLImportResult>;

    /** Validate XML files without importing */
    validateXML(directory: string): Promise<XMLValidationResult>;

    // === Simulation ===

    /** Run OpenMC simulation (blocking - returns when complete) */
    runSimulation(request: SimulationRunRequest): Promise<SimulationRunResult>;

    /** Start OpenMC simulation (non-blocking - returns immediately with processId) */
    startSimulation(request: SimulationRunRequest): Promise<StartSimulationResponse>;

    /** Cancel running simulation */
    cancelSimulation(processId: string): Promise<boolean>;

    /** Get simulation log file content */
    getSimulationLog(processId: string): Promise<SimulationLogResult>;

    /** Check if OpenMC is available */
    checkOpenMC(): Promise<{ available: boolean; version?: string; path?: string; error?: string }>;

    /** Check if MPI is available */
    checkMPI(): Promise<{ available: boolean; version?: string; processes?: number; error?: string }>;

    /** Run a stochastic volume calculation (blocking) */
    runVolumeCalculation(request: VolumeCalculationRequest): Promise<VolumeCalculationResult>;

    /** Generate native OpenMC plots (blocking) */
    generatePlots(request: PlotGenerationRequest): Promise<PlotGenerationResult>;

    /** Import a material composition from an NCrystal configuration string */
    importNCrystalMaterial(cfg: string): Promise<NCrystalImportResult>;

    /** Generate an MGXS library via Model.convert_to_multigroup (blocking) */
    generateMgxs(request: MgxsGenerationRequest): Promise<MgxsGenerationResult>;

    /** Generate a fine-grained MGXS library via openmc.mgxs.Library (blocking) */
    generateMgxsLibrary(request: MgxsLibraryGenerationRequest): Promise<MgxsLibraryGenerationResult>;

    /** Convert a CE project to multi-group: MGXS generation + material/XS-data mapping (blocking) */
    convertToMultigroupProject(request: MgConversionRequest): Promise<MgConversionResult>;

    /** Read the material/XS-data mapping from an existing MGXS library without regenerating it */
    getMgxsDataNames(mgxsPath: string): Promise<MgxsDataNamesResult>;

    /** Build a custom depletion chain XML (subset or ENDF mode, blocking) */
    buildChain(request: ChainBuildRequest): Promise<ChainBuildResult>;

    // === Validation ===

    /** Validate simulation state */
    validateState(request: ValidationRequest): Promise<ValidationResult>;

    /** Check for geometry overlaps */
    checkOverlaps(request: OverlapCheckRequest): Promise<OverlapCheckResult>;

    /** Check if region expression is valid */
    validateRegion(region: string, surfaces: OpenMCSurface[]): Promise<{ valid: boolean; error?: string }>;

    // === Project Management ===

    /** Create new project */
    createProject(request: ProjectCreateRequest): Promise<ProjectCreateResult>;

    /** Load project file */
    loadProject(projectPath: string): Promise<ProjectLoadResult>;

    /** Save project file */
    saveProject(request: ProjectSaveRequest): Promise<{ success: boolean; error?: string }>;

    /** Get available templates */
    getTemplates(): Promise<TemplatesResponse>;

    /** Apply template to create initial state */
    applyTemplate(request: ApplyTemplateRequest): Promise<{ success: boolean; state?: OpenMCState; error?: string }>;

    // === WWINP Import/Export ===

    /** Import MCNP WWINP file */
    importWWINP(request: WWINPImportRequest): Promise<WWINPImportResult>;

    /** Export to MCNP WWINP file */
    exportWWINP(request: WWINPExportRequest): Promise<WWINPExportResult>;

    // === Statepoint Comparison ===

    /** Read a single statepoint file and extract data */
    readStatepoint(request: ReadStatepointRequest): Promise<ReadStatepointResult>;

    /** Compare multiple statepoint files */
    compareStatepoints(request: CompareStatepointsRequest): Promise<CompareStatepointsResult>;

    /** Read depletion results file */
    readDepletionResults(request: ReadDepletionRequest): Promise<DepletionResults>;

    /** Analyze k-effective convergence */
    analyzeConvergence(request: AnalyzeConvergenceRequest): Promise<KeffConvergenceAnalysis>;

    // === Utility ===

    /** Get cross-sections path from environment */
    getCrossSectionsPath(): Promise<{ path?: string; found: boolean }>;

    /** Suggest material ID */
    suggestMaterialId(state: OpenMCState): Promise<number>;

    /** Suggest cell ID */
    suggestCellId(state: OpenMCState): Promise<number>;

    /** Suggest surface ID */
    suggestSurfaceId(state: OpenMCState): Promise<number>;

    /** Suggest tally ID */
    suggestTallyId(state: OpenMCState): Promise<number>;

    /** Suggest mesh ID */
    suggestMeshId(state: OpenMCState): Promise<number>;

    // === CAD Import ===

    /** Check if CAD import dependencies are available */
    checkCADSupport(): Promise<{
        available: boolean;
        libraries: {
            openCascade: boolean;
            gmsh: boolean;
            cadQuery: boolean;
        };
        pythonPath?: string;
    }>;

    /** Import a CAD file and convert to OpenMC-compatible CSG */
    importCAD(request: CADImportRequest): Promise<CADImportResult>;

    /** Preview CAD file info without full import */
    previewCAD(filePath: string): Promise<{
        format: string;
        solidCount: number;
        faceCount: number;
        bounds?: { min: [number, number, number]; max: [number, number, number] };
    }>;

    // === DAGMC Editor ===

    /** Load DAGMC file and return model information */
    dagmcLoad(filePath: string): Promise<{
        success: boolean;
        data?: {
            filePath: string;
            fileName: string;
            fileSizeMB: number;
            volumeCount: number;
            surfaceCount: number;
            vertices: number;
            materials: Record<string, { volumeCount: number; volumes: number[] }>;
            volumes: Array<{
                id: number;
                material?: string;
                numTriangles: number;
                boundingBox: { min: number[]; max: number[] };
            }>;
            groups: Array<{
                name: string;
                type: string;
                volumeCount: number;
                volumes: number[];
            }>;
            boundingBox: { min: number[]; max: number[] };
        };
        error?: string;
    }>;

    /** Assign material to a volume in DAGMC file */
    dagmcAssignMaterial(
        filePath: string,
        volumeId: number,
        materialName: string
    ): Promise<{
        success: boolean;
        message?: string;
        error?: string;
    }>;

    /** Create a new group in DAGMC file */
    dagmcCreateGroup(
        filePath: string,
        groupName: string,
        volumeIds?: number[]
    ): Promise<{
        success: boolean;
        message?: string;
        error?: string;
    }>;

    /** Delete a group from DAGMC file */
    dagmcDeleteGroup(
        filePath: string,
        groupName: string
    ): Promise<{
        success: boolean;
        message?: string;
        error?: string;
    }>;

    /** Replace a material by name across all volumes in a DAGMC file */
    dagmcReplaceMaterial(
        filePath: string,
        oldName: string,
        newName: string
    ): Promise<{
        success: boolean;
        message?: string;
        error?: string;
    }>;

    /** Synchronize DAGMC universes for depletion (rewrites geometry.xml with per-cell material overrides) */
    dagmcSyncForDepletion(workingDirectory: string): Promise<{
        success: boolean;
        cellCount?: number;
        materialCount?: number;
        materialNames?: string[];
        geometryXml?: string;
        error?: string;
        output?: string;
    }>;

    /** Get faceting parameters from a DAGMC file */
    dagmcGetFacetingParams(filePath: string): Promise<{
        success: boolean;
        data?: {
            facetingTolerance: number;
            totalTriangles: number;
            volumeCount: number;
            surfaceCount: number;
        };
        error?: string;
    }>;

    /** Re-export a DAGMC file from source CAD with new faceting tolerance */
    dagmcRefacet(
        filePath: string,
        sourceCadPath: string,
        tolerance: number
    ): Promise<{
        success: boolean;
        data?: {
            outputPath: string;
            message?: string;
        };
        error?: string;
    }>;

    /** Cancel any active re-faceting operation */
    dagmcCancelRefacet(): Promise<void>;

    // === Optimization Framework ===

    /** Start an optimization run with parameter sweeps */
    startOptimization(request: StartOptimizationRequest): Promise<StartOptimizationResult>;

    /** Stop/cancel a running optimization */
    stopOptimization(request: StopOptimizationRequest): Promise<StopOptimizationResult>;

    /** Get status of an optimization run */
    getOptimizationStatus(runId: string): Promise<{
        running: boolean;
        currentIteration: number;
        totalIterations: number;
        status: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
    }>;

    /**
     * Get iteration logs index for an optimization run
     * @param runId The run ID
     * @param outputDirectory Optional output directory (absolute path). If not provided, will look up active runs.
     */
    getIterationLogsIndex(
        runId: string,
        outputDirectory?: string
    ): Promise<{
        iterations: { iteration: number; hasLog: boolean; timestamp: string }[];
        outputDirectory: string;
    }>;

    /**
     * Get log content for a specific iteration
     * @param runId The run ID
     * @param iteration The iteration number
     * @param outputDirectory Optional output directory (absolute path). If not provided, will look up active runs.
     */
    getIterationLog(
        runId: string,
        iteration: number,
        outputDirectory?: string
    ): Promise<{
        success: boolean;
        logContent?: string;
        error?: string;
    }>;

    /**
     * Run a criticality (k-eff) search: find the value of one model parameter
     * that produces the target k-effective (openmc.search_for_keff).
     * Blocking: resolves with the full result when the search finishes;
     * per-iteration output streams to client logs meanwhile.
     */
    runKeffSearch(request: StartKeffSearchRequest): Promise<KeffSearchResult>;

    /** Cancel a running k-eff search by run ID */
    cancelKeffSearch(runId: string): Promise<{ success: boolean; error?: string }>;
}

// ============================================================================
// CAD Import Types
// ============================================================================

/**
 * CAD import request/response types for geometry import operations.
 * @see {@link OpenMCCADImportService}
 */

/** Supported CAD file formats */
export type CADFileFormat = 'step' | 'iges' | 'stp' | 'igs' | 'brep' | 'stl' | 'h5m' | 'dagmc';

/** CAD import request */
export interface CADImportRequest {
    /** Path to the CAD file */
    filePath: string;
    /** File format (auto-detected if not specified) */
    format?: CADFileFormat;
    /**
     * Explicit output path for the generated DAGMC .h5m file.
     * When omitted the Python backend writes a tempfile.
     */
    dagmcOutput?: string;
    /**
     * Whether to auto-create a mat:graveyard bounding volume when converting
     * CAD to DAGMC. Defaults to true.
     */
    addGraveyard?: boolean;
    /** Import options */
    options?: {
        /** Tolerance for surface approximation in cm (default: 0.001) */
        tolerance?: number;
        /** Whether to merge coplanar surfaces */
        mergeSurfaces?: boolean;
        /** Scale factor for the geometry (default: 1.0) */
        scale?: number;
        /** Units of the input file (default: 'cm') */
        units?: 'cm' | 'mm' | 'm' | 'in' | 'ft';
        /** Whether to auto-adjust faceting tolerance for large models */
        autoAdjustTolerance?: boolean;
        /** Material assignment for imported geometry */
        materialId?: number;
        /** Universe to place the imported geometry in */
        universeId?: number;
    };
}

/** CAD import result */
export interface CADImportResult {
    /** Whether import was successful */
    success: boolean;
    /** Error message if failed */
    error?: string;
    /** Warning messages */
    warnings?: string[];
    /** Imported surfaces (CSG conversion) */
    surfaces?: {
        type: string;
        coefficients: number[];
        name?: string;
    }[];
    /** Imported cells (CSG conversion) */
    cells?: {
        id: number;
        name?: string;
        region: string;
        material?: string;
    }[];
    /** Bounding box of the imported geometry */
    boundingBox?: {
        min: [number, number, number];
        max: [number, number, number];
    };
    /** Original file info */
    fileInfo?: {
        format: string;
        units: string;
        solidCount: number;
        faceCount: number;
        edgeCount?: number;
        vertexCount?: number;
        materials?: string[];
        facetingTolerance?: number;
        dagmc?: boolean;
        // DAGMC-specific fields
        fileName?: string;
        fileSizeMB?: number;
        volumeCount?: number;
        surfaceCount?: number;
        totalTriangles?: number;
        totalSurfaceArea?: number;
        materialsData?: Record<string, { volumeCount: number; totalTriangles: number }>;
        volumesData?: Array<{
            id: number;
            material: string;
            numTriangles: number;
            boundingBox?: { min: number[]; max: number[] };
        }>;
        groups?: string[];
        boundingBox?: { min: number[]; max: number[] };
    };
    /** Conversion summary */
    summary?: {
        surfacesCreated: number;
        cellsCreated: number;
        approximationsMade: number;
    };
    /** Whether NURBS were detected and DAGMC fallback was used */
    dagmc?: boolean;
    /** Path to generated DAGMC file when DAGMC fallback is used */
    dagmcFile?: string;
    /** Whether NURBS surfaces were detected in the source CAD */
    nurbsDetected?: boolean;
    /** DAGMC model information (when importing .h5m files or DAGMC fallback) */
    dagmcInfo?: DAGMCInfo;
}

// ============================================================================
// Statepoint Comparison
// ============================================================================

/**
 * Data structures for reading and comparing OpenMC statepoint files.
 * @see {@link OpenMCStudioBackendService.readStatepoint}
 * @see {@link OpenMCStudioBackendService.compareStatepoints}
 */

/** k-effective data from statepoint */
export interface StatepointKeff {
    value: number;
    stdDev: number;
}

/** k-effective by batch for convergence analysis */
export interface KeffByBatch {
    batch: number;
    value: number;
    stdDev: number;
}

/** Tally filter information */
export interface StatepointTallyFilter {
    type: string;
    bins: number;
}

/** Tally data from statepoint */
export interface StatepointTally {
    id: number;
    name?: string;
    scores: string[];
    nuclides: string[];
    mean: number[];
    stdDev: number[];
    totalBins: number;
    filters?: StatepointTallyFilter[];
    error?: string;
}

/** Statepoint file information and data */
export interface StatepointInfo {
    success: boolean;
    filePath: string;
    fileName: string;
    fileSizeMB: number;
    error?: string;
    traceback?: string;
    kEff?: StatepointKeff;
    batches?: number;
    inactiveBatches?: number;
    particles?: number;
    kEffectiveByBatch?: KeffByBatch[];
    tallies?: StatepointTally[];
    runMode?: string;
    version?: string;
    date?: string;
    entropy?: number[];
    sourceParticles?: number;
}

/** Request to read a statepoint file */
export interface ReadStatepointRequest {
    filePath: string;
}

/** Result of reading a statepoint file */
export interface ReadStatepointResult extends StatepointInfo {}

/** Request to compare multiple statepoints */
export interface CompareStatepointsRequest {
    filePaths: string[];
}

/** k-effective comparison statistics */
export interface KeffComparison {
    values: number[];
    mean: number;
    min: number;
    max: number;
    range: number;
}

/** Tally comparison entry */
export interface TallyComparisonEntry {
    file: string;
    tally: StatepointTally;
}

/** Comparison result for tallies */
export interface TallyComparison {
    [tallyKey: string]: TallyComparisonEntry[];
}

/** Comparison statistics */
export interface ComparisonStatistics {
    kEff?: KeffComparison;
    tallies?: TallyComparison;
}

/** Result of comparing multiple statepoints */
export interface CompareStatepointsResult {
    success: boolean;
    statepoints: StatepointInfo[];
    errors: Array<{ file: string; error?: string }>;
    comparison?: ComparisonStatistics;
    statisticalTests?: StatisticalTests;
}

// ============================================================================
// Statistical Tests
// ============================================================================

/**
 * Statistical test results for statepoint comparison and convergence analysis.
 */

/** k-effective statistical test results */
export interface KeffStatisticalTests {
    weightedMean: number;
    weightedUncertainty: number;
    chi2: number;
    ndof: number;
    reducedChi2?: number;
    consistency: 'consistent' | 'inconsistent' | 'unknown';
    confidenceIntervals: {
        intervals: Array<{
            lower: number;
            upper: number;
            value: number;
        }>;
        overlapExists: boolean;
        overlapLower?: number;
        overlapUpper?: number;
    };
}

/** Tally statistical test results */
export interface TallyStatisticalTests {
    [tallyKey: string]: {
        values: Array<{
            file: string;
            mean: number;
            stdDev: number;
        }>;
        mean: number;
        maxDeviation: number;
        relativeStdDev: number;
        consistent: boolean;
    };
}

/** Complete statistical test results */
export interface StatisticalTests {
    kEffective: KeffStatisticalTests;
    tallies: TallyStatisticalTests;
}

/** k-effective convergence analysis */
export interface KeffConvergenceAnalysis {
    success: boolean;
    error?: string;
    statepoint?: string;
    runningAverage: number[];
    finalValue: number;
    finalUncertainty?: number;
    drift?: number;
    driftPercent?: number;
    converged?: boolean;
    recommendation?: string;
    note?: string;
}

// ============================================================================
// Depletion / Burnup Comparison
// ============================================================================

/**
 * Data structures for depletion (burnup) result analysis.
 * @see {@link OpenMCStudioBackendService.readDepletionResults}
 */

/** Nuclide concentration data over time */
export interface NuclideData {
    initial: number;
    final: number;
    min: number;
    max: number;
    concentrations: number[];
}

/** Material with nuclide evolution data */
export interface DepletionMaterial {
    name: string;
    nuclides: {
        [nuclideName: string]: NuclideData;
    };
}

/** Depletion results from a simulation */
export interface DepletionResults {
    success: boolean;
    filePath: string;
    fileName: string;
    fileSizeMB: number;
    error?: string;
    traceback?: string;
    timeSteps?: number[];
    burnupSteps?: number[];
    finalBurnup?: number;
    keff?: Array<{ value: number; stdDev: number }>;
    materials: {
        [materialId: string]: DepletionMaterial;
    };
    numberOfMaterials: number;
    nuclideError?: string;
}

/** Request to read depletion results */
export interface ReadDepletionRequest {
    filePath: string;
}

/** Request to analyze k-effective convergence */
export interface AnalyzeConvergenceRequest {
    filePath: string;
}

// ============================================================================
// Frontend Events
// ============================================================================

/**
 * Event types for frontend-backend communication.
 * Sent via the {@link OpenMCStudioClient} interface.
 */

/** Simulation status change event */
export interface SimulationStatusEvent {
    /** Process ID */
    processId: string;
    /** Status */
    status: 'starting' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
    /** Progress information */
    progress?: SimulationProgress;
    /** Result (when completed/failed) */
    result?: SimulationRunResult;
}

/** State change event */
export interface StateChangeEvent {
    /** Path to changed element */
    path: string;
    /** Change type */
    type: 'add' | 'update' | 'delete';
    /** New value */
    value?: any;
    /** Old value */
    oldValue?: any;
}

// ============================================================================
// Optimization Framework
// ============================================================================

/**
 * Request/response types for parameter sweep optimization runs.
 * @see {@link OptimizationBackendService}
 */

/** Request to start an optimization run */
export interface StartOptimizationRequest {
    /** Unique run ID */
    runId: string;
    /** Run name */
    runName: string;
    /** Base simulation state */
    baseState: OpenMCState;
    /** Parameter sweep configurations */
    sweeps: import('./openmc-state-schema').OpenMCParameterSweep[];
    /** Output directory */
    outputDirectory: string;
    /** OpenMC cross-sections path */
    crossSectionsPath?: string;
    /** OpenMC chain file path */
    chainFilePath?: string;
}

/** Result of starting optimization */
export interface StartOptimizationResult {
    /** Whether start was successful */
    success: boolean;
    /** Error message if failed */
    error?: string;
    /** Total number of iterations */
    totalIterations?: number;
}

/** Optimization progress event */
export interface OptimizationProgressEvent {
    /** Run ID */
    runId: string;
    /** Current iteration */
    currentIteration: number;
    /** Total iterations */
    totalIterations: number;
    /** Parameter values for current iteration */
    parameterValues: Record<string, number>;
    /** Current status */
    status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
    /** Progress percentage */
    progressPercent: number;
}

/** Optimization iteration result */
export interface OptimizationIterationResult {
    /** Iteration number */
    iteration: number;
    /** Parameter values */
    parameterValues: Record<string, number>;
    /** k-effective value */
    keff?: number;
    /** k-effective standard deviation */
    keffStd?: number;
    /** Execution time in seconds */
    executionTime: number;
    /** Whether iteration succeeded */
    success: boolean;
    /** Error message if failed */
    errorMessage?: string;
    /** Path to statepoint file */
    statepointPath?: string;
}

/** Request to stop/cancel optimization */
export interface StopOptimizationRequest {
    /** Run ID to stop */
    runId: string;
}

/** Result of stopping optimization */
export interface StopOptimizationResult {
    /** Whether stop was successful */
    success: boolean;
    /** Error message if failed */
    error?: string;
}

/** Bracketed root-finding methods for the criticality search (openmc/search.py) */
export type KeffSearchMethod = 'brentq' | 'brenth' | 'ridder' | 'bisect';

/** Request to run a criticality (k-eff) search */
export interface StartKeffSearchRequest {
    /** Unique run ID */
    runId: string;
    /** Base simulation state (XML is generated from it into outputDirectory) */
    baseState: OpenMCState;
    /**
     * Searchable parameter in the optimization parameter-path vocabulary
     * (e.g. `water.density`, `fuel.U235`, `water.temperature`) — same
     * descriptor the parameter sweeps use.
     */
    parameter: string;
    /** Target k-effective (default 1.0) */
    target?: number;
    /** Initial guess (secant method; ignored when bracket is set) */
    initialGuess?: number;
    /** Bracketing interval [low, high] (enables bracketed methods) */
    bracket?: [number, number];
    /** Bracketed root-finding method (default 'bisect') */
    method?: KeffSearchMethod;
    /** Solver tolerance (search_for_keff requires an explicit tol in this OpenMC version) */
    tolerance?: number;
    /** Working/output directory for the search */
    outputDirectory: string;
    /** OpenMC cross-sections path */
    crossSectionsPath?: string;
    /** OpenMC chain file path */
    chainFilePath?: string;
}

/** One iteration of a criticality search */
export interface KeffSearchIteration {
    /** Iteration number (1-based) */
    iteration: number;
    /** Parameter value tried */
    guess: number;
    /** Resulting k-effective */
    keff: number;
    /** k-effective standard deviation */
    keffStd?: number;
}

/** Result of a criticality search */
export interface KeffSearchResult {
    /** Whether the search converged */
    success: boolean;
    /** Parameter value producing the target k-effective */
    convergedValue?: number;
    /** k-effective at the last evaluated guess */
    finalKeff?: number;
    /** Its standard deviation */
    finalKeffStd?: number;
    /** Per-iteration history */
    iterations: KeffSearchIteration[];
    /** Method used ('secant' when no bracket was given) */
    method: string;
    /** Target k-effective */
    target: number;
    /** Searched parameter path */
    parameter: string;
    /** Error message if failed */
    error?: string;
}

/** Client interface for receiving backend events */
export interface OpenMCStudioClient {
    /** Log message from backend */
    log(message: string): void;
    /** Error message from backend */
    error(message: string): void;
    /** Warning message from backend */
    warn(message: string): void;
    /** Simulation status update */
    onSimulationStatus(event: SimulationStatusEvent): void;
    /** Progress update */
    onProgress(progress: SimulationProgress): void;
    /** State change notification */
    onStateChange(event: StateChangeEvent): void;
    /** Optimization progress update */
    onOptimizationProgress?(event: OptimizationProgressEvent): void;
    /** Optimization iteration complete */
    onOptimizationIterationComplete?(runId: string, result: OptimizationIterationResult): void;
}
