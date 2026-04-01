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
 * OpenMC State Schema
 * 
 * This file defines the JSON schema for the complete OpenMC simulation state.
 * It serves as the central data model for the no-code simulation builder,
 * enabling bi-directional sync between the GUI and XML files.
 * 
 * @module openmc-studio/common
 */

// ============================================================================
// Core Metadata
// ============================================================================

/** Project metadata for OpenMC simulation */
export interface OpenMCProjectMetadata {
    /** Schema version for migration/compatibility */
    version: string;
    /** Project name */
    name: string;
    /** Optional project description */
    description?: string;
    /** Author information */
    author?: string;
    /** Creation timestamp (ISO 8601) */
    created: string;
    /** Last modification timestamp (ISO 8601) */
    modified: string;
}

// ============================================================================
// Geometry - Surfaces
// ============================================================================

/** Surface types supported by OpenMC CSG */
export type OpenMCSurfaceType =
    | 'sphere'
    | 'x-cylinder' | 'y-cylinder' | 'z-cylinder'
    | 'x-plane' | 'y-plane' | 'z-plane' | 'plane'
    | 'x-cone' | 'y-cone' | 'z-cone'
    | 'x-torus' | 'y-torus' | 'z-torus'
    | 'quadric'
    | 'cylinder';

/** Surface coefficient definitions by type */
export interface OpenMCSurfaceCoefficients {
    'sphere': { x0: number; y0: number; z0: number; r: number };
    'x-cylinder': { y0: number; z0: number; r: number };
    'y-cylinder': { x0: number; z0: number; r: number };
    'z-cylinder': { x0: number; y0: number; r: number };
    'x-plane': { x0: number };
    'y-plane': { y0: number };
    'z-plane': { z0: number };
    'plane': { a: number; b: number; c: number; d: number };
    'x-cone': { x0: number; y0: number; z0: number; r2: number };
    'y-cone': { x0: number; y0: number; z0: number; r2: number };
    'z-cone': { x0: number; y0: number; z0: number; r2: number };
    'x-torus': { x0: number; y0: number; z0: number; a: number; b: number; c: number };
    'y-torus': { x0: number; y0: number; z0: number; a: number; b: number; c: number };
    'z-torus': { x0: number; y0: number; z0: number; a: number; b: number; c: number };
    'quadric': { a: number; b: number; c: number; d: number; e: number; f: number; g: number; h: number; j: number; k: number };
    'cylinder': { x0: number; y0: number; z0: number; r: number; vx: number; vy: number; vz: number };
}

/** Boundary condition types for surfaces */
export type OpenMCBoundaryCondition = 'vacuum' | 'reflective' | 'periodic' | 'white' | 'transmission';

/** Surface definition in OpenMC geometry */
export interface OpenMCSurface {
    /** Unique surface ID (positive integer) */
    id: number;
    /** Surface type */
    type: OpenMCSurfaceType;
    /** Surface coefficients - keys depend on surface type */
    coefficients: OpenMCSurfaceCoefficients[OpenMCSurfaceType];
    /** Boundary condition */
    boundary?: OpenMCBoundaryCondition;
    /** Human-readable name/description */
    name?: string;
    /** Periodic surface pair ID (for periodic BC) */
    periodicSurfaceId?: number;
}

// ============================================================================
// Geometry - Cells and Regions
// ============================================================================

/** Boolean operators for region expressions */
export type OpenMCRegionOperator = 'intersection' | 'union' | 'complement' | 'difference';

/** Region node in boolean expression tree */
export interface OpenMCRegionNode {
    /** Node type */
    type: 'surface' | 'operator' | 'cell';
    /** For surface nodes: surface ID with sign (+ for positive, - for negative) */
    surfaceId?: number;
    /** For operator nodes: operator type */
    operator?: OpenMCRegionOperator;
    /** Child nodes (for operators) */
    children?: OpenMCRegionNode[];
    /** For cell reference nodes */
    cellId?: number;
}

/** Fill type for a cell */
export type OpenMCFillType = 'material' | 'universe' | 'lattice' | 'void';

