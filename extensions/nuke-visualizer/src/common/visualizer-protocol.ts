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

/** 2D Heatmap slice plane orientation */
export type OpenMCHeatmapPlane = 'xy' | 'xz' | 'yz';

/** OpenMC 2D heatmap slice data */
export interface OpenMCHeatmapData {
    /** 2D array of tally values (rows x cols) */
    values: number[][];
    /** 2D array of standard deviations (optional) */
    std_dev?: number[][];
    /** X-axis coordinates (cell centers) */
    x_coords: number[];
    /** Y-axis coordinates (cell centers) */
    y_coords: number[];
    /** X-axis label */
    x_label: string;
    /** Y-axis label */
    y_label: string;
    /** Slice plane orientation */
    plane: OpenMCHeatmapPlane;
    /** Slice index in the third dimension */
    slice_index: number;
    /** Total number of slices available */
    total_slices: number;
    /** Position of the slice in cm */
    slice_position: number;
    /** Z-axis label (the slice dimension) */
    slice_label: string;
    /** Mesh dimensions [nx, ny, nz] */
    mesh_dimensions: number[];
    /** Error message if any */
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
    /** Set Python configuration for OpenMC operations */
    setPythonConfig(config: PythonConfig): Promise<void>;

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
    
    /** Get 2D heatmap slice data for a mesh tally */
    getHeatmapSlice(
        statepointPath: string,
        tallyId: number,
        plane: OpenMCHeatmapPlane,
        sliceIndex: number,
        scoreIndex?: number,
        nuclideIndex?: number
    ): Promise<OpenMCHeatmapData>;
    
    /** Get all 2D heatmap slices for a mesh tally */
    getAllHeatmapSlices(
        statepointPath: string,
        tallyId: number,
        plane: OpenMCHeatmapPlane,
        scoreIndex?: number,
        nuclideIndex?: number
    ): Promise<OpenMCHeatmapData[]>;
    
    /** Stop a running visualization server */
    stopServer(port: number): Promise<void>;
    
    /** Check if OpenMC integration is available (h5py installed) */
    checkOpenMCAvailable(): Promise<{ available: boolean; message: string; warning?: string }>;
    
    // === Cross-Section (XS) Plotting ===
    
    /** Get cross-section data for nuclides and reactions */
    getXSData(request: XSPlotRequest): Promise<XSPlotData>;
    
    /** Check if OpenMC Python module is available (for XS plotting) */
    checkOpenMCPythonAvailable(): Promise<{ available: boolean; message: string; warning?: string }>;
    
    /** Get available nuclides from cross_sections.xml */
    getAvailableNuclides(crossSectionsPath?: string): Promise<string[]>;
    
    /** Get available thermal scattering materials from cross_sections.xml */
    getAvailableThermalMaterials(crossSectionsPath?: string): Promise<string[]>;
    
    /** Get available energy group structures for multigroup XS */
    getGroupStructures(): Promise<XSGroupStructuresResponse>;
    
    // === Depletion/Burnup Visualization ===
    
    /** Get summary of depletion results */
    getDepletionSummary(filePath: string): Promise<OpenMCDepletionSummary>;
    
    /** Get list of materials from depletion results */
    getDepletionMaterials(filePath: string): Promise<OpenMCDepletionMaterial[]>;
    
    /** Get depletion data for a specific material */
    getDepletionData(
        filePath: string,
        materialIndex: number,
        nuclides?: string[],
        includeActivity?: boolean
    ): Promise<OpenMCDepletionResponse>;
    
    // === Geometry Hierarchy Viewer ===
    
    /** Get geometry hierarchy from OpenMC geometry file */
    getGeometryHierarchy(filePath: string): Promise<OpenMCGeometryResponse>;
    
