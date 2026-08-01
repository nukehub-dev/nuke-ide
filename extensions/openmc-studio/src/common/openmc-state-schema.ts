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

/**
 * Surface definitions for Constructive Solid Geometry (CSG).
 * OpenMC supports various quadratic surfaces for defining geometry regions.
 * @see {@link OpenMCSurface}
 */

/** Surface types supported by OpenMC CSG */
export type OpenMCSurfaceType =
    | 'sphere'
    | 'x-cylinder'
    | 'y-cylinder'
    | 'z-cylinder'
    | 'x-plane'
    | 'y-plane'
    | 'z-plane'
    | 'plane'
    | 'x-cone'
    | 'y-cone'
    | 'z-cone'
    | 'x-torus'
    | 'y-torus'
    | 'z-torus'
    | 'quadric'
    | 'cylinder';

/** Surface coefficient definitions by type */
export interface OpenMCSurfaceCoefficients {
    sphere: { x0: number; y0: number; z0: number; r: number };
    'x-cylinder': { y0: number; z0: number; r: number };
    'y-cylinder': { x0: number; z0: number; r: number };
    'z-cylinder': { x0: number; y0: number; r: number };
    'x-plane': { x0: number };
    'y-plane': { y0: number };
    'z-plane': { z0: number };
    plane: { a: number; b: number; c: number; d: number };
    'x-cone': { x0: number; y0: number; z0: number; r2: number };
    'y-cone': { x0: number; y0: number; z0: number; r2: number };
    'z-cone': { x0: number; y0: number; z0: number; r2: number };
    'x-torus': { x0: number; y0: number; z0: number; a: number; b: number; c: number };
    'y-torus': { x0: number; y0: number; z0: number; a: number; b: number; c: number };
    'z-torus': { x0: number; y0: number; z0: number; a: number; b: number; c: number };
    quadric: { a: number; b: number; c: number; d: number; e: number; f: number; g: number; h: number; j: number; k: number };
    cylinder: { x0: number; y0: number; z0: number; r: number; vx: number; vy: number; vz: number };
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

/**
 * Cell and region definitions for CSG geometry.
 * Cells define material-filled regions using boolean combinations of surfaces.
 * @see {@link OpenMCCell}
 * @see {@link OpenMCRegionNode}
 */

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

/**
 * Universe definitions for hierarchical geometry.
 * Universes group cells together and can be nested within lattices or other cells.
 * @see {@link OpenMCUniverse}
 */

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

/**
 * Lattice definitions for repeated geometry structures.
 * Supports rectangular and hexagonal lattice arrangements.
 * @see {@link OpenMCLattice}
 */

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

/**
 * DAGMC (Direct Accelerated Geometry Monte Carlo) model information.
 * Used for direct CAD-based geometry without CSG conversion.
 * @see {@link DAGMCInfo}
 * @see {@link OpenMCSettings.dagmcFile}
 */

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
    /** Auto-resolve geometry ID conflicts on the DAGMC universe (auto_geom_ids) */
    autoGeomIds?: boolean;
    /** Auto-resolve material ID conflicts on the DAGMC universe (auto_mat_ids) */
    autoMatIds?: boolean;
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

/**
 * Material definitions composed of nuclides and optional thermal scattering data.
 * @see {@link OpenMCMaterial}
 * @see {@link OpenMCNuclide}
 */

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
    densityUnit: 'g/cm3' | 'kg/m3' | 'atom/b-cm' | 'sum' | 'macro';
    /** List of nuclides in the material */
    nuclides: OpenMCNuclide[];
    /** List of S(α,β) thermal scattering data */
    thermalScattering: OpenMCThermalScattering[];
    /** Macroscopic (multigroup) cross section data; when set, the material carries no nuclide decomposition */
    macroscopic?: {
        /** Name of the macroscopic data set in the MGXS library (e.g. 'UO2') */
        name: string;
    };
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

/**
 * External source definitions for fixed-source and eigenvalue simulations.
 * Supports various spatial, energy, and angular distributions.
 * @see {@link OpenMCSource}
 */

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
    OpenMCPointSourceSpatial | OpenMCBoxSourceSpatial | OpenMCSphereSourceSpatial | OpenMCCylinderSourceSpatial;

/** Source energy distribution types */
export type OpenMCSourceEnergyType = 'discrete' | 'uniform' | 'maxwell' | 'watt' | 'muir' | 'normal' | 'tabular';

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

/** Muir energy distribution (D-T fusion; a Normal parameterized by e0/m_rat/kt) */
export interface OpenMCMuirEnergy extends OpenMCSourceEnergyBase {
    type: 'muir';
    e0: number;
    m_rat: number;
    kt: number;
}

/**
 * Normal (Gaussian) energy distribution — the form Muir serializes to in this
 * OpenMC version (muir() is a function returning Normal; XML is type="normal"
 * with mean/std_dev parameters, univariate.py:1243-1267).
 */
export interface OpenMCNormalEnergy extends OpenMCSourceEnergyBase {
    type: 'normal';
    /** Mean of the Gaussian [eV] */
    mean: number;
    /** Standard deviation of the Gaussian [eV] */
    stdDev: number;
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
    | OpenMCNormalEnergy
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

/** Source type discriminator */
export type OpenMCSourceType = 'independent' | 'file' | 'compiled' | 'mesh' | 'tokamak';

/**
 * Constraints on sampled source particles.
 * Maps to the `<constraints>` sub-element of `<source>` in settings.xml.
 * @see {@link OpenMCSourceBase.constraints}
 */
export interface OpenMCSourceConstraints {
    /** Domain type for rejection-based constraints */
    domainType?: 'cell' | 'material' | 'universe';
    /** Domain IDs the sampled site must be within */
    domainIds?: number[];
    /** Only accept sites in fissionable material */
    fissionable?: boolean;
    /** Energy bounds [min, max] in eV the sampled site must be within */
    energyBounds?: [number, number];
    /** Time bounds [min, max] in seconds the sampled site must be within */
    timeBounds?: [number, number];
    /** What happens when a site is rejected: resample a new site or kill the particle */
    rejectionStrategy?: 'resample' | 'kill';
}

/** Base source definition shared by all source types */
export interface OpenMCSourceBase {
    /** Source name/ID */
    id?: string;
    /** Source type; absent means 'independent' (backward compatible with pre-1.2 project files) */
    type?: OpenMCSourceType;
    /** Source strength (relative weight when multiple sources are defined) */
    strength?: number;
    /** Constraints on sampled source particles */
    constraints?: OpenMCSourceConstraints;
}

/** Independent source: explicit spatial/energy/angular distributions */
export interface OpenMCIndependentSource extends OpenMCSourceBase {
    type?: 'independent';
    /** Spatial distribution */
    spatial: OpenMCSourceSpatial;
    /** Energy distribution */
    energy: OpenMCSourceEnergy;
    /** Angular distribution (default: isotropic) */
    angle?: OpenMCSourceAngle;
    /** Particle type: 'neutron', 'photon' */
    particle?: 'neutron' | 'photon';
    /** Time distribution (for time-dependent problems) */
    time?: {
        type: 'delta' | 'uniform' | 'discrete';
        params: { times?: number[]; probabilities?: number[]; min?: number; max?: number; time?: number };
    };
}

/** File source: particles read from a source file (e.g. surface source file) */
export interface OpenMCFileSource extends OpenMCSourceBase {
    type: 'file';
    /** Path to the source file */
    path: string;
}

/** Compiled source: particles sampled by a compiled shared library */
export interface OpenMCCompiledSource extends OpenMCSourceBase {
    type: 'compiled';
    /** Path to the compiled shared library */
    library: string;
    /** Parameter string passed to the library function */
    parameters?: string;
}

/**
 * Mesh source: spatial sampling over mesh elements (openmc.MeshSource,
 * source.py:484 — versionadded 0.15.0). Sites are sampled uniformly within
 * mesh elements; the element is chosen by relative sub-source strengths.
 * The source strength is the SUM of sub-source strengths (computed, not
 * stored). NOTE: this OpenMC version requires exactly one sub-source per
 * mesh element (source.py sources setter: len(sources) == mesh.n_elements);
 * spatial distributions on sub-sources are ignored at runtime.
 */
export interface OpenMCMeshSource extends OpenMCSourceBase {
    type: 'mesh';
    /** Reference to a mesh in state.meshes (emitted into settings.xml, not tallies.xml) */
    meshId?: number;
    /** Per-element sub-sources; count must equal the mesh's element count */
    sources: OpenMCIndependentSource[];
}

/**
 * Tokamak neutron source (openmc.TokamakSource, source.py:901 — versionadded
 * 0.15.4). Samples positions from a Miller-style flux-surface parameterization
 * with a user-provided emission profile S(r/a). NOTE: this class has no
 * ion-temperature or fuel-composition model — the neutron energy comes from
 * an explicit energy distribution (single distribution applied at all radii;
 * per-radius distribution lists and the optional time distribution are not
 * modeled by the IDE).
 */
export interface OpenMCTokamakSource extends OpenMCSourceBase {
    type: 'tokamak';
    /** Major radius R0 [cm] (> 0) */
    majorRadius: number;
    /** Minor radius a [cm] (> 0, must be < majorRadius) */
    minorRadius: number;
    /** Plasma elongation κ (> 0) */
    elongation: number;
    /** Plasma triangularity δ ∈ [-1, 1] */
    triangularity: number;
    /** Shafranov shift Δ [cm] (>= 0, must be < minorRadius / 2) */
    shafranovShift: number;
    /**
     * Emission profile S(r/a) as (r, s) pairs. r values must start at 0, end
     * at 1, and strictly increase; s values must be >= 0 with at least one
     * positive (arbitrary units — not normalized).
     */
    profile: { r: number; s: number }[];
    /** Neutron energy distribution (single distribution, applied at all radii) */
    energy: OpenMCSourceEnergy;
    /** Starting toroidal angle [rad] (default 0) */
    phiStart?: number;
    /** Toroidal angle extent [rad] (default 2π; must be in (0, 2π]) */
    phiExtent?: number;
    /** Poloidal angle grid points for CDF sampling (default 101, must be > 2) */
    nAlpha?: number;
    /** Vertical shift of the plasma center [cm] (default 0) */
    verticalShift?: number;
    /**
     * Optional time distribution (source.py TokamakSource.time; absent =
     * particles born at t=0). NOTE: per-radius energy lists are NOT modeled
     * (the UI keeps a single energy distribution for all radii).
     */
    time?: OpenMCIndependentSource['time'];
}

/** External source definition (discriminated union over source types) */
export type OpenMCSource = OpenMCIndependentSource | OpenMCFileSource | OpenMCCompiledSource | OpenMCMeshSource | OpenMCTokamakSource;

// ============================================================================
// Settings - Run Configuration
// ============================================================================

/**
 * Simulation run mode configuration.
 * Supports eigenvalue, fixed-source, and volume calculation modes.
 * @see {@link OpenMCRunSettings}
 */

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
    /** Number of inactive batches (required for random ray fixed source mode) */
    inactive?: number;
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

/**
 * Complete simulation settings including run parameters, sources, and output options.
 * This is the main settings interface used to generate settings.xml.
 * @see {@link OpenMCSettings}
 */

/** Shannon entropy mesh for convergence monitoring */
export interface OpenMCEntropyMesh {
    /** Mesh ID written to settings.xml (auto-assigned when absent) */
    id?: number;
    /** Lower-left corner */
    lowerLeft: [number, number, number];
    /** Upper-right corner */
    upperRight: [number, number, number];
    /** Number of mesh cells in each dimension */
    shape: [number, number, number];
}

/** Surface source writing settings (settings.xml `<surf_source_write>`) */
export interface OpenMCSurfaceSourceWrite {
    /** Surface IDs on which to bank particles */
    surfaceIds?: number[];
    /** Cell ID for source banking (crossing in either direction) */
    cell?: number;
    /** Cell ID for source banking (leaving the cell) */
    cellfrom?: number;
    /** Cell ID for source banking (entering the cell) */
    cellto?: number;
    /** Maximum number of particles banked per process */
    maxParticles?: number;
    /** Maximum number of surface source files written */
    maxSourceFiles?: number;
    /** Write MCPL-format files instead of HDF5 */
    mcpl?: boolean;
}

/** Collision track output settings (settings.xml `<collision_track>`) */
export interface OpenMCCollisionTrack {
    /** Maximum number of collisions to record */
    maxCollisions?: number;
    /** Reaction filter: MT numbers or reaction names */
    reactions?: (number | string)[];
    /** Material ID filter */
    materialIds?: number[];
    /** Nuclide filter (e.g. 'U235') */
    nuclides?: string[];
    /** Cell ID filter */
    cellIds?: number[];
    /** Universe ID filter */
    universeIds?: number[];
    /** Deposited energy threshold in eV */
    depositedEnergyThreshold?: number;
    /** Maximum number of collision track files */
    maxCollisionTrackFiles?: number;
    /** Write MCPL-format file */
    mcpl?: boolean;
}

/** Random ray solver settings (settings.xml `<random_ray>`, openmc/settings.py) */
export interface OpenMCRandomRaySettings {
    /** Total inactive distance in cm a ray travels */
    distanceInactive?: number;
    /** Total active distance in cm a ray travels */
    distanceActive?: number;
    /** Assumed source distribution shape within each source region */
    sourceShape?: 'flat' | 'linear' | 'linear_xy';
    /** Volume estimator for the solver */
    volumeEstimator?: 'naive' | 'simulation_averaged' | 'hybrid';
    /** Normalize flux tallies by volume */
    volumeNormalizedFluxTallies?: boolean;
    /** Sampling method for ray starting points */
    sampleMethod?: 'prng' | 'halton' | 's2';
    /** Diagonal stabilization parameter rho (0 disables) */
    diagonalStabilizationRho?: number;
    /** Enable adjoint flux mode (FW-CADIS: forward solve then adjoint solve) */
    adjoint?: boolean;
    /** Source region mesh ID (references a regular mesh in state.meshes) */
    sourceRegionMeshId?: number;
    /** Source region domain type */
    sourceRegionDomainType?: 'cell' | 'material' | 'universe';
    /** Source region domain IDs covered by the mesh */
    sourceRegionDomainIds?: number[];
    /** Ray source: uniform spatial box over the domain */
    raySource?: {
        lowerLeft: [number, number, number];
        upperRight: [number, number, number];
    };
    /**
     * Adjoint source: uniform spatial box defining the localized adjoint
     * source / detector response function (settings.py:243). XML emits a
     * single independent box source inside `<adjoint_source>` (the API
     * accepts a list; the UI models the common single-source case).
     */
    adjointSource?: {
        lowerLeft: [number, number, number];
        upperRight: [number, number, number];
    };
}

/** Inline CMFD mesh specification (openmc.cmfd.CMFDMesh properties) */
export interface OpenMCCmfdMesh {
    /** Lower-left corner of the mesh bounds */
    lowerLeft?: [number, number, number];
    /** Upper-right corner of the mesh bounds */
    upperRight?: [number, number, number];
    /** Number of mesh cells in each dimension */
    dimension?: [number, number, number];
    /** Albedo boundary condition per face [-x, +x, -y, +y, -z, +z], 0-1 (default all 1) */
    albedo?: [number, number, number, number, number, number];
}

/**
 * CMFD (Coarse Mesh Finite Difference) acceleration settings.
 * Maps to openmc.cmfd.CMFDMesh/CMFDRun in the Python API. NOTE: this OpenMC
 * version has no settings.xml representation for CMFD — the config persists
 * in the project file and in generated Python only.
 */
export interface OpenMCCmfdSettings {
    /** Whether CMFD acceleration is enabled */
    enabled?: boolean;
    /** Reference to a regular mesh in state.meshes (takes precedence over inline spec) */
    meshRef?: number;
    /** Inline mesh specification (used when meshRef is not set) */
    mesh?: OpenMCCmfdMesh;
    /** Feedback: adjust fission source weights from the CMFD diffusion result each batch */
    feedback?: boolean;
    /** Batch at which CMFD tallies begin accumulating */
    tallyBegin?: number;
    /** Batch at which the CMFD solver starts executing */
    solverBegin?: number;
    /** Eigenvalue tolerance for CMFD power iteration (cmfd_ktol) */
    cmfdKtol?: number;
    /** Fission source tolerance for CMFD power iteration (stol) */
    stol?: number;
    /** Normalization factor for the CMFD fission source distribution */
    norm?: number;
    /** Gauss-Seidel inner tolerances [absolute, relative] */
    gaussSeidelTolerance?: [number, number];
    /** Use effective downscatter cross section for 2-group CMFD */
    downscatter?: boolean;
    /** Show power iteration convergence during the run */
    powerMonitor?: boolean;
    /** Tally window scheme for accumulating CMFD tallies */
    windowType?: 'expanding' | 'rolling' | 'none';
    /** Window size (only for 'rolling') */
    windowSize?: number;
    /** Run an adjoint calculation on the last batch */
    runAdjoint?: boolean;
    /** Adjoint matrix construction type */
    adjointType?: 'physical' | 'math';
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
    /** CMFD acceleration settings (C-API feature; not written to settings.xml) */
    cmfd?: OpenMCCmfdSettings;
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
    /** Random ray solver settings (requires multigroup energy mode) */
    randomRay?: OpenMCRandomRaySettings;
    /** Path to the MGXS library file (mgxs.h5) for multi-group runs */
    mgxsLibrary?: string;
    /** Photon transport toggle */
    photonTransport?: boolean;
    /** Electron treatment for photon transport: 'led' (local energy deposition) or 'ttb' (thick-target bremsstrahlung) */
    electronTreatment?: 'led' | 'ttb';
    /** Atomic relaxation after photoelectric effect (default: true) */
    atomicRelaxation?: boolean;
    /** Output control (settings.xml `<output>`) */
    output?: {
        /** Write summary.h5 (default: true); overrides legacy {@link OpenMCSettings.outputSummary} when set */
        summary?: boolean;
        /** Write tallies.out (default: true) */
        tallies?: boolean;
        /** Output directory path */
        path?: string;
    };
    /** Particle tracks to write: [batch, generation, particle ID] triples */
    tracks?: [number, number, number][];
    /** Maximum number of tracks to write */
    maxTracks?: number;
    /** Collision track output settings */
    collisionTrack?: OpenMCCollisionTrack;
    /** Surface source writing settings */
    surfaceSourceWrite?: OpenMCSurfaceSourceWrite;
    /** Surface source reading: path to a surface source file */
    surfaceSourceRead?: {
        path?: string;
    };
    /** Restart run option: statepoint file to restart from (passed as CLI `-r`, not written to settings.xml) */
    restartFile?: string;
    /** Kinetics parameters via the Iterated Fission Probability (IFP) method */
    kinetics?: {
        /** Whether IFP kinetics tallies are auto-generated on export */
        enabled?: boolean;
        /** IFP generations (`settings.ifp_n_generation`); must be > 0 and <= inactive batches */
        ifpNGenerations?: number;
        /** Precursor groups for group-wise β_eff (DelayedGroupFilter 1..N); absent or ≤ 1 means total β_eff only */
        numPrecursorGroups?: number;
        /** Compute β_eff (auto-generates the ifp-beta-numerator tally; default true) */
        computeBetaEff?: boolean;
        /** Compute Λ_eff generation time (auto-generates the ifp-time-numerator tally; default true) */
        computeGenerationTime?: boolean;
    };
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
    /** Probability tables for unresolved resonances (`<ptables>`) */
    probabilityTables?: boolean;
    /** Event-based simulation toggle */
    eventBased?: boolean;
    /** Maximum number of lost particles */
    maxLostParticles?: number;
    /** Relative error for lost particle warning (`<rel_max_lost_particles>`) */
    relLostParticleRate?: number;
    /** Create fission neutrons (default true; false suppresses fission sites) */
    createFissionNeutrons?: boolean;
    /** Create delayed neutrons in fission (default true) */
    createDelayedNeutrons?: boolean;
    /** Scale the fission photon yield to account for delayed photon energy (default true) */
    delayedPhotonScaling?: boolean;
    /** Produce decay photons from neutron reactions instead of prompt (default false) */
    useDecayPhotons?: boolean;
    /** Number of bins for the logarithmic energy grid search */
    logGridBins?: number;
    /** Legendre→tabular conversion of multi-group scattering moment kernels */
    tabularLegendre?: {
        /** Whether the conversion is performed */
        enable?: boolean;
        /** Number of tabular points (must be > 0) */
        numPoints?: number;
    };
    /** Survival biasing (default true) */
    survivalBiasing?: boolean;
    /** Number of generations per batch (eigenvalue) */
    generationsPerBatch?: number;
    /** Maximum scattering order applied globally in multi-group mode */
    maxOrder?: number;
    /** Write the initial source distribution to file */
    writeInitialSource?: boolean;
    /** Sample among multiple sources uniformly, applying strengths as weights */
    uniformSourceSampling?: boolean;
    /**
     * Run-level tally trigger settings (settings.xml `<trigger>` block:
     * `<max_batches>` / `<batch_interval>`). `<active>true</active>` is
     * emitted automatically whenever any tally has triggers or these fields
     * are set — OpenMC requires trigger activation for per-tally triggers
     * to be evaluated.
     */
    triggers?: {
        maxBatches?: number;
        batchInterval?: number;
    };
}

// ============================================================================
// Tallies
// ============================================================================

/**
 * Tally definitions for scoring physical quantities during simulation.
 * Supports various filters, scores, and estimators.
 * @see {@link OpenMCTally}
 * @see {@link OpenMCTallyFilter}
 */

/** Tally filter types */
export type OpenMCTallyFilterType =
    | 'universe'
    | 'material'
    | 'cell'
    | 'cellborn'
    | 'cellfrom'
    | 'surface'
    | 'mesh'
    | 'meshsurface'
    | 'pre-collision'
    | 'post-collision'
    | 'energy'
    | 'energyout'
    | 'energyfunction'
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
    /** For mesh/meshsurface filter: mesh ID */
    meshId?: number;
    /** For expansion filters (legendre, spatiallegendre, sphericalharmonics, zernike, zernikeradial): expansion order */
    order?: number;
    /** For spatiallegendre filter: expansion axis */
    axis?: 'x' | 'y' | 'z';
    /** For spatiallegendre filter: minimum value along the axis */
    min?: number;
    /** For spatiallegendre filter: maximum value along the axis */
    max?: number;
    /** For sphericalharmonics filter: cosine treatment */
    cosine?: 'scatter' | 'particle';
    /** For zernike/zernikeradial filters: normalization circle (center x, y and radius) */
    center?: { x: number; y: number; r: number };
    /** For energyfunction filter: energy grid points in eV */
    energyValues?: number[];
    /** For energyfunction filter: response values at each energy grid point */
    responseValues?: number[];
    /** For energyfunction filter: interpolation scheme */
    interpolation?: 'histogram' | 'linear-linear' | 'linear-log' | 'log-linear' | 'log-log';
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

/**
 * Material perturbation derivative applied to all scores of a tally
 * (openmc.TallyDerivative, tally_derivative.py). Serializes as a top-level
 * `<derivative id variable material [nuclide]/>` element in tallies.xml; the
 * owning tally references it via a `<derivative>ID</derivative>` text
 * sub-element (tallies.py:1477-1480). NOTE: this OpenMC version has no cell
 * domain — the perturbed domain is always a material.
 */
export interface OpenMCTallyDerivative {
    /** Unique derivative ID (referenced by the owning tally; auto-assigned on export when absent) */
    id?: number;
    /** Perturbed variable */
    variable: 'density' | 'nuclide_density' | 'temperature';
    /** Perturbed material ID (references a material in state.materials) */
    materialId: number;
    /** Perturbed nuclide (only for 'nuclide_density', e.g. 'Xe135') */
    nuclide?: string;
}

/** Per-tally trigger criterion (openmc.Trigger trigger_type, trigger.py) */
export type OpenMCTallyTriggerType = 'variance' | 'std_dev' | 'rel_err';

/**
 * Per-tally trigger: finish the simulation when the tally's uncertainties
 * meet a criterion (openmc.Trigger). Serializes as a `<trigger>` sub-element
 * of `<tally>` with type/threshold attributes and an optional space-separated
 * scores attribute. Requires run-level trigger activation (`<trigger>` block
 * in settings.xml with `<active>true</active>`, emitted automatically when
 * any tally has triggers; evaluation interval comes from
 * `OpenMCSettings.triggers.batchInterval`).
 */
export interface OpenMCTallyTrigger {
    /** Trigger criterion */
    type: OpenMCTallyTriggerType;
    /** Threshold for the trigger type */
    threshold: number;
    /** Scores the trigger applies to (subset of the tally's scores; absent = all scores) */
    scores?: string[];
    /** Allow zero tally bins to be ignored when evaluating the trigger (trigger.py: can fire early with zeros) */
    ignoreZeros?: boolean;
}

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
    /** Per-tally triggers (openmc.Trigger list) */
    triggers?: OpenMCTallyTrigger[];
    /** Material perturbation derivative for this tally (openmc.TallyDerivative) */
    derivative?: OpenMCTallyDerivative;
}

// ============================================================================
// Meshes
// ============================================================================

/**
 * Mesh definitions for tally filters and variance reduction.
 * Supports regular (Cartesian), cylindrical, and spherical meshes.
 * @see {@link OpenMCMesh}
 */

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

/**
 * Variance reduction settings for improving simulation efficiency.
 * Includes weight windows, source biasing, and uniform fission site methods.
 * @see {@link OpenMCVarianceReduction}
 */

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

/** Uniform fission site settings */
export interface OpenMCUFS {
    /** Whether UFS is enabled */
    enabled?: boolean;
    /** Mesh ID for UFS (if not specified, uses weight window mesh) */
    meshId?: number;
}

/** Variance reduction settings */
export interface OpenMCVarianceReduction {
    /** Weight windows definition */
    weightWindows?: OpenMCWeightWindows;
    /** Weight window generator settings */
    weightWindowGenerator?: {
        /** Mesh ID for the generated weight windows */
        meshId?: number;
        /** Energy group boundaries in eV */
        energyBounds?: number[];
        /** Generation method: 'magic' (default) or 'fw_cadis' (requires multi-group mode) */
        method?: 'magic' | 'fw_cadis';
        /** Maximum tally realizations when generating weight windows */
        maxRealizations?: number;
        /** Tally realizations between updates */
        updateInterval?: number;
        /** Apply generated weight windows on the fly */
        onTheFly?: boolean;
        /** FW-CADIS target tally IDs (local variance reduction) */
        targetTallyIds?: number[];
        /** Legacy iterations field (maps to maxRealizations when present) */
        iterations?: number;
        /** Particle type */
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
    /** Uniform fission site settings */
    ufs?: OpenMCUFS;
}

// ============================================================================
// Depletion
// ============================================================================

/**
 * Depletion (burnup) settings for time-dependent material evolution.
 * Configures chain files, time steps, power levels, and solver methods.
 * @see {@link OpenMCDepletion}
 */

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
    /** External transfer rates between materials */
    transferRates?: OpenMCTransferRate[];
    /** Distinguish burnable materials that share the same composition */
    diffBurnableMats?: boolean;
    /** How volumes are assigned to differentiated materials */
    diffVolumeMethod?: 'divide equally' | 'match cell';
    /** Flux file paths for the independent operator (one per depletable material, aligned by index) */
    fluxFiles?: string[];
    /** MicroXS file paths for the independent operator (one per depletable material, aligned by index) */
    microxsFiles?: string[];
    /** Compute fluxes and micro cross sections from the current model via a transport solve */
    generateFromModel?: boolean;
    /** Decay-only steps (indices of timesteps) */
    decayOnlySteps?: number[];
    /** Reduce or eliminate output files */
    reduceOutput?: boolean;
}

/** External transfer rate between materials (Integrator.add_transfer_rate) */
export interface OpenMCTransferRate {
    /** Source material ID */
    material: number;
    /** Element or nuclide being transferred (e.g. 'U', 'Gd155') */
    element: string;
    /** Transfer rate value (positive = removal, negative = feed) */
    rate: number;
    /** Rate units (default '1/s') */
    units?: '1/s' | '1/min' | '1/h' | '1/d' | '1/a';
    /** Optional destination material ID */
    destinationMaterial?: number;
}

// ============================================================================
// Optimization - Parameter Sweeps
// ============================================================================

/**
 * Parameter sweep definitions for optimization and sensitivity studies.
 * Supports linear and logarithmic ranges across material, geometry, and settings parameters.
 * @see {@link OpenMCParameterSweep}
 * @see {@link OpenMCOptimizationState}
 */

/** Parameter sweep definition for optimization studies */
export interface OpenMCParameterSweep {
    /** Unique sweep ID */
    id: number;
    /** Sweep name/description */
    name: string;
    /** Whether this sweep is enabled */
    enabled: boolean;
    /** Parameter variable name (e.g., 'enrichment', 'pitch') */
    variable: string;
    /** Parameter type category */
    parameterType: 'material' | 'geometry' | 'settings';
    /** JSON path to parameter (e.g., 'materials.0.density') */
    parameterPath: string;
    /** Range type: linear or logarithmic */
    rangeType: 'linear' | 'logarithmic';
    /** Start value */
    startValue: number;
    /** End value */
    endValue: number;
    /** Number of sweep points */
    numPoints: number;
    /** Computed values (auto-generated) */
    values?: number[];
    /** Unit label (e.g., 'g/cm³', 'cm') */
    unit?: string;
}

/** Single optimization result */
export interface OptimizationResult {
    /** Iteration number */
    iteration: number;
    /** Parameter values for this iteration */
    parameterValues: Record<string, number>;
    /** k-effective value */
    keff?: number;
    /** k-effective standard deviation */
    keffStd?: number;
    /** Tally results: tally ID → value mapping */
    tallies?: Record<string, number>;
    /** Execution time in seconds */
    executionTime: number;
    /** Path to statepoint file */
    statepointPath?: string;
    /** Whether this iteration completed successfully */
    success: boolean;
    /** Error message if failed */
    errorMessage?: string;
}

/** Optimization run state */
export interface OpenMCOptimizationRun {
    /** Unique run ID */
    id: string;
    /** Run name */
    name: string;
    /** Run status */
    status: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
    /** Sweep configuration */
    sweepConfig: OpenMCParameterSweep[];
    /** Current iteration */
    currentIteration: number;
    /** Total iterations */
    totalIterations: number;
    /** Results array */
    results: OptimizationResult[];
    /** Start timestamp */
    startTime?: string;
    /** End timestamp */
    endTime?: string;
    /** Paths to generated statepoint files */
    statepointFiles: string[];
    /**
     * Output directory path (relative to project root for portability)
     * e.g., "optimization/run-1234567890"
     */
    outputDirectory?: string;
}

/** Complete optimization state */
export interface OpenMCOptimizationState {
    /** Parameter sweep definitions */
    parameterSweeps: OpenMCParameterSweep[];
    /** Optimization runs (completed and in-progress) */
    optimizationRuns: OpenMCOptimizationRun[];
    /** Currently active run ID */
    activeRunId?: string;
}

// ============================================================================
// Complete State
// ============================================================================

/**
 * The complete OpenMC simulation state.
 * This is the central data model for the no-code simulation builder,
 * enabling bi-directional sync between the GUI and XML files.
 * @see {@link OpenMCState}
 */

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
    /** Optimization settings */
    optimization?: OpenMCOptimizationState;
    /** Plots configuration (for OpenMC's built-in plotting) */
    plots?: OpenMCPlotConfig[];
}