/** Cell definition in OpenMC geometry */
export interface OpenMCCell {
    /** Unique cell ID (positive integer) */
    id: number;
    /** Cell name */
    name?: string;
    /** Region specification as boolean expression tree */
    region?: OpenMCRegionNode;
    /** Region as string expression (alternative to tree) */
    regionString?: string;
    /** Fill type */
    fillType: OpenMCFillType;
    /** Fill ID: material ID, universe ID, or lattice ID */
    fillId?: number;
    /** Material name (for display purposes) */
    materialName?: string;
    /** Temperature in Kelvin (for multigroup calculations) */
    temperature?: number;
    /** Cell density in g/cm³ (if specified, overrides material density) */
    density?: number;
}

// ============================================================================
// Geometry - Universes
// ============================================================================

/** Universe definition */
export interface OpenMCUniverse {
    /** Universe ID (0 is the root/unused universe) */
    id: number;
    /** Universe name */
    name?: string;
    /** Cells in this universe */
    cellIds: number[];
    /** Whether this is the root universe */
    isRoot?: boolean;
}

// ============================================================================
// Geometry - Lattices
// ============================================================================

/** Lattice types */
export type OpenMCLatticeType = 'rect' | 'hex' | 'x-hex' | 'y-hex';

/** Rectangular lattice definition */
export interface OpenMCRectLattice {
    type: 'rect';
    /** Lower-left corner coordinates [x, y, z] */
    lowerLeft: [number, number, number];
    /** Pitch (cell dimensions) [dx, dy] or [dx, dy, dz] */
    pitch: [number, number] | [number, number, number];
    /** Universe array dimensions [nx, ny] or [nx, ny, nz] */
    dimensions: [number, number] | [number, number, number];
    /** Universe IDs filling the lattice (flattened or nested array) */
    universes: number[][][];
}

/** Hexagonal lattice definition */
export interface OpenMCHexLattice {
    type: 'hex' | 'x-hex' | 'y-hex';
    /** Center coordinates [x, y] or [x, y, z] */
    center: [number, number] | [number, number, number];
    /** Pitch (distance between opposite sides) */
    pitch: [number] | [number, number];
    /** Number of rings (2D) or ring-universe pattern (3D) */
    rings?: number;
    /** Axial lattice (for 3D hex lattices) */
    axial?: {
        pitch: number;
        offset: number;
        nStacks: number;
    };
    /** Universe IDs for each ring/position */
    universes: number[][][];
}

/** Lattice definition (union of lattice types) */
export type OpenMCLattice = (OpenMCRectLattice | OpenMCHexLattice) & {
    /** Unique lattice ID */
    id: number;
    /** Lattice name */
    name?: string;
    /** Outer universe ID (for positions outside lattice) */
    outer?: number;
};

// ============================================================================
// DAGMC Geometry
// ============================================================================

/** DAGMC volume information */
export interface DAGMCVolume {
    id: number;
    material: string;
    numTriangles: number;
    boundingBox: {
        min: [number, number, number];
        max: [number, number, number];
    };
}

/** DAGMC material information */
export interface DAGMCMaterialInfo {
    volumeCount: number;
    totalTriangles: number;
}

/** DAGMC model information (from pydagmc) */
export interface DAGMCInfo {
    filePath: string;
    fileName: string;
    volumeCount: number;
    surfaceCount: number;
    vertices: number;
    materials: Record<string, DAGMCMaterialInfo>;
    volumes: DAGMCVolume[];
    boundingBox: {
        min: [number, number, number];
        max: [number, number, number];
    };
    fileSizeMB?: number;
    totalSurfaceArea?: number;
}

// ============================================================================
// Geometry - Complete
// ============================================================================

/** Complete geometry definition */
export interface OpenMCGeometry {
    /** All surfaces defined in the model */
    surfaces: OpenMCSurface[];
    /** All cells defined in the model */
    cells: OpenMCCell[];
    /** All universes defined in the model */
    universes: OpenMCUniverse[];
    /** All lattices defined in the model */
    lattices: OpenMCLattice[];
    /** Root universe ID (default: 0) */
    rootUniverseId: number;
}