    /** Visualize geometry in 3D */
    visualizeGeometry(filePath: string, highlightCellId?: number): Promise<{
        success: boolean;
        port?: number;
        url?: string;
        error?: string;
    }>;
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
    /** Resonance regions for this nuclide */
    resonanceRegions?: XSResonanceRegion[];
    /** Key resonance parameters for this nuclide */
    resonances?: XSResonanceParameter[];
    /** Library name/source for multi-library comparison */
    library?: string;
    /** Uncertainty/error data for cross-section (if available) */
    uncertainty?: XSUncertaintyData;
    /** Calculated integral quantities for this curve */
    integrals?: XSIntegralQuantities;
    /** Thermal scattering (S(alpha,beta)) data if applicable */
    thermalScattering?: XSThermalScatteringData;
    /** Derivative/slope data (dXS/dE) for this curve */
    derivative?: XSDerivativeData;
    /** Chain decay/buildup data for parent-daughter relationships */
    chainDecay?: XSChainDecayData;
    /** Multigroup cross-section data (when group structure is applied) */
    multigroup?: XSMultigroupData;
}

/** Multigroup cross-section data */
export interface XSMultigroupData {
    /** Group structure used (2, 8, 16, 70, 172) */
    groupStructure: XSGroupStructure;
    /** Number of energy groups */
    numGroups: number;
    /** Energy group boundaries (eV), length = numGroups + 1 */
    groupBoundaries: number[];
    /** Group average energies (eV), length = numGroups */
    groupEnergies: number[];
    /** Group widths (eV), length = numGroups */
    groupWidths: number[];
    /** Group cross-sections (barns), length = numGroups */
    groupXS: number[];
    /** Group flux used for weighting (optional), length = numGroups */
    groupFlux?: number[];
    /** Method used for group collapsing */
    weightingMethod: 'flux' | 'lethargy' | 'constant';
}

/** Chain decay/buildup data for cumulative cross-sections */
export interface XSChainDecayData {
    /** Parent nuclide name */
    parentNuclide: string;
    /** Decay time used for calculation (seconds) */
    decayTime: number;
    /** Daughter nuclides included in calculation */
    daughterNuclides: string[];
    /** Branching ratios for each daughter */
    branchingRatios: Record<string, number>;
    /** Cumulative cross-section (parent + daughters weighted by abundance) */
    cumulativeXS: number[];
    /** Individual contributions from each nuclide in chain */
    contributions: Record<string, number[]>;
    /** Half-lives of tracked nuclides (seconds) */
    halfLives: Record<string, number>;
    /** Derivative/slope data for cumulative XS (if calculated) */
    derivative?: XSDerivativeData;
}

/** Uncertainty/error data for cross-section */
export interface XSUncertaintyData {
    /** Standard deviation values (same length as xs) */
    stdDev?: number[];
    /** Relative uncertainty (fraction, e.g., 0.05 = 5%) */
    relative?: number[];
    /** Lower error bound (xs - error) */
    lower?: number[];
    /** Upper error bound (xs + error) */
    upper?: number[];
    /** Interpolation type used for error propagation */
    interpolation?: string;
    /** Whether covariance matrix is available */
    hasCovariance?: boolean;
}

/** Derivative/slope data for cross-section (dXS/dE) */
export interface XSDerivativeData {
    /** Derivative values dXS/dE (same length as xs) */
    dXdE: number[];
    /** Log-log derivative d(log XS)/d(log E) = (E/XS) * (dXS/dE) */
    logLogDerivative: number[];
    /** Energy points where derivative is calculated (may be shorter than xs due to differencing) */
    energy: number[];
    /** Method used for derivative calculation */
    method: 'central' | 'forward' | 'backward';
    /** Maximum absolute derivative value */
    maxSlope?: number;
    /** Energy point where maximum slope occurs */
    maxSlopeEnergy?: number;
}

/** Library definition for multi-library comparison */
export interface XSLibrary {
    /** Library name/label (e.g., 'ENDF/B-VIII.0', 'JEFF-3.3') */
    name: string;
    /** Path to cross_sections.xml for this library */
    path: string;
    /** Library color for plotting (optional) */
    color?: string;
    /** Line style for plotting (optional) */
    lineStyle?: 'solid' | 'dash' | 'dot' | 'dashdot';
}