/** Plot configuration for OpenMC's built-in plotting */
export interface OpenMCPlotConfig {
    /** Plot ID */
    id: number;
    /** Plot type */
    type: 'slice' | 'voxel' | 'solid-raytrace' | 'wireframe-raytrace';
    /** Plot name (optional display name) */
    name?: string;
    /** Basis plane: 'xy', 'xz', 'yz' (slice only) */
    basis: 'xy' | 'xz' | 'yz';
    /** Origin coordinates (center for slice/voxel) */
    origin: [number, number, number];
    /** Width in x-direction (for slice) */
    width?: number;
    /** Height in y-direction (for slice) */
    height?: number;
    /** Pixel resolution [x, y] (for slice and ray-trace plots) */
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
    /** Camera position (ray-trace plots) */
    cameraPosition?: [number, number, number];
    /** Point the camera looks at (ray-trace plots) */
    lookAt?: [number, number, number];
    /** Camera up vector (ray-trace plots) */
    up?: [number, number, number];
    /** Horizontal field of view in degrees (ray-trace plots) */
    horizontalFieldOfView?: number;
    /** Orthographic projection width; 0/absent means perspective (ray-trace plots) */
    orthographicWidth?: number;
    /** Light position (solid ray-trace; defaults to camera position) */
    lightPosition?: [number, number, number];
    /** Diffuse light fraction (solid ray-trace) */
    diffuseFraction?: number;
    /** Domain IDs rendered opaque (solid ray-trace) */
    opaqueIds?: number[];
    /** Wireframe line thickness in pixels (wireframe ray-trace) */
    wireframeThickness?: number;
    /** Wireframe line color as RGB triple (wireframe ray-trace) */
    wireframeColor?: [number, number, number];
    /** Domain IDs outlined by the wireframe (wireframe ray-trace) */
    wireframeIds?: number[];
}

// ============================================================================
// Project File
// ============================================================================

/**
 * Project file structure for saving and loading simulations.
 * Uses JSON format with schema versioning for migration support.
 * @see {@link OpenMCProjectFile}
 */

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

/**
 * Project template definitions for common reactor physics scenarios.
 * Templates provide pre-configured initial states for rapid model development.
 * @see {@link OpenMCProjectTemplate}
 */

/** Project template types */
export type OpenMCProjectTemplateType = 'pin-cell' | 'fuel-assembly' | 'full-core' | 'shielding' | 'criticallity-safety' | 'blank';

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

/** Current schema version (for migration support; see openmc-state-migration.ts) */
export const OPENMC_STATE_SCHEMA_VERSION = '1.1.0';