// ============================================================================
// Materials
// ============================================================================

/** Nuclide fraction type */
export type OpenMCFractionType = 'ao' | 'wo';

/** Nuclide in a material */
export interface OpenMCNuclide {
    /** Nuclide name (e.g., 'U235', 'O16') */
    name: string;
    /** Fraction value */
    fraction: number;
    /** Fraction type: 'ao' (atomic) or 'wo' (weight) */
    fractionType: OpenMCFractionType;
}

/** S(α,β) thermal scattering data */
export interface OpenMCThermalScattering {
    /** Thermal scattering name (e.g., 'c_Graphite', 'h_H2O') */
    name: string;
    /** Fraction (usually 1.0) */
    fraction: number;
}

/** Material definition */
export interface OpenMCMaterial {
    /** Unique material ID */
    id: number;
    /** Material name */
    name: string;
    /** Density value */
    density: number;
    /** Density unit: 'g/cm3', 'kg/m3', 'atom/b-cm', 'sum' */
    densityUnit: 'g/cm3' | 'kg/m3' | 'atom/b-cm' | 'sum';
    /** List of nuclides in the material */
    nuclides: OpenMCNuclide[];
    /** List of S(α,β) thermal scattering data */
    thermalScattering: OpenMCThermalScattering[];
    /** Whether material is depletable */
    isDepletable?: boolean;
    /** Optional volume in cm³ (required for depletion) */
    volume?: number;
    /** Optional temperature in K (for Doppler broadening) */
    temperature?: number;
    /** Material color for visualization (hex code) */
    color?: string;
}

// ============================================================================
// Settings - Source
// ============================================================================

/** Source spatial distribution types */
export type OpenMCSourceSpatialType = 'point' | 'box' | 'sphere' | 'cylinder' | 'cartesian' | 'cylindrical' | 'spherical';

/** Base source spatial definition */
export interface OpenMCSourceSpatialBase {
    type: OpenMCSourceSpatialType;
}

/** Point source spatial */
export interface OpenMCPointSourceSpatial extends OpenMCSourceSpatialBase {
    type: 'point';
    origin: [number, number, number];
}

/** Box source spatial */
export interface OpenMCBoxSourceSpatial extends OpenMCSourceSpatialBase {
    type: 'box';
    lowerLeft: [number, number, number];
    upperRight: [number, number, number];
}

/** Sphere source spatial */
export interface OpenMCSphereSourceSpatial extends OpenMCSourceSpatialBase {
    type: 'sphere';
    center: [number, number, number];
    radius: number;
}

/** Cylinder source spatial */
export interface OpenMCCylinderSourceSpatial extends OpenMCSourceSpatialBase {
    type: 'cylinder';
    center: [number, number, number];
    radius: number;
    height: number;
    axis: 'x' | 'y' | 'z';
}

/** Source spatial definition (union of all types) */
export type OpenMCSourceSpatial = 
    | OpenMCPointSourceSpatial 
    | OpenMCBoxSourceSpatial 
    | OpenMCSphereSourceSpatial 
    | OpenMCCylinderSourceSpatial;

/** Source energy distribution types */
export type OpenMCSourceEnergyType = 'discrete' | 'uniform' | 'maxwell' | 'watt' | 'muir' | 'tabular';

/** Base source energy definition */
export interface OpenMCSourceEnergyBase {
    type: OpenMCSourceEnergyType;
}

/** Discrete energy distribution */
export interface OpenMCDiscreteEnergy extends OpenMCSourceEnergyBase {
    type: 'discrete';
    energies: number[];
    probabilities?: number[];
}

/** Uniform energy distribution */
export interface OpenMCUniformEnergy extends OpenMCSourceEnergyBase {
    type: 'uniform';
    min: number;
    max: number;
}

/** Maxwell energy distribution */
export interface OpenMCMaxwellEnergy extends OpenMCSourceEnergyBase {
    type: 'maxwell';
    temperature: number;
}

/** Watt energy distribution */
export interface OpenMCWattEnergy extends OpenMCSourceEnergyBase {
    type: 'watt';
    a: number;
    b: number;
}