/** Multi-library comparison request */
export interface XSLibraryComparison {
    /** List of libraries to compare */
    libraries: XSLibrary[];
    /** Nuclide to compare across libraries */
    nuclide: string;
    /** Reaction MT number */
    reaction: number | string;
    /** Temperature (K) */
    temperature?: number;
}

/** Resonance region type */
export type XSResonanceType = 'resolved' | 'unresolved';

/** Resonance region definition */
export interface XSResonanceRegion {
    /** Type of resonance region */
    type: XSResonanceType;
    /** Lower energy bound in eV */
    energyMin: number;
    /** Upper energy bound in eV */
    energyMax: number;
}

/** Individual resonance parameter */
export interface XSResonanceParameter {
    /** Energy of resonance in eV (E₀) */
    energy: number;
    /** Neutron width in eV (Γₙ) */
    neutronWidth?: number;
    /** Gamma width in eV (Γᵧ) */
    gammaWidth?: number;
    /** Fission width in eV (Γ_f) */
    fissionWidth?: number;
    /** Total width in eV (Γ) */
    totalWidth?: number;
    /** Peak cross-section in barns (σ₀) - approximate */
    peakXS?: number;
}

/** Complete XS plot data for multiple nuclides/reactions */
export interface XSPlotData {
    /** All curves to plot */
    curves: XSCurveData[];
    /** Temperature in Kelvin (for single temperature plots) */
    temperature?: number;
    /** Reaction rates if flux was provided */
    reactionRates?: XSReactionRate[];
    /** Warning messages for unavailable reactions */
    warnings?: string[];
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

/** XS Integral Quantities calculated from cross-section data */
export interface XSIntegralQuantities {
    /** Resonance integral (barns) - integral of XS from 0.5 eV to 1e5 eV divided by ln(E2/E1) */
    resonanceIntegral?: number;
    /** Thermal cross-section at 2200 m/s (0.0253 eV) in barns */
    thermalXS?: number;
    /** Maxwellian averaged cross-section at thermal temperature (barns) */
    maxwellianAverage?: number;
    /** Average XS over the plotted energy range (barns) */
    averageXS?: number;
    /** Integrated XS over full energy range (barns·eV) */
    integratedXS?: number;
    /** Fission rate factor (for fission reactions) - nu * sigma_f */
    fissionRateFactor?: number;
}

/** S(alpha, beta) thermal scattering data */
export interface XSThermalScatteringData {
    /** Thermal scattering material name (e.g., 'c_Graphite', 'h_H2O') */
    material: string;
    /** Temperature in Kelvin */
    temperature: number;
    /** Energy values in eV */
    energy: number[];
    /** Inelastic cross-section values (barns) */
    inelasticXS?: number[];
    /** Elastic cross-section values (barns) */
    elasticXS?: number[];
    /** Total thermal scattering cross-section (barns) */
    totalXS?: number[];
    /** Beta values (dimensionless energy transfer) */
    beta?: number[];
    /** Alpha values (dimensionless momentum transfer) */
    alpha?: number[][];
    /** S(alpha, beta) scattering law values */
    sab?: number[][];
}

/** Thermal scattering (S(alpha,beta)) plot request */
export interface XSThermalScatteringRequest {
    /** Thermal scattering material name (e.g., 'c_Graphite', 'h_H2O', 'h_ZrH') */
    material: string;
    /** Temperature in Kelvin (default 294K) */
    temperature?: number;
    /** Compare multiple temperatures */
    temperatures?: number[];
    /** Energy range [min, max] in eV (typically thermal range: 1e-5 to 10 eV) */
    energyRange?: [number, number];
}

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
    /** Multi-library comparison (overrides other modes if set) */
    libraryComparison?: XSLibraryComparison;
    /** Whether to extract and return uncertainty data */
    includeUncertainty?: boolean;
    /** Whether to calculate integral quantities */
    includeIntegrals?: boolean;
    /** Whether to calculate and return derivative/slope data */
    includeDerivative?: boolean;
    /** S(alpha, beta) thermal scattering mode (overrides other modes if set) */
    thermalScattering?: XSThermalScatteringRequest;
    /** Chain decay/buildup calculation for parent-daughter relationships */
    chainDecay?: XSChainDecayRequest;
    /** Multigroup structure for collapsing continuous XS */
    groupStructure?: string;
}

