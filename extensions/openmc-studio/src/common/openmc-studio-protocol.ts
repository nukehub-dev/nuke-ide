// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0.
//
// This Source Code may also be made available under the following Secondary
// Licenses when the conditions for such availability set forth in the Eclipse
// Public License v. 2.0 are satisfied: GNU General Public License, version 2
// with the GNU Classpath Exception which is available at
// https://www.gnu.org/software/classpath/license.html.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
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
    OPENMC_STATE_SCHEMA_VERSION,
    DAGMCInfo
} from './openmc-state-schema';

export { OPENMC_STATE_SCHEMA_VERSION };

// ============================================================================
// Service Symbols
// ============================================================================

export const OpenMCStudioBackendService = Symbol('OpenMCStudioBackendService');
export const OPENMC_STUDIO_BACKEND_PATH = '/services/openmc-studio';

// ============================================================================
// XML Generation
// ============================================================================

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
}

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

// ============================================================================
// Validation
// ============================================================================

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
// Backend Service Interface
// ============================================================================

/** Backend service interface for OpenMC Studio */
export interface OpenMCStudioBackendService {
    // === Configuration ===
    
    /** Set Python configuration (shared with nuke-visualizer) */
    setPythonConfig(config: { pythonPath?: string; condaEnv?: string }): Promise<void>;
    
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
    
    /** Check if OpenMC is available */
    checkOpenMC(): Promise<{ available: boolean; version?: string; path?: string; error?: string }>;
    
    /** Check if MPI is available */
    checkMPI(): Promise<{ available: boolean; version?: string; processes?: number; error?: string }>;
    
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
    dagmcAssignMaterial(filePath: string, volumeId: number, materialName: string): Promise<{
        success: boolean;
        message?: string;
        error?: string;
    }>;
    
    /** Create a new group in DAGMC file */
    dagmcCreateGroup(filePath: string, groupName: string, volumeIds?: number[]): Promise<{
        success: boolean;
        message?: string;
        error?: string;
    }>;
    
    /** Delete a group from DAGMC file */
    dagmcDeleteGroup(filePath: string, groupName: string): Promise<{
        success: boolean;
        message?: string;
        error?: string;
    }>;
}

// ============================================================================
// CAD Import Types
// ============================================================================

/** Supported CAD file formats */
export type CADFileFormat = 'step' | 'iges' | 'stp' | 'igs' | 'brep' | 'stl' | 'h5m' | 'dagmc';

/** CAD import request */
export interface CADImportRequest {
    /** Path to the CAD file */
    filePath: string;
    /** File format (auto-detected if not specified) */
    format?: CADFileFormat;
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
    /** DAGMC model information (when importing .h5m files) */
    dagmcInfo?: DAGMCInfo;
}

// ============================================================================
// Frontend Events
// ============================================================================

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
}