/** Muir energy distribution */
export interface OpenMCMuirEnergy extends OpenMCSourceEnergyBase {
    type: 'muir';
    e0: number;
    m_rat: number;
    kt: number;
}

/** Tabular energy distribution */
export interface OpenMCTabularEnergy extends OpenMCSourceEnergyBase {
    type: 'tabular';
    energies: number[];
    probabilities: number[];
    interpolation?: 'histogram' | 'linear-linear' | 'linear-log' | 'log-linear' | 'log-log';
}

/** Source energy distribution (union of all types) */
export type OpenMCSourceEnergy = 
    | OpenMCDiscreteEnergy 
    | OpenMCUniformEnergy 
    | OpenMCMaxwellEnergy 
    | OpenMCWattEnergy 
    | OpenMCMuirEnergy 
    | OpenMCTabularEnergy;

/** Source angular distribution */
export interface OpenMCSourceAngle {
    type: 'isotropic' | 'monodirectional' | 'polar-azimuthal' | 'mu-phi' | 'reference';
    params?: {
        mu?: number;
        phi?: number;
        referenceUvW?: [number, number, number];
    };
}

/** External source definition */
export interface OpenMCSource {
    /** Source name/ID */
    id?: string;
    /** Spatial distribution */
    spatial: OpenMCSourceSpatial;
    /** Energy distribution */
    energy: OpenMCSourceEnergy;
    /** Angular distribution (default: isotropic) */
    angle?: OpenMCSourceAngle;
    /** Source strength (particles per batch) */
    strength?: number;
    /** Particle type: 'neutron', 'photon' */
    particle?: 'neutron' | 'photon';
    /** Time distribution (for time-dependent problems) */
    time?: {
        type: 'delta' | 'uniform' | 'discrete';
        params: { times?: number[]; probabilities?: number[]; min?: number; max?: number; time?: number };
    };
}

// ============================================================================
// Settings - Run Configuration
// ============================================================================

/** Simulation run modes */
export type OpenMCRunMode = 'eigenvalue' | 'fixed source' | 'volume' | 'plot' | 'particle restart';

/** Eigenvalue simulation settings */
export interface OpenMCEigenvalueSettings {
    mode: 'eigenvalue';
    /** Number of particles per generation */
    particles: number;
    /** Number of inactive batches */
    inactive: number;
    /** Number of active batches */
    batches: number;
}

/** Fixed source simulation settings */
export interface OpenMCFixedSourceSettings {
    mode: 'fixed source';
    /** Number of particles per batch */
    particles: number;
    /** Number of batches */
    batches: number;
}

/** Volume calculation settings */
export interface OpenMCVolumeSettings {
    mode: 'volume';
    /** Number of samples for volume calculation */
    samples?: number;
    /** Lower-left bounds for sampling */
    lowerLeft?: [number, number, number];
    /** Upper-right bounds for sampling */
    upperRight?: [number, number, number];
}

/** Run settings (union of modes) */
export type OpenMCRunSettings = OpenMCEigenvalueSettings | OpenMCFixedSourceSettings | OpenMCVolumeSettings;

// ============================================================================
// Settings - Complete
// ============================================================================

/** Shannon entropy mesh for convergence monitoring */
export interface OpenMCEntropyMesh {
    /** Lower-left corner */
    lowerLeft: [number, number, number];
    /** Upper-right corner */
    upperRight: [number, number, number];
    /** Number of mesh cells in each dimension */
    shape: [number, number, number];
}