/** Energy group structure information */
export interface XSGroupStructureInfo {
    /** Name of the structure (e.g., '8-group', 'CASMO-8') */
    name: string;
    /** Number of groups */
    groups: number;
    /** Energy range in eV [min, max] */
    range_eV: [number, number];
}

/** Response for group structures list */
export interface XSGroupStructuresResponse {
    structures: XSGroupStructureInfo[];
    metadata: {
        openmc_available: boolean;
        sources: string[];
    };
}

/** Energy group structure for multigroup cross-sections */
export type XSGroupStructure = string;

/** Chain decay/buildup request parameters */
export interface XSChainDecayRequest {
    /** Parent nuclide (e.g., 'U235', 'Pu239') */
    parentNuclide: string;
    /** Decay time in seconds (for buildup calculations) */
    decayTime?: number;
    /** Neutron flux for activation calculations (n/cm²/s) */
    flux?: number;
    /** Include daughter products in cumulative cross-section */
    includeDaughters?: boolean;
    /** Maximum decay chain depth (default: 3) */
    maxDepth?: number;
    /** Specific daughter nuclides to track (if empty, tracks all) */
    trackDaughters?: string[];
}

// ============================================================================
// Depletion/Burnup Visualization Types
// ============================================================================

/** Depletion results summary from depletion_results.h5 */
export interface OpenMCDepletionSummary {
    /** Number of burnable materials */
    nMaterials: number;
    /** Number of time steps */
    nSteps: number;
    /** Number of nuclides tracked */
    nNuclides: number;
    /** Time points in seconds */
    timePoints: number[];
    /** Time points in days (converted) */
    timeDays: number[];
    /** Burnup values in MWd/kg (if available) */
    burnup?: number[];
    /** Source rate (particles/sec) if available */
    sourceRate?: number[];
}

/** Material information from depletion results */
export interface OpenMCDepletionMaterial {
    /** Material index */
    index: number;
    /** Material name */
    name: string;
    /** Initial volume in cm³ */
    volume?: number;
    /** Initial mass in grams */
    initialMass?: number;
}

/** Nuclide concentration data */
export interface OpenMCDepletionNuclideData {
    /** Nuclide name (e.g., 'U235', 'Pu239') */
    nuclide: string;
    /** Concentration at each time step (atoms/barn-cm) */
    concentrations: number[];
    /** Concentration in grams (if calculated) */
    massGrams?: number[];
    /** Concentration as fraction of total mass */
    massFraction?: number[];
}

/** Activity data for a nuclide */
export interface OpenMCDepletionActivityData {
    /** Nuclide name */
    nuclide: string;
    /** Activity at each time step (Bq) */
    activity: number[];
    /** Activity in curies (Ci) */
    activityCi?: number[];
    /** Decay heat at each time step (Watts) */
    decayHeat?: number[];
    /** Half-life in seconds */
    halfLife?: number;
}

/** Complete depletion data for a material */
export interface OpenMCDepletionMaterialData {
    /** Material information */
    material: OpenMCDepletionMaterial;
    /** Nuclide concentration data */
    nuclides: OpenMCDepletionNuclideData[];
    /** Total atoms per time step */
    totalAtoms: number[];
    /** Total mass per time step (grams) */
    totalMass: number[];
}

/** Request for depletion data */
export interface OpenMCDepletionRequest {
    /** Path to depletion_results.h5 file */
    filePath: string;
    /** Material index to analyze (if not specified, returns summary) */
    materialIndex?: number;
    /** Specific nuclides to include (if empty, returns all) */
    nuclides?: string[];
    /** Include activity data */
    includeActivity?: boolean;
}

