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

export const VisualizerBackendService = Symbol('VisualizerBackendService');

export interface PythonConfig {
    pythonPath?: string;
    condaEnv?: string;
}

export interface EnvironmentInfo {
    pythonPath: string;
    pythonVersion: string;
    paraviewInstalled: boolean;
    paraviewVersion?: string;
    trameInstalled: boolean;
    trameVersion?: string;
    moabInstalled: boolean;
    moabVersion?: string;
    warning?: string;
}

/**
 * Visualization state for interactive controls.
 * Mirrors the state in Python backend (visualizer_app.py).
 */
export interface VisualizationState {
    /** Opacity value between 0.0 and 1.0 */
    opacity: number;
    
    /** Surface representation type */
    representation: RepresentationType;
    
    /** Field to color by, or 'Solid Color' */
    colorBy: string;
    
    /** Available data arrays for coloring */
    availableArrays: string[];
    
    /** Color map preset name */
    colorMap: string;
    
    /** Whether to show the scalar bar/legend */
    showScalarBar: boolean;
    
    /** Whether the clip plane is enabled */
    clipEnabled: boolean;
    
    /** Clip plane origin coordinates */
    clipOrigin: [number, number, number];
    
    /** Clip plane normal vector */
    clipNormal: [number, number, number];
    
    /** Whether to invert the clip */
    clipInvert: boolean;
    
    /** Background color [R, G, B] with values 0-1 */
    backgroundColor: [number, number, number];
}

/** Surface representation types */
export type RepresentationType = 
    | 'Surface' 
    | 'Surface with Edges' 
    | 'Wireframe' 
    | 'Points';

/** Camera preset views */
export type CameraViewType = 
    | 'isometric' 
    | 'front' 
    | 'back' 
    | 'left' 
    | 'right' 
    | 'top' 
    | 'bottom';

/** Screenshot export options */
export interface ScreenshotOptions {
    /** Output format */
    format: 'png' | 'jpg' | 'svg' | 'pdf';
    
    /** Resolution [width, height] or null for current viewport */
    resolution?: [number, number];
    
    /** Use transparent background */
    transparent?: boolean;
}

/** Screenshot export result */
export interface ScreenshotResult {
    /** Base64 encoded image data */
    base64?: string;
    
    /** File path if saved to disk */
    filePath?: string;
    
    /** Error message if failed */
    error?: string;
}

export interface ServerInfo {
    port: number;
    url: string;
    warning?: string;
}

export interface VisualizerBackendService {
    // === Server Management ===
    
    /** Start a new visualizer server for the given file
     * @param filePath Path to file to visualize
     * @param config Python configuration
     * @param theme UI theme ('dark' or 'light')
     */
    startServer(filePath?: string, config?: PythonConfig, theme?: string): Promise<ServerInfo>;
    
    /** Stop the visualizer server on the given port */
    stopServer(port: number): Promise<void>;
    
    /** Convert DAGMC .h5m file to VTK format */
    convertDagmc(filePath: string): Promise<string>;
    
    /** Check Python environment for dependencies */
    checkEnvironment(config?: PythonConfig): Promise<EnvironmentInfo>;
    
    /** Set the client for receiving log messages */
    setClient(client: VisualizerClient): void;
    
    // === Visualization Controls ===
    
    /** Get current visualization state from a running server */
    getVisualizationState(port: number): Promise<VisualizationState>;
    
    /** Update visualization state (opacity, representation, etc.) */
    updateVisualizationState(port: number, state: Partial<VisualizationState>): Promise<void>;
    
    /** Reset camera to default position */
    resetCamera(port: number): Promise<boolean>;
    
    /** Set camera to a preset view */
    setCameraView(port: number, viewType: CameraViewType): Promise<boolean>;
    
    // === Export ===
    
    /** Capture screenshot of current view */
    captureScreenshot(port: number, options: ScreenshotOptions): Promise<ScreenshotResult>;
}

export interface VisualizerClient {
    log(message: string): void;
    error(message: string): void;
    onServerStop(port: number): void;
}

export const VISUALIZER_BACKEND_PATH = '/services/visualizer';

// === OpenMC Integration Types ===

/** OpenMC filter metadata */
export interface OpenMCFilter {
    /** Filter type (mesh, energy, material, etc.) */
    type: string;
    /** Number of bins */
    bins: number;
    /** Mesh dimensions if mesh filter */
    meshDimensions?: number[];
    /** Mesh bounds if mesh filter */
    meshBounds?: {
        lowerLeft: number[];
        upperRight: number[];
    };
    /** Mesh type if mesh filter (regular or cylindrical) */
    meshType?: 'regular' | 'cylindrical';
    /** Mesh cell size/width if mesh filter */
    meshWidth?: number[];
}