/** Main settings structure */
export interface OpenMCSettings {
    /** Run mode and parameters */
    run: OpenMCRunSettings;
    /** External source definitions (for fixed source mode) */
    sources: OpenMCSource[];
    /** Random number seed (for reproducibility) */
    seed?: number;
    /** Shannon entropy mesh for convergence monitoring */
    entropyMesh?: OpenMCEntropyMesh;
    /** Number of OpenMP threads */
    threads?: number;
    /** Verbosity level (1-10) */
    verbosity?: number;
    /** Cutoff energies and weights */
    cutoff?: {
        energyNeutron?: number;
        energyPhoton?: number;
        time?: number;
        weight?: number;
        weightAvg?: number;
    };
    /** Energy mode: 'continuous-energy' or 'multigroup' */
    energyMode?: 'continuous-energy' | 'multigroup';
    /** Photon transport toggle */
    photonTransport?: boolean;
    /** Whether to create a summary.h5 file */
    outputSummary?: boolean;
    /** Whether to create a statepoint at each batch */
    statepointBatches?: number[] | { every?: number; at?: number[] };
    /** Source point output options */
    sourcePoint?: {
        write?: boolean;
        separate?: boolean;
        batches?: number[];
        overwrite?: boolean;
        mcpl?: boolean;
    };
    /** Source rejection fraction for rejection sampling (default: 0.05) */
    sourceRejectionFraction?: number;
    /** Temperature settings for Doppler broadening */
    temperature?: {
        default?: number;
        method?: 'nearest' | 'interpolation';
        tolerance?: number;
        multipole?: boolean;
    };
    /** DAGMC geometry file path (for direct CAD geometry) */
    dagmcFile?: string;
    /** DAGMC model information (populated when importing DAGMC file) */
    dagmcInfo?: DAGMCInfo;
    /** Resonance scattering settings */
    resonanceScattering?: {
        enable?: boolean;
        method?: 'rvs' | 'dbrc' | 'wcm';
        energyMin?: number;
        energyMax?: number;
    };
    /** Probability tables for unresolved resonances */
    probabilityTables?: boolean;
    /** Event-based simulation toggle */
    eventBased?: boolean;
    /** Maximum number of lost particles */
    maxLostParticles?: number;
    /** Relative error for lost particle warning */
    relLostParticleRate?: number;
    /** Trigger settings for automatic shutdown */
    triggers?: {
        maxBatches?: number;
        batchInterval?: number;
    };
}

// ============================================================================
// Tallies
// ============================================================================

/** Tally filter types */
export type OpenMCTallyFilterType =
    | 'universe'
    | 'material'
    | 'cell'
    | 'cellborn'
    | 'surface'
    | 'mesh'
    | 'pre-collision'
    | 'post-collision'
    | 'energy'
    | 'energyout'
    | 'mu'
    | 'polar'
    | 'azimuthal'
    | 'distribcell'
    | 'delayedgroup'
    | 'time'
    | 'legendre'
    | 'spatiallegendre'
    | 'sphericalharmonics'
    | 'particle'
    | 'zernike'
    | 'zernikeradial';

/** Tally filter definition */
export interface OpenMCTallyFilter {
    /** Filter type */
    type: OpenMCTallyFilterType;
    /** Filter bins (IDs for cell/material/universe, values for energy, etc.) */
    bins: number[];
    /** For mesh filter: mesh ID */
    meshId?: number;
}

/** Tally score types */
export type OpenMCTallyScore =
    | 'absorption'
    | 'activation'
    | 'current'
    | 'elastic'
    | 'events'
    | 'fission'
    | 'flux'
    | 'heating'
    | 'heating-local'
    | 'inverse-velocity'
    | 'kappa-fission'
    | 'scatter'
    | 'scatter-1'
    | 'scatter-2'
    | 'scatter-3'
    | 'scatter-4'
    | 'total'
    | 'prompt-nu-fission'
    | 'delayed-nu-fission'
    | 'nu-fission'
    | 'nu-scatter'
    | 'nu-fission-1'
    | 'nu-fission-2'
    | 'nu-fission-3'
    | 'nu-fission-4'
    | string; // For reaction MT numbers

/** Tally estimator types */
export type OpenMCTallyEstimator = 'analog' | 'tracklength' | 'collision';

/** Tally definition */
export interface OpenMCTally {
    /** Unique tally ID */
    id: number;
    /** Tally name */
    name?: string;
    /** List of scores to compute */
    scores: OpenMCTallyScore[];
    /** List of nuclides to score ('total' for all) */
    nuclides: string[];
    /** List of filters */
    filters: OpenMCTallyFilter[];
    /** Tally estimator */
    estimator?: OpenMCTallyEstimator;
    /** Whether to multiply by atom density (for some scores) */
    multiplyDensity?: boolean;
}