/** Response for depletion data request */
export interface OpenMCDepletionResponse {
    /** Summary information */
    summary: OpenMCDepletionSummary;
    /** Material data (if materialIndex specified) */
    materialData?: OpenMCDepletionMaterialData;
    /** All materials list (if no materialIndex specified) */
    materials?: OpenMCDepletionMaterial[];
    /** Activity data (if requested) */
    activity?: OpenMCDepletionActivityData[];
    /** Error message if any */
    error?: string;
}

/** Plot type for depletion visualization */
export type DepletionPlotType = 'concentration' | 'mass' | 'activity' | 'decay_heat' | 'normalized' | 'stacked';

/** Y-axis scale type */
export type DepletionScaleType = 'linear' | 'log';

/** X-axis type */
export type DepletionXAxis = 'time' | 'burnup' | 'step';

/** Preset nuclide groups for quick selection */
export interface DepletionNuclidePreset {
    /** Preset identifier */
    id: string;
    /** Display name */
    label: string;
    /** Nuclides in this preset */
    nuclides: string[];
    /** Description */
    description: string;
}

/** Common nuclide presets for depletion analysis */
export const DEPLETION_NUCLIDE_PRESETS: DepletionNuclidePreset[] = [
    {
        id: 'actinides',
        label: 'Major Actinides',
        nuclides: ['U234', 'U235', 'U236', 'U238', 'Pu238', 'Pu239', 'Pu240', 'Pu241', 'Pu242', 'Am241', 'Am242m'],
        description: 'Primary actinides for burnup analysis'
    },
    {
        id: 'fission_products',
        label: 'Fission Products',
        nuclides: ['Xe135', 'Sm149', 'Cs137', 'I135', 'Pm147', 'Nd143', 'Nd145'],
        description: 'Important fission products with impact on reactivity and decay heat'
    },
    {
        id: 'burnable_poisons',
        label: 'Burnable Poisons',
        nuclides: ['B10', 'Gd155', 'Gd157', 'Er166', 'Er167'],
        description: 'Neutron absorbers used for reactivity control'
    },
    {
        id: 'gases',
        label: 'Noble Gases',
        nuclides: ['Kr83', 'Kr85', 'Xe131', 'Xe133', 'Xe135'],
        description: 'Gaseous fission products for gap release analysis'
    }
];

/** Time step information */
export interface DepletionTimeStep {
    /** Step index */
    index: number;
    /** Time in seconds */
    time: number;
    /** Time in days */
    days: number;
    /** Burnup in MWd/kg (if available) */
    burnup?: number;
    /** Power level in Watts (if available) */
    power?: number;
}

// ============================================================================
// Geometry Hierarchy Viewer Types
// ============================================================================

/** Type of surface in OpenMC CSG geometry */
export type OpenMCSurfaceType = 
    | 'sphere' | 'x-cylinder' | 'y-cylinder' | 'z-cylinder'
    | 'x-plane' | 'y-plane' | 'z-plane' | 'plane'
    | 'x-cone' | 'y-cone' | 'z-cone'
    | 'x-torus' | 'y-torus' | 'z-torus'
    | 'quadric' | 'cylinder' | 'sphere-general' | 'unknown';

/** Surface definition in OpenMC geometry */
export interface OpenMCSurface {
    /** Surface ID */
    id: number;
    /** Surface type */
    type: OpenMCSurfaceType;
    /** Surface coefficients (e.g., [x0, y0, z0, r] for sphere) */
    coefficients: number[];
    /** Boundary condition ('vacuum', 'reflective', 'periodic', 'white', 'transmission') */
    boundary?: string;
    /** Human-readable description */
    description?: string;
}

/** Fill type for a cell */
export type OpenMCFillType = 'material' | 'universe' | 'lattice' | 'void';