/** OpenMC tally metadata */
export interface OpenMCTallyInfo {
    /** Tally ID */
    id: number;
    /** Tally name */
    name: string;
    /** Scores (flux, heating, etc.) */
    scores: string[];
    /** Nuclides (U235, total, etc.) */
    nuclides: string[];
    /** Filters applied */
    filters: OpenMCFilter[];
    /** Whether this is a mesh tally */
    hasMesh: boolean;
}

/** OpenMC statepoint summary */
export interface OpenMCStatepointInfo {
    /** Path to statepoint file */
    file: string;
    /** Number of batches */
    batches: number;
    /** Generations per batch */
    generationsPerBatch: number;
    /** k-effective value */
    kEff?: number;
    /** k-effective standard deviation */
    kEffStd?: number;
    /** Number of tallies */
    nTallies: number;
    /** Tally IDs */
    tallyIds: number[];
}

/** OpenMC source particle data */
export interface OpenMCSourceInfo {
    /** Number of particles */
    nParticles: number;
    /** Has position data */
    hasPositions: boolean;
    /** Has energy data */
    hasEnergy: boolean;
    /** Has weight data */
    hasWeight: boolean;
}

/** OpenMC spectrum data */
export interface OpenMCSpectrumData {
    energy_bins: number[];
    values: number[];
    std_dev: number[];
    error?: string;
}

/** OpenMC spatial plot data */
export interface OpenMCSpatialPlotData {
    positions: number[];
    values: number[];
    axis: string;
    error?: string;
}

/** Result of loading OpenMC geometry with tally overlay */
export interface OpenMCVisualizationResult {
    /** Whether loading was successful */
    success: boolean;
    /** Error message if failed */
    error?: string;
    /** Server port for visualization */
    port?: number;
    /** URL for visualization */
    url?: string;
    /** Tally info that was loaded */
    tallyInfo?: OpenMCTallyInfo;
}

// === OpenMC Backend Service ===

export const OpenMCBackendService = Symbol('OpenMCBackendService');
export const OPENMC_BACKEND_PATH = '/services/openmc';

export interface OpenMCBackendService {
    /** Load OpenMC statepoint and return summary information */
    loadStatepoint(statepointPath: string): Promise<OpenMCStatepointInfo>;
    
    /** List all tallies in a statepoint file */
    listTallies(statepointPath: string): Promise<OpenMCTallyInfo[]>;
    
    /** Visualize a mesh tally from statepoint file */
    visualizeMeshTally(
        statepointPath: string, 
        tallyId: number, 
        score?: string,
        nuclide?: string
    ): Promise<OpenMCVisualizationResult>;
    
    /** Visualize source distribution from source.h5 */
    visualizeSource(sourcePath: string): Promise<OpenMCVisualizationResult>;
    
    /** Overlay tally on geometry (geometry + statepoint) */
    visualizeTallyOnGeometry(
        geometryPath: string,
        statepointPath: string,
        tallyId: number,
        score?: string
    ): Promise<OpenMCVisualizationResult>;
    
    /** Get energy spectrum data for a tally */
    getEnergySpectrum(
        statepointPath: string,
        tallyId: number,
        scoreIndex?: number,
        nuclideIndex?: number
    ): Promise<OpenMCSpectrumData>;
    
    /** Get spatial plot data for a mesh tally */
    getSpatialPlot(
        statepointPath: string,
        tallyId: number,
        axis: 'x' | 'y' | 'z',
        scoreIndex?: number,
        nuclideIndex?: number
    ): Promise<OpenMCSpatialPlotData>;
    
    /** Stop a running visualization server */
    stopServer(port: number): Promise<void>;
    
    /** Check if OpenMC integration is available (h5py installed) */
    checkOpenMCAvailable(): Promise<{ available: boolean; message: string }>;
}

// === Color Map Presets ===

/** Available color map presets matching ParaView presets */
export const COLOR_MAP_PRESETS = [
    'Viridis',
    'Plasma',
    'Inferno',
    'Magma',
    'Cividis',
    'Cool to Warm',
    'Cool to Warm (Extended)',
    'Warm to Cool',
    'Black-Body Radiation',
    'X Ray',
    'Blue to Red Rainbow',
    'Red to Blue Rainbow',
    'Rainbow Desaturated',
    'Rainbow Uniform',
    'Jet',
    'Hot',
    'Cool',
    'Spectral',
    'RdYlBu',
    'RdYlGn',
    'PuOr',
    'PRGn',
    'BrBG',
    'PiYG',
    'RdBu',
    'Seismic',
    'Balance',
    'Twilight',
    'Haze',
    'Earth',
    'Ocean',
] as const;

/** Default visualization state */
export const DEFAULT_VISUALIZATION_STATE: VisualizationState = {
    opacity: 1.0,
    representation: 'Surface',
    colorBy: 'Solid Color',
    availableArrays: ['Solid Color'],
    colorMap: 'Cool to Warm',
    showScalarBar: true,
    clipEnabled: false,
    clipOrigin: [0, 0, 0],
    clipNormal: [1, 0, 0],
    clipInvert: false,
    backgroundColor: [0.1, 0.1, 0.15],
};