// ============================================================================
// Meshes
// ============================================================================

/** Mesh types */
export type OpenMCMeshType = 'regular' | 'cylindrical' | 'spherical';

/** Regular (Cartesian) mesh */
export interface OpenMCRegularMesh {
    type: 'regular';
    /** Unique mesh ID */
    id: number;
    /** Mesh name */
    name?: string;
    /** Lower-left corner coordinates */
    lowerLeft: [number, number, number];
    /** Upper-right corner coordinates */
    upperRight: [number, number, number];
    /** Number of mesh cells in each dimension */
    dimension: [number, number, number];
}

/** Cylindrical mesh */
export interface OpenMCCylindricalMesh {
    type: 'cylindrical';
    /** Unique mesh ID */
    id: number;
    /** Mesh name */
    name?: string;
    /** Origin coordinates */
    origin?: [number, number, number];
    /** Vector along cylinder axis */
    axis?: [number, number, number];
    /** r-grid boundaries */
    rGrid: number[];
    /** phi-grid boundaries (in radians) */
    phiGrid: number[];
    /** z-grid boundaries */
    zGrid: number[];
}

/** Spherical mesh */
export interface OpenMCSphericalMesh {
    type: 'spherical';
    /** Unique mesh ID */
    id: number;
    /** Mesh name */
    name?: string;
    /** Origin coordinates */
    origin?: [number, number, number];
    /** r-grid boundaries */
    rGrid: number[];
    /** theta-grid boundaries (in radians, 0 to π) */
    thetaGrid: number[];
    /** phi-grid boundaries (in radians, 0 to 2π) */
    phiGrid: number[];
}

/** Mesh definition (union of all mesh types) */
export type OpenMCMesh = OpenMCRegularMesh | OpenMCCylindricalMesh | OpenMCSphericalMesh;

// ============================================================================
// Variance Reduction
// ============================================================================

/** Weight window settings */
export interface OpenMCWeightWindows {
    /** Mesh ID for weight windows */
    meshId: number;
    /** Lower weight bounds */
    lowerBound: number | number[];
    /** Upper weight bounds */
    upperBound?: number | number[];
    /** Survival weight */
    survivalWeight?: number;
    /** Particle type */
    particleType?: 'neutron' | 'photon';
    /** Energy bounds for energy-dependent weight windows */
    energyBounds?: number[];
}

/** Source biasing settings */
export interface OpenMCSourceBiasing {
    /** Strength bias factor */
    strengthBias?: number;
    /** Energy biasing distribution */
    energyBias?: OpenMCSourceEnergy;
    /** Spatial biasing distribution */
    spatialBias?: OpenMCSourceSpatial;
}

/** Variance reduction settings */
export interface OpenMCVarianceReduction {
    /** Weight windows definition */
    weightWindows?: OpenMCWeightWindows;
    /** Weight window generator settings */
    weightWindowGenerator?: {
        iterations?: number;
        particleType?: 'neutron' | 'photon';
    };
    /** Source biasing settings */
    sourceBiasing?: OpenMCSourceBiasing;
    /** Survival biasing toggle */
    survivalBiasing?: boolean;
    /** Cutoff settings */
    cutoff?: {
        weight?: number;
        weightAvg?: number;
    };
}

// ============================================================================
// Depletion
// ============================================================================