/** Cell definition in OpenMC geometry */
export interface OpenMCCell {
    /** Cell ID */
    id: number;
    /** Cell name (if defined) */
    name?: string;
    /** Region specification (CSG expression) */
    region?: string;
    /** Fill type */
    fillType: OpenMCFillType;
    /** Fill ID (material ID, universe ID, or lattice ID) */
    fillId?: number;
    /** Material name (if fillType is 'material') */
    materialName?: string;
    /** List of surface IDs referenced in region */
    surfaces: number[];
    /** Temperature in Kelvin (for multigroup calculations) */
    temperature?: number;
    /** Cell density in g/cm³ (if specified) */
    density?: number;
}

/** Lattice type */
export type OpenMCLatticeType = 'rect' | 'hex' | 'x-hex' | 'y-hex';

/** Lattice definition */
export interface OpenMCLattice {
    /** Lattice ID */
    id: number;
    /** Lattice name */
    name?: string;
    /** Lattice type */
    type: OpenMCLatticeType;
    /** Lower-left corner coordinates */
    lowerLeft?: number[];
    /** Pitch (cell dimensions) */
    pitch?: number[];
    /** Universe array dimensions [nx, ny] or [nx, ny, nz] */
    dimensions: number[];
    /** Universe IDs filling the lattice */
    universes: number[][][];
    /** Outer universe ID (for positions outside lattice) */
    outer?: number;
}

/** Universe definition */
export interface OpenMCUniverse {
    /** Universe ID */
    id: number;
    /** Universe name (if defined) */
    name?: string;
    /** Root universe flag (the top-level geometry universe) */
    isRoot: boolean;
    /** Cells in this universe */
    cells: OpenMCCell[];
    /** Number of cells */
    nCells: number;
}

/** Complete geometry hierarchy */
export interface OpenMCGeometryHierarchy {
    /** Path to geometry.xml or model file */
    filePath: string;
    /** All universes in the geometry */
    universes: OpenMCUniverse[];
    /** All surfaces defined */
    surfaces: OpenMCSurface[];
    /** All lattices defined */
    lattices: OpenMCLattice[];
    /** Root universe ID */
    rootUniverseId: number;
    /** Total number of cells */
    totalCells: number;
    /** Total number of surfaces */
    totalSurfaces: number;
    /** Total number of materials referenced */
    totalMaterials: number;
    /** Error message if parsing failed */
    error?: string;
}

/** Geometry tree selection event */
export interface GeometrySelection {
    /** Type of selected item */
    type: 'universe' | 'cell' | 'surface' | 'lattice';
    /** ID of the selected item */
    id: number;
    /** Parent universe ID (for cells) */
    parentId?: number;
    /** Optional action */
    action?: 'select' | 'highlight' | 'focus';
}

/** Cell properties for detail view */
export interface OpenMCCellProperties {
    /** Cell ID */
    id: number;
    /** Cell name */
    name?: string;
    /** Region expression */
    region: string;
    /** Parsed region tokens */
    regionTokens?: string[];
    /** Fill information */
    fill: {
        type: OpenMCFillType;
        id?: number;
        name?: string;
    };
    /** Surfaces used in this cell with their operators */
    surfaceOperations: Array<{
        surfaceId: number;
        operator: 'intersection' | 'union' | 'complement';
    }>;
    /** Bounding box if calculable */
    bounds?: {
        xmin: number; xmax: number;
        ymin: number; ymax: number;
        zmin: number; zmax: number;
    };
    /** Temperature */
    temperature?: number;
    /** Density */
    density?: number;
}

/** Request for geometry hierarchy */
export interface OpenMCGeometryRequest {
    /** Path to geometry file (geometry.xml, model XML, or Python script) */
    filePath: string;
    /** Whether to include detailed cell region parsing */
    includeDetails?: boolean;
}

/** Response for geometry hierarchy request */
export interface OpenMCGeometryResponse {
    /** Hierarchy data */
    hierarchy?: OpenMCGeometryHierarchy;
    /** Error message if failed */
    error?: string;
}
