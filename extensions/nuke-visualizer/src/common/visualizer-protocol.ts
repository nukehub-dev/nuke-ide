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

/** Generic Plotly figure definition for scientific plotting */
export interface PlotlyFigure {
    data: Partial<Plotly.Data>[];
    layout: Partial<Plotly.Layout>;
    config?: Partial<Plotly.Config>;
    title?: string;
    id?: string;
}

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
    std_dev?: number[];
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
    
    // === Cross-Section (XS) Plotting ===
    
    /** Get cross-section data for nuclides and reactions */
    getXSData(request: XSPlotRequest): Promise<XSPlotData>;
    
    /** Check if OpenMC Python module is available (for XS plotting) */
    checkOpenMCPythonAvailable(): Promise<{ available: boolean; message: string }>;
    
    /** Get available nuclides from cross_sections.xml */
    getAvailableNuclides(crossSectionsPath?: string): Promise<string[]>;
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

// === Cross-Section (XS) Plotting Types ===

/** Reaction type for XS plotting */
export interface XSReaction {
    /** MT number or reaction name */
    mt: number | string;
    /** Human-readable label */
    label: string;
    /** Whether reaction is selected */
    selected: boolean;
}

/** Nuclide component for material mixing */
export interface XSNuclideComponent {
    /** Nuclide name (e.g., 'U235', 'H1') */
    nuclide: string;
    /** Weight/atomic fraction (default 1.0 for pure nuclides) */
    fraction: number;
}

/** Material definition for XS plotting */
export interface XSMaterial {
    /** Material name */
    name: string;
    /** Nuclide components with fractions */
    components: XSNuclideComponent[];
    /** Density in g/cm³ (optional, for macroscopic XS) */
    density?: number;
}

/** Energy region presets for XS plotting */
export type XSEnergyRegion = 'full' | 'thermal' | 'resonance' | 'fast' | 'epithermal';

/** Energy region configuration */
export interface XSEnergyRegionConfig {
    label: string;
    range: [number, number];
    description: string;
}

/** Energy region presets */
export const XS_ENERGY_REGIONS: Record<XSEnergyRegion, XSEnergyRegionConfig> = {
    full: { label: 'Full Range', range: [1e-5, 2e7], description: 'Full energy range (0.01 meV - 20 MeV)' },
    thermal: { label: 'Thermal', range: [1e-5, 1], description: 'Thermal region (< 1 eV)' },
    resonance: { label: 'Resonance', range: [1, 1e5], description: 'Resonance region (1 eV - 100 keV)' },
    epithermal: { label: 'Epithermal', range: [1e-3, 1e5], description: 'Epithermal region (1 meV - 100 keV)' },
    fast: { label: 'Fast', range: [1e5, 2e7], description: 'Fast region (> 100 keV)' },
};

/** Temperature comparison request */
export interface XSTemperatureComparison {
    /** List of temperatures to compare (K) */
    temperatures: number[];
    /** Base nuclide for comparison */
    nuclide: string;
    /** Reaction MT number */
    reaction: number | string;
}

/** Flux spectrum data for reaction rate calculation */
export interface XSFluxSpectrum {
    /** Energy bins (eV) - must be same length as values + 1 */
    energy: number[];
    /** Flux values (neutrons/cm²/s per energy bin) */
    values: number[];
    /** Spectrum name/description */
    name?: string;
}

/** Reaction rate result */
export interface XSReactionRate {
    /** Nuclide name */
    nuclide: string;
    /** Reaction MT number */
    reaction: number | string;
    /** Reaction rate (reactions/cm³/s) */
    rate: number;
    /** Integrated flux */
    integratedFlux?: number;
    /** Average cross-section */
    avgXS?: number;
}

/** Cross-section data for a single nuclide/reaction */
export interface XSCurveData {
    /** Energy values in eV */
    energy: number[];
    /** Cross-section values in barns */
    xs: number[];
    /** Nuclide name (e.g., 'U235', 'H1') */
    nuclide: string;
    /** Reaction MT number or name */
    reaction: string | number;
    /** Reaction label */
    label: string;
    /** Temperature for this curve (K) */
    temperature?: number;
    /** Whether this is a macroscopic cross-section (1/cm) */
    isMacroscopic?: boolean;
}

/** Complete XS plot data for multiple nuclides/reactions */
export interface XSPlotData {
    /** All curves to plot */
    curves: XSCurveData[];
    /** Temperature in Kelvin (for single temperature plots) */
    temperature?: number;
    /** Reaction rates if flux was provided */
    reactionRates?: XSReactionRate[];
    /** Error message if any */
    error?: string;
}

/** Available reactions for XS plotting */
export const COMMON_XS_REACTIONS: XSReaction[] = [
    { mt: 1, label: 'Total (n,total)', selected: true },
    { mt: 2, label: 'Elastic (n,elastic)', selected: false },
    { mt: 18, label: 'Fission (n,fission)', selected: true },
    { mt: 102, label: 'Capture (n,gamma)', selected: true },
    { mt: 103, label: 'Proton (n,p)', selected: false },
    { mt: 104, label: 'Deuteron (n,d)', selected: false },
    { mt: 105, label: 'Triton (n,t)', selected: false },
    { mt: 106, label: 'Helium-3 (n,He3)', selected: false },
    { mt: 107, label: 'Alpha (n,alpha)', selected: false },
    { mt: 16, label: '2n (n,2n)', selected: false },
    { mt: 17, label: '3n (n,3n)', selected: false },
    { mt: 22, label: 'nα (n,nα)', selected: false },
    { mt: 28, label: 'np (n,np)', selected: false },
    { mt: 41, label: '2np (n,2np)', selected: false },
];

/** Request for XS plot data */
export interface XSPlotRequest {
    /** List of nuclide names (e.g., ['U235', 'U238', 'H1']) */
    nuclides: string[];
    /** List of reaction MT numbers or names */
    reactions: (number | string)[];
    /** Temperature in Kelvin (default 294K) */
    temperature?: number;
    /** Multiple temperatures for comparison (overrides temperature if set) */
    temperatureComparison?: XSTemperatureComparison;
    /** Energy range [min, max] in eV */
    energyRange?: [number, number];
    /** Energy region preset (alternative to energyRange) */
    energyRegion?: XSEnergyRegion;
    /** Path to cross_sections.xml (optional, overrides environment variable) */
    crossSectionsPath?: string;
    /** Materials to plot (alternative to nuclides for mixed materials) */
    materials?: XSMaterial[];
    /** Flux spectrum for reaction rate calculation (optional) */
    fluxSpectrum?: XSFluxSpectrum;
}