/** Depletion chain settings */
export interface OpenMCDepletion {
    /** Whether depletion analysis is enabled */
    enabled?: boolean;
    /** Chain file path or URL */
    chainFile?: string;
    /** Operator type: 'coupled', 'independent', 'openmc' */
    operator?: 'coupled' | 'independent' | 'openmc';
    /** Power level in Watts (for coupled depletion) */
    power?: number;
    /** Power density in W/g (alternative to power) */
    powerDensity?: number;
    /** Time steps in seconds (or with units like '1 d', '30 d') */
    timeSteps: string[] | number[];
    /** Solver method: 'cecm', 'epc', 'predictor', 'cecmr', 'epcr', 'si-cesc', 'leqi' */
    solver?: 'cecm' | 'epc' | 'predictor' | 'cecmr' | 'epcr' | 'si-cesc' | 'leqi';
    /** Number of substeps per timestep */
    substeps?: number;
    /** Transport normalization mode: 'source-rate', 'fission-q', 'energy-deposition' */
    normalizationMode?: 'source-rate' | 'fission-q' | 'energy-deposition';
    /** Fission Q values for normalization (optional) */
    fissionQ?: { [nuclide: string]: number };
    /** Decay-only steps (indices of timesteps) */
    decayOnlySteps?: number[];
    /** Reduce or eliminate output files */
    reduceOutput?: boolean;
}

// ============================================================================
// Complete State
// ============================================================================

/** Complete OpenMC simulation state */
export interface OpenMCState {
    /** Project metadata */
    metadata: OpenMCProjectMetadata;
    /** Geometry definition */
    geometry: OpenMCGeometry;
    /** Materials */
    materials: OpenMCMaterial[];
    /** Simulation settings */
    settings: OpenMCSettings;
    /** Tallies */
    tallies: OpenMCTally[];
    /** Meshes for tally filters */
    meshes: OpenMCMesh[];
    /** Variance reduction settings */
    varianceReduction?: OpenMCVarianceReduction;
    /** Depletion settings */
    depletion?: OpenMCDepletion;
    /** Plots configuration (for OpenMC's built-in plotting) */
    plots?: OpenMCPlotConfig[];
}

/** Plot configuration for OpenMC's built-in 2D plotting */
export interface OpenMCPlotConfig {
    /** Plot ID */
    id: number;
    /** Plot type: 'slice' or 'voxel' */
    type: 'slice' | 'voxel';
    /** Basis plane: 'xy', 'xz', 'yz' */
    basis: 'xy' | 'xz' | 'yz';
    /** Origin coordinates */
    origin: [number, number, number];
    /** Width in x-direction (for slice) */
    width?: number;
    /** Height in y-direction (for slice) */
    height?: number;
    /** Pixel resolution [x, y] (for slice) */
    pixels?: [number, number];
    /** Lower-left corner (for voxel) */
    lowerLeft?: [number, number, number];
    /** Upper-right corner (for voxel) */
    upperRight?: [number, number, number];
    /** Voxel dimensions [nx, ny, nz] */
    voxels?: [number, number, number];
    /** What to color by: 'cell', 'material', 'temperature', 'density' */
    colorBy: 'cell' | 'material' | 'temperature' | 'density';
    /** Whether to show mesh lines */
    meshlines?: boolean;
}

// ============================================================================
// Project File
// ============================================================================

/** Project file structure (.nuke-openmc JSON) */
export interface OpenMCProjectFile {
    /** Schema version */
    version: string;
    /** Complete simulation state */
    state: OpenMCState;
    /** File references for bi-directional sync */
    fileSync?: {
        geometryXml?: string;
        materialsXml?: string;
        settingsXml?: string;
        talliesXml?: string;
        plotsXml?: string;
    };
    /** Last sync timestamps */
    lastSync?: {
        geometry?: string;
        materials?: string;
        settings?: string;
        tallies?: string;
        plots?: string;
    };
}

// ============================================================================
// Template Types
// ============================================================================

/** Project template types */
export type OpenMCProjectTemplateType = 
    | 'pin-cell'
    | 'fuel-assembly'
    | 'full-core'
    | 'shielding'
    | 'criticallity-safety'
    | 'blank';

/** Project template */
export interface OpenMCProjectTemplate {
    /** Template ID */
    id: OpenMCProjectTemplateType;
    /** Display name */
    name: string;
    /** Template description */
    description: string;
    /** Icon identifier */
    icon: string;
    /** Default state for this template */
    defaultState: Partial<OpenMCState>;
}

// ============================================================================
// Version
// ============================================================================

/** Current schema version (for migration support) */
export const OPENMC_STATE_SCHEMA_VERSION = '1.0.0';
