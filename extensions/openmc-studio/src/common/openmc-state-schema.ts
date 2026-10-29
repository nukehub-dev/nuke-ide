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
    /**
     * Pre-conversion snapshot from "Convert to Multi-Group" (optional,
     * version-tolerant — no migration needed). Restored by "Revert to
     * Continuous-Energy". See `src/common/mg-conversion.ts`.
     */
    mgBackup?: {
        /** Materials as they were before macroscopic conversion */
        materials: OpenMCMaterial[];
        /** Energy mode before conversion (typically continuous-energy) */
        energyMode?: OpenMCSettings['energyMode'];
    };
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
    /**
     * Boundary albedo (importance multiplier after a boundary interaction).
     * Only meaningful for reflective, periodic, and white boundaries; OpenMC
     * ignores it on vacuum and transmission surfaces.
     */
    albedo?: number;
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
    /**
     * Cell density override; positive. Units follow the material density unit.
     * Only meaningful when the cell is filled with a material.
     */
    density?: number;
    /**
     * Intrinsic Tait-Bryan rotation in degrees (phi, theta, psi), applied as
     * Rz(psi) Ry(theta) Rx(phi). Only meaningful on cells filled with a
     * universe or lattice.
     */
    rotation?: [number, number, number];
    /** Translation in cm, applied after the rotation. */
    translation?: [number, number, number];
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
    /**
     * Universe ID. Universe 0 is the root: OpenMC XML has no explicit root
     * element, so cells without a `universe` attribute belong to universe 0
     * and every other universe must be reachable from it.
     */
    id: number;
    /** Universe name */
    name?: string;
    /** Cells in this universe */
    cellIds: number[];
}

// ============================================================================
// Geometry - Lattices
// ============================================================================

/**
 * Lattice definitions for repeated geometry structures.
 * Supports rectangular and hexagonal lattice arrangements.
 * @see {@link OpenMCLattice}
 */

/**
 * Lattice types. Hexagonal orientation is the `orientation` field, not a
 * separate type; OpenMC serializes both as `<hex_lattice>`.
 */
export type OpenMCLatticeType = 'rect' | 'hex';

/** Hexagonal lattice orientation (faces perpendicular to this axis) */
export type OpenMCHexOrientation = 'x' | 'y';

/** Rectangular lattice definition */
export interface OpenMCRectLattice {
    type: 'rect';
    /** Lower-left corner coordinates [x, y] or [x, y, z] */
    lowerLeft: [number, number] | [number, number, number];
    /** Pitch (cell dimensions) [dx, dy] or [dx, dy, dz] */
    pitch: [number, number] | [number, number, number];
    /** Universe array dimensions [nx, ny] or [nx, ny, nz] */
    dimensions: [number, number] | [number, number, number];
    /**
     * Universe IDs indexed `[z][y][x]`. The y index runs from the top row
     * (index 0) to the bottom row, matching OpenMC's `RectLattice.universes`;
     * 2D lattices carry exactly one z slice.
     */
    universes: number[][][];
}

/** Hexagonal lattice definition */
export interface OpenMCHexLattice {
    type: 'hex';
    /** Center coordinates [x, y] or [x, y, z] */
    center: [number, number] | [number, number, number];
    /** Pitch [radial] or [radial, axial] (distance between opposite sides) */
    pitch: [number] | [number, number];
    /** Number of radial rings including the center ring (OpenMC n_rings) */
    rings: number;
    /** Hexagon orientation; OpenMC defaults to 'y' */
    orientation?: OpenMCHexOrientation;
    /** Number of axial positions (OpenMC n_axial); omitted for 2D lattices */
    nAxial?: number;
    /**
     * Universe IDs indexed `[z][ring][theta]`. Ring 0 is the outermost ring
     * and theta starts at the top and proceeds clockwise, matching
     * `HexLattice.universes`; 2D lattices carry exactly one z slice.
     */
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
    /**
     * Root universe ID. OpenMC derives the root from the universe that is not
     * used as a cell fill or lattice universe, so this must be 0 for XML and
     * Python export parity; the Python API can name a different root, but XML
     * cannot represent it explicitly.
     */
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
    /**
     * NCrystal configuration string (e.g. 'LiquidWaterH2O_T293.6K.ncmat;temp=293.6K').
     * Emitted as the `<material cfg="...">` attribute so libopenmc takes thermal
     * neutron scattering from NCrystal; the nuclide list still carries the
     * flattened composition (used for non-scattering reactions and tallies).
     * Incompatible with S(α,β) and macroscopic data (openmc/material.py
     * `to_xml_element` raises on both).
     */
    ncrystalCfg?: string;
    /** Whether material is depletable */
    isDepletable?: boolean;
    /** Optional volume in cm³ (required for depletion) */
    volume?: number;
    /** Optional temperature in K (for Doppler broadening) */
    temperature?: number;
    /**
     * Nuclides whose elastic scattering is treated as isotropic in the
     * laboratory system (`Material.isotropic`; `<isotropic>` in materials.xml).
     * Empty/undefined keeps OpenMC's default anisotropic treatment.
     */
    isotropic?: string[];
    /** Material color for visualization (hex code) */
    color?: string;
    /** nuke-cad physical-model UUID carried through DAGMC import (copy provenance; never used for naming). */
    nukeCadMaterialId?: string;
    /** Parent physical-model UUID from the nuke-cad manifest. */
    nukeCadParentId?: string;
}

// ============================================================================
// Settings - Source
// ============================================================================

/**
 * External source definitions for fixed-source and eigenvalue simulations.
 * Supports various spatial, energy, and angular distributions.
 * @see {@link OpenMCSource}
 */

// ----------------------------------------------------------------------------
// Shared univariate distributions
// ----------------------------------------------------------------------------

/**
 * Univariate distribution types that OpenMC serializes to XML and accepts in
 * `openmc.stats` (energy, time, spatial coordinates, mu/phi, and mixture
 * children all use this one model).
 *
 * `openmc.stats.Legendre` is deliberately absent: its `to_xml_element()` raises
 * `NotImplementedError`, so it cannot round-trip and has no editor control.
 */
export type OpenMCUnivariateType =
    'discrete' | 'uniform' | 'maxwell' | 'watt' | 'normal' | 'powerlaw' | 'tabular' | 'mixture' | 'decay-spectrum' | 'muir';

/**
 * Nested bias distribution for a continuous univariate (`<bias type="...">`).
 * OpenMC requires the bias distribution to share the parent support interval
 * and forbids a bias distribution that is itself biased.
 */
export interface OpenMCBiasDistribution {
    /** Distribution sampled instead of the parent distribution. */
    distribution: OpenMCUnivariate;
}

/**
 * Alternative sampling probabilities for `Discrete` / `Mixture` (array bias,
 * serialized as `<bias>p1 p2 ...</bias>`) and for point-cloud / mesh spatial
 * distributions.
 */
export interface OpenMCBiasProbabilities {
    probabilities: number[];
}

/** Bias attached to a univariate distribution (energy, time, or coordinate). */
export type OpenMCUnivariateBias = OpenMCBiasDistribution | OpenMCBiasProbabilities;

/**
 * Array bias for point-cloud / mesh spatial distributions. The probabilities
 * are normalized by OpenMC and must match the number of points or mesh
 * elements.
 */
export interface OpenMCArrayBias {
    probabilities: number[];
}

/** @deprecated Use {@link OpenMCUnivariateBias}; kept as the energy-specific name. */
export type OpenMCEnergyBias = OpenMCUnivariateBias;

/** Base univariate distribution definition */
export interface OpenMCUnivariateBase {
    type: OpenMCUnivariateType;
    /**
     * Optional importance-sampling bias. Continuous distributions carry a
     * nested distribution (same support); Discrete/Mixture carry alternative
     * probabilities. Decay spectra cannot be biased (OpenMC fixes bias=None).
     */
    bias?: OpenMCUnivariateBias;
}

/**
 * Discrete distribution (`openmc.stats.Discrete`, XML type `discrete`).
 * In the schema `energies` holds the sampled values for every domain — eV for
 * energy, seconds for time, and coordinate units for spatial distributions.
 */
export interface OpenMCDiscreteUnivariate extends OpenMCUnivariateBase {
    type: 'discrete';
    /** Sampled values (eV, seconds, or coordinates) */
    energies: number[];
    /** Relative probabilities; omitted means equal probability */
    probabilities?: number[];
}

/** Uniform distribution (`openmc.stats.Uniform`, XML type `uniform`) */
export interface OpenMCUniformUnivariate extends OpenMCUnivariateBase {
    type: 'uniform';
    min: number;
    max: number;
}

/**
 * Maxwellian energy distribution (`openmc.stats.Maxwell`, XML type `maxwell`).
 * `temperature` is OpenMC's effective temperature theta in eV (not kelvin).
 */
export interface OpenMCMaxwellUnivariate extends OpenMCUnivariateBase {
    type: 'maxwell';
    /** Effective temperature theta [eV] */
    temperature: number;
}

/** Watt fission spectrum (`openmc.stats.Watt`, XML type `watt`) */
export interface OpenMCWattUnivariate extends OpenMCUnivariateBase {
    type: 'watt';
    /** First Watt parameter [eV] */
    a: number;
    /** Second Watt parameter [1/eV] */
    b: number;
}

/** Normal (Gaussian) distribution (`openmc.stats.Normal`, XML type `normal`) */
export interface OpenMCNormalUnivariate extends OpenMCUnivariateBase {
    type: 'normal';
    /** Mean [eV for energy] */
    mean: number;
    /** Standard deviation [eV for energy] */
    stdDev: number;
}

/**
 * Muir energy distribution (D-T fusion; a Normal parameterized by e0/m_rat/kt).
 * OpenMC XML has no `muir` type — it serializes as `normal`, and the Python
 * exporter uses `openmc.stats.muir(e0, m_rat, kt)`.
 */
export interface OpenMCMuirUnivariate extends OpenMCUnivariateBase {
    type: 'muir';
    /** Mean energy [eV] */
    e0: number;
    /** Ratio of reactant masses to 1 amu */
    m_rat: number;
    /** Ion temperature [eV] */
    kt: number;
}

/** Power-law distribution (`openmc.stats.PowerLaw`, XML type `powerlaw`) */
export interface OpenMCPowerLawUnivariate extends OpenMCUnivariateBase {
    type: 'powerlaw';
    /** Lower bound a */
    a: number;
    /** Upper bound b (must be greater than a) */
    b: number;
    /** Exponent n; p(x) ∝ x^n on [a, b] */
    n: number;
}

/** Tabular distribution (`openmc.stats.Tabular`, XML type `tabular`) */
export interface OpenMCTabularUnivariate extends OpenMCUnivariateBase {
    type: 'tabular';
    /** Strictly increasing abscissae (x values) */
    energies: number[];
    /** Probability densities, one per abscissa */
    probabilities: number[];
    /** Interpolation scheme between points (default: linear-linear) */
    interpolation?: 'histogram' | 'linear-linear' | 'linear-log' | 'log-linear' | 'log-log';
}

/**
 * Mixture distribution (`openmc.stats.Mixture`, XML type `mixture`).
 * Each `<pair probability="..."><dist .../></pair>` child is represented by a
 * probability and one distribution in the same array position.
 */
export interface OpenMCMixtureUnivariate extends OpenMCUnivariateBase {
    type: 'mixture';
    /** Component selection probabilities (must sum to 1) */
    probability: number[];
    /** Component distributions */
    distributions: OpenMCSourceEnergy[];
}

/**
 * Decay photon spectrum (`openmc.stats.DecaySpectrum`, XML type
 * `decay_spectrum`, OpenMC 0.16+).
 */
export interface OpenMCDecaySpectrumUnivariate extends OpenMCUnivariateBase {
    type: 'decay-spectrum';
    /** Nuclide names and atom densities [atom/b-cm] */
    nuclides: { name: string; density: number }[];
    /** Source-region volume [cm^3] */
    volume: number;
}

/** Shared univariate distribution union */
export type OpenMCUnivariate =
    | OpenMCDiscreteUnivariate
    | OpenMCUniformUnivariate
    | OpenMCMaxwellUnivariate
    | OpenMCWattUnivariate
    | OpenMCNormalUnivariate
    | OpenMCMuirUnivariate
    | OpenMCPowerLawUnivariate
    | OpenMCTabularUnivariate
    | OpenMCMixtureUnivariate
    | OpenMCDecaySpectrumUnivariate;

// ----------------------------------------------------------------------------
// Spatial distributions
// ----------------------------------------------------------------------------

/** Source spatial distribution types */
export type OpenMCSourceSpatialType =
    'point' | 'box' | 'sphere' | 'cylinder' | 'cartesian' | 'cylindrical' | 'spherical' | 'pointcloud' | 'mesh';

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

/** Sphere source spatial (uniform in a sphere; serializes as spherical) */
export interface OpenMCSphereSourceSpatial extends OpenMCSourceSpatialBase {
    type: 'sphere';
    center: [number, number, number];
    radius: number;
}

/** Cylinder source spatial (uniform in a cylinder; serializes as cylindrical) */
export interface OpenMCCylinderSourceSpatial extends OpenMCSourceSpatialBase {
    type: 'cylinder';
    center: [number, number, number];
    radius: number;
    height: number;
    axis: 'x' | 'y' | 'z';
}

/** Independent Cartesian spatial distribution (`<space type="cartesian">`) */
export interface OpenMCCartesianSpatial extends OpenMCSourceSpatialBase {
    type: 'cartesian';
    x: OpenMCUnivariate;
    y: OpenMCUnivariate;
    z: OpenMCUnivariate;
}

/** Independent cylindrical spatial distribution (`<space type="cylindrical">`) */
export interface OpenMCCylindricalSpatial extends OpenMCSourceSpatialBase {
    type: 'cylindrical';
    r: OpenMCUnivariate;
    phi: OpenMCUnivariate;
    z: OpenMCUnivariate;
    /** Reference-frame origin (default: [0, 0, 0]) */
    origin?: [number, number, number];
    /** Cylinder r axis at phi=0 (default: [1, 0, 0]) */
    rDir?: [number, number, number];
    /** Cylinder z axis direction (default: [0, 0, 1]) */
    zDir?: [number, number, number];
}

/** Independent spherical spatial distribution (`<space type="spherical">`) */
export interface OpenMCSphericalSpatial extends OpenMCSourceSpatialBase {
    type: 'spherical';
    r: OpenMCUnivariate;
    cosTheta: OpenMCUnivariate;
    phi: OpenMCUnivariate;
    /** Sphere center (default: [0, 0, 0]) */
    origin?: [number, number, number];
}

/** Point-cloud spatial distribution (`<space type="cloud">`) */
export interface OpenMCPointCloudSpatial extends OpenMCSourceSpatialBase {
    type: 'pointcloud';
    /** Source points (each a 3-vector) */
    positions: [number, number, number][];
    /** Optional relative probability per point; length must match positions */
    strengths?: number[];
    /**
     * Optional biased sampling probabilities per point (OpenMC
     * `PointCloud(..., bias=...)`). Requires a matching strengths array.
     */
    bias?: OpenMCArrayBias;
}

/** Mesh spatial distribution (`<space type="mesh">`) */
export interface OpenMCMeshSpatial extends OpenMCSourceSpatialBase {
    type: 'mesh';
    /** Reference to a mesh in state.meshes */
    meshId?: number;
    /** Optional relative source strength per mesh element */
    strengths?: number[];
    /**
     * Optional biased sampling probabilities per mesh element (OpenMC
     * `MeshSpatial(..., bias=...)`). Requires a matching strengths array.
     */
    bias?: OpenMCArrayBias;
    /**
     * Multiply strengths by element volume. The editor/Python default is true;
     * C++ treats an omitted XML attribute as false, and import follows C++.
     */
    volumeNormalized?: boolean;
}

/** Source spatial definition (union of all types) */
export type OpenMCSourceSpatial =
    | OpenMCPointSourceSpatial
    | OpenMCBoxSourceSpatial
    | OpenMCSphereSourceSpatial
    | OpenMCCylinderSourceSpatial
    | OpenMCCartesianSpatial
    | OpenMCCylindricalSpatial
    | OpenMCSphericalSpatial
    | OpenMCPointCloudSpatial
    | OpenMCMeshSpatial;

// ----------------------------------------------------------------------------
// Energy distributions
// ----------------------------------------------------------------------------

/** Source energy distribution types */
export type OpenMCSourceEnergyType = OpenMCUnivariateType;

/** Base source energy definition */
export interface OpenMCSourceEnergyBase {
    type: OpenMCSourceEnergyType;
}

/** Discrete energy distribution */
export type OpenMCDiscreteEnergy = OpenMCDiscreteUnivariate;

/** Uniform energy distribution */
export type OpenMCUniformEnergy = OpenMCUniformUnivariate;

/** Maxwell energy distribution */
export type OpenMCMaxwellEnergy = OpenMCMaxwellUnivariate;

/** Watt energy distribution */
export type OpenMCWattEnergy = OpenMCWattUnivariate;

/** Muir energy distribution */
export type OpenMCMuirEnergy = OpenMCMuirUnivariate;

/** Normal (Gaussian) energy distribution */
export type OpenMCNormalEnergy = OpenMCNormalUnivariate;

/** Tabular energy distribution */
export type OpenMCTabularEnergy = OpenMCTabularUnivariate;

/** Power-law energy distribution */
export type OpenMCPowerLawEnergy = OpenMCPowerLawUnivariate;

/** Mixture energy distribution */
export type OpenMCMixtureEnergy = OpenMCMixtureUnivariate;

/** Decay-spectrum energy distribution */
export type OpenMCDecaySpectrumEnergy = OpenMCDecaySpectrumUnivariate;

/** Source energy distribution (shared univariate model) */
export type OpenMCSourceEnergy = OpenMCUnivariate;

// ----------------------------------------------------------------------------
// Angular and time distributions
// ----------------------------------------------------------------------------

/**
 * Angle bias for an isotropic distribution. OpenMC only accepts a
 * PolarAzimuthal (`mu-phi`) bias for `Isotropic`, supported on mu = [-1, 1]
 * and phi = [0, 2π], and the bias distributions may not carry their own bias.
 */
export interface OpenMCAngleBias {
    /** Polar-azimuthal distribution sampled instead of the isotropic one. */
    distribution: OpenMCMuPhiAngle;
}

/** Isotropic angular distribution */
export interface OpenMCIsotropicAngle {
    type: 'isotropic';
    /** Optional biased angular sampling (PolarAzimuthal). */
    bias?: OpenMCAngleBias;
}

/** Monodirectional angular distribution (all particles follow one direction) */
export interface OpenMCMonodirectionalAngle {
    type: 'monodirectional';
    /** Direction vector (default: [0, 0, 1], the C++ XML default); OpenMC normalizes it */
    referenceUvW?: [number, number, number];
}

/**
 * Polar-azimuthal angular distribution (`openmc.stats.PolarAzimuthal`, XML
 * type `mu-phi`). `mu` is the cosine of the polar angle and `phi` is the
 * azimuthal angle in radians.
 */
export interface OpenMCMuPhiAngle {
    type: 'mu-phi';
    /** Cosine of the polar angle distribution */
    mu: OpenMCUnivariate;
    /** Azimuthal angle distribution [rad] */
    phi: OpenMCUnivariate;
    /** Polar-angle reference direction (default: [0, 0, 1]) */
    referenceUvW?: [number, number, number];
    /** Azimuthal-angle reference direction (default: [1, 0, 0]) */
    referenceVwu?: [number, number, number];
}

/** Source angular distribution */
export type OpenMCSourceAngle = OpenMCIsotropicAngle | OpenMCMonodirectionalAngle | OpenMCMuPhiAngle;

/** Delta (single-time) distribution. Stored as a one-point discrete in XML. */
export interface OpenMCDeltaTime {
    type: 'delta';
    /** Particle birth time [s] */
    time: number;
}

/** Source time distribution types (all values are seconds) */
export type OpenMCSourceTimeType = 'delta' | 'uniform' | 'discrete' | 'tabular' | 'mixture';

/**
 * Source time distribution. OpenMC tracks particle time in seconds, so every
 * value in this union is seconds. Delta is a single-point Discrete in XML.
 */
export type OpenMCSourceTime =
    OpenMCDeltaTime | OpenMCUniformUnivariate | OpenMCDiscreteUnivariate | OpenMCTabularUnivariate | OpenMCMixtureUnivariate;

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
    /** Time distribution in seconds (for time-dependent problems) */
    time?: OpenMCSourceTime;
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
 * 0.16.0). Samples positions from a Miller-style flux-surface parameterization
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
     * @deprecated Legacy pre-1.1.0 field — the canonical MGXS library path is
     * `OpenMCSettings.mgxsLibrary`. Read by `resolveMgxsLibrary` as a
     * fallback (a directory value resolves to `<dir>/mgxs.h5`); the random
     * ray tab migrates it to the canonical field on first edit.
     */
    mgxsLibraryPath?: string;
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
    /** Number of OpenMP threads passed to the runner (`-s N`; per MPI rank) */
    threads?: number;
    /**
     * MPI launch controls. Runtime-only: MPI is applied to the `openmc`
     * invocation, never written to settings.xml. Threads are per rank, so
     * `threads * processes` is the total CPU demand.
     */
    mpi?: {
        /** Launch through `mpirun` (requires an MPI-enabled OpenMC build) */
        enabled?: boolean;
        /** Number of MPI ranks (`mpirun -np N`) */
        processes?: number;
        /** Optional host list for `mpirun --host host1,host2` */
        hosts?: string[];
    };
    /** Verbosity level (1-10) */
    verbosity?: number;
    /** Cutoff energies and weights */
    cutoff?: {
        energyNeutron?: number;
        energyPhoton?: number;
        /** Neutron time cutoff in seconds (`<time_neutron>`) */
        time?: number;
        /** Photon time cutoff in seconds (`<time_photon>`) */
        timePhoton?: number;
        weight?: number;
        weightAvg?: number;
    };
    /** Energy mode: 'continuous-energy' or 'multigroup' */
    energyMode?: 'continuous-energy' | 'multigroup';
    /** Random ray solver settings (requires multigroup energy mode) */
    randomRay?: OpenMCRandomRaySettings;
    /** Path to the MGXS library file (mgxs.h5) for multi-group runs */
    mgxsLibrary?: string;
    /**
     * Nuclide-wise multi-group mode: the MGXS library holds one micro XSdata
     * set per nuclide and materials stay nuclide-decomposed (no `macroscopic`).
     * Required for random ray on DAGMC geometries, which reject macroscopic
     * multi-group materials. Undefined/false = material-wise macroscopic mode.
     */
    nuclideWiseMgxs?: boolean;
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
    /** Debug trace of one particle: [batch, generation, particle] (`<trace>`) */
    trace?: [number, number, number];
    /**
     * Combined k-eff precision trigger (`<keff_trigger>`). Ignored outside
     * eigenvalue mode. OpenMC requires both the metric and a positive
     * threshold; there is no per-batch restriction on this trigger.
     */
    keffTrigger?: {
        type: 'variance' | 'std_dev' | 'rel_err';
        threshold: number;
    };
    /**
     * Report tally uncertainties as 95% confidence-interval half-widths
     * (`<confidence_intervals>true</confidence_intervals>`).
     */
    confidenceIntervals?: boolean;
    /** Free-gas scattering threshold in units of kT (`<free_gas_threshold>`) */
    freeGasThreshold?: number;
    /** Shared secondary particle bank (`<shared_secondary_bank>`, 0.16.0+) */
    sharedSecondaryBank?: boolean;
    /** Surface-flux grazing cosine cutoff (`<surface_grazing_cutoff>`, 0.16.0+) */
    surfaceGrazingCutoff?: number;
    /** Surface-flux grazing cosine substitution ratio (`<surface_grazing_ratio>`, 0.16.0+) */
    surfaceGrazingRatio?: number;
    /** Maximum events per particle (`<max_particle_events>`) */
    maxParticleEvents?: number;
    /** Event-based parallelism in-flight particle limit (`<max_particles_in_flight>`) */
    maxParticlesInFlight?: number;
    /** Maximum secondary bank size (`<max_secondaries>`) */
    maxSecondaries?: number;
    /** Maximum splits per history (`<max_history_splits>`) */
    maxHistorySplits?: number;
    /** Maximum lost-particle restart files written per rank (`<max_write_lost_particles>`) */
    maxWriteLostParticles?: number;
    /** Skip tally reduction across MPI ranks (`<no_reduce>`) */
    noReduce?: boolean;
    /** Random-number stride per source history (`<stride>`) */
    stride?: number;
    /** Seed for plot color generation (`<plot_seed>`) */
    plotSeed?: number;
    /** Properties HDF5 file for cell temperatures/densities (`<properties_file>`) */
    propertiesFile?: string;
    /** Material/cell offset optimization (`<material_cell_offsets>`) */
    materialCellOffsets?: boolean;
    /** DAGMC geometry file path (for direct CAD geometry) */
    dagmcFile?: string;
    /** DAGMC model information (populated when importing DAGMC file) */
    dagmcInfo?: DAGMCInfo;
    /**
     * Copy DAGMC .h5m into each run directory as geometry.h5m; when false,
     * geometry.xml references the original file with a relative path.
     */
    copyDagmcToRunDirectory?: boolean;
    /** Resonance scattering settings */
    resonanceScattering?: {
        enable?: boolean;
        method?: 'rvs' | 'dbrc';
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
    /**
     * MeshFilter translation in cm (OpenMC 0.15.3+). Serializes as the
     * `translation` attribute of `<filter type="mesh">` and maps to
     * `openmc.MeshFilter.translation`.
     */
    meshTranslation?: [number, number, number];
    /**
     * MeshFilter rotation in degrees (OpenMC 0.16.0+). Intrinsic Tait-Bryan
     * angles (phi, theta, psi) applied as Rz(psi) Ry(theta) Rx(phi). Serializes
     * as the `rotation` attribute of `<filter type="mesh">`; omitted with a
     * warning on environments that lack MeshFilter.rotation.
     */
    meshRotation?: [number, number, number];
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
 * Supports regular (Cartesian), rectilinear, cylindrical, spherical, and
 * unstructured meshes (openmc.mesh).
 * @see {@link OpenMCMesh}
 */

/** Mesh types */
export type OpenMCMeshType = 'regular' | 'rectilinear' | 'cylindrical' | 'spherical' | 'unstructured';

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

/**
 * Rectilinear mesh: explicit boundaries on each Cartesian axis
 * (openmc.RectilinearMesh). Grid arrays include both endpoints and must
 * strictly increase; each axis needs at least two points.
 */
export interface OpenMCRectilinearMesh {
    type: 'rectilinear';
    /** Unique mesh ID */
    id: number;
    /** Mesh name */
    name?: string;
    /** X-axis boundaries in cm */
    xGrid: number[];
    /** Y-axis boundaries in cm */
    yGrid: number[];
    /** Z-axis boundaries in cm */
    zGrid: number[];
}

/** Unstructured mesh library (openmc.UnstructuredMesh) */
export type OpenMCUnstructuredMeshLibrary = 'moab' | 'libmesh';

/**
 * Unstructured mesh: an external MOAB/Exodus mesh file read at run time
 * (openmc.UnstructuredMesh). The filename may be absolute or relative to the
 * project/run directory.
 */
export interface OpenMCUnstructuredMesh {
    type: 'unstructured';
    /** Unique mesh ID */
    id: number;
    /** Mesh name */
    name?: string;
    /** Path to the mesh file (.h5m/.h5/.vtk for MOAB; .e/.exo/.ex2 for libMesh) */
    filename: string;
    /** Mesh library used to read the file */
    library: OpenMCUnstructuredMeshLibrary;
    /** Constant multiplier applied to mesh coordinates */
    lengthMultiplier?: number;
    /** MOAB AdaptiveKDTree search options (e.g. 'MAX_DEPTH=20;PLANE_SET=2;') */
    options?: string;
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
export type OpenMCMesh = OpenMCRegularMesh | OpenMCRectilinearMesh | OpenMCCylindricalMesh | OpenMCSphericalMesh | OpenMCUnstructuredMesh;

// ============================================================================
// Variance Reduction
// ============================================================================

/**
 * Variance reduction settings for improving simulation efficiency.
 * Includes weight windows, source biasing, and uniform fission site methods.
 * @see {@link OpenMCVarianceReduction}
 */

/** Weight window settings (one `<weight_windows>` set) */
export interface OpenMCWeightWindows {
    /**
     * Unique set identifier emitted as `<weight_windows id="...">`. Assigned
     * deterministically (1, 2, ...) when absent so older single-set projects
     * load unchanged.
     */
    id?: number;
    /** Mesh ID for weight windows */
    meshId: number;
    /** Lower weight bounds (scalar broadcasts to every cell/group) */
    lowerBound: number | number[];
    /** Upper weight bounds (defaults to 2× the lower bound) */
    upperBound?: number | number[];
    /**
     * Survival ratio emitted as `<survival_ratio>` (ratio of survival weight
     * to the lower weight window bound). Retained field name for compatibility
     * with older project files.
     */
    survivalWeight?: number;
    /** Particle type */
    particleType?: 'neutron' | 'photon' | string;
    /** Energy bounds for energy-dependent weight windows */
    energyBounds?: number[];
    /** Maximum number of splits per history (default 10) */
    maxSplit?: number;
    /** Weight cutoff below which particles are terminated (default 1e-38) */
    weightCutoff?: number;
}

/**
 * Source biasing settings from older project files.
 * @deprecated Source bias is configured on each source distribution
 * (`energy.bias`, `angle.bias`, spatial `bias`); this object is migrated on
 * load and never emitted.
 */
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
    /** Regular mesh ID for UFS; required when enabled */
    meshId?: number;
}

/** Variance reduction settings */
export interface OpenMCVarianceReduction {
    /** Weight window sets (one or more `<weight_windows>` blocks) */
    weightWindows?: OpenMCWeightWindows[];
    /** HDF5 weight window file loaded at simulation start */
    weightWindowsFile?: string;
    /**
     * Whether weight windows are applied (`<weight_windows_on>`). Defaults to
     * true when sets or a file exist; explicit false disables transport checks.
     */
    weightWindowsOn?: boolean;
    /** Weight-window split/roulette checkpoints (collision default true) */
    weightWindowCheckpoints?: {
        collision?: boolean;
        surface?: boolean;
    };
    /** Weight window generator settings */
    weightWindowGenerator?: {
        /** Mesh ID for the generated weight windows */
        meshId?: number;
        /** Energy group boundaries in eV */
        energyBounds?: number[];
        /** Generation method: 'magic' (default) or 'fw_cadis' (requires random ray mode) */
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
        particleType?: 'neutron' | 'photon' | string;
    };
    /**
     * @deprecated Migrated to the first independent source on load; never
     * emitted or shown as a control.
     */
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
    /**
     * Solver (integrator) id — canonical OpenMC short names
     * (`integrator_by_name`, see `src/common/depletion-solvers.ts`). Legacy
     * stored values are mapped via `resolveDepletionSolver` on read.
     */
    solver?: 'cecm' | 'predictor' | 'cf4' | 'celi' | 'epc_rk4' | 'leqi' | 'si_celi' | 'si_leqi';
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
    /**
     * Optional reactivity search that adjusts a model parameter during each
     * depletion step to hold a target k-effective (OpenMC 0.16+).
     */
    reactivityControl?: OpenMCReactivityControl;
    /** External feed/removal rates for depletable materials (g/s … g/a) */
    externalSourceRates?: OpenMCExternalSourceRate[];
    /**
     * Previous `depletion_results.h5` used as the operator's restart point.
     * Combined with {@link continueTimesteps} this continues an existing
     * schedule; on its own it appends new steps to the previous results.
     */
    continueFromResults?: string;
    /**
     * Treat this run as a continuation of {@link continueFromResults}: the
     * configured timesteps must begin with the previous schedule and must use
     * the same power/source-rate specification. Requires OpenMC 0.15.1+.
     */
    continueTimesteps?: boolean;
}

/**
 * Curated reactivity-control parameter for the OpenMC keff search. The driver
 * modifies the model through `openmc.lib` while a keff search runs at each
 * depletion step.
 */
export interface OpenMCReactivityControl {
    /** Whether the search runs. Absent means enabled when configured. */
    enabled?: boolean;
    /** Curated parameter type */
    parameter: 'cell-translation' | 'nuclide-density';
    /** Cell whose translation is adjusted (cell-translation) */
    cellId?: number;
    /** Translation axis adjusted by the search (cell-translation) */
    axis?: 'x' | 'y' | 'z';
    /** Material whose nuclide density is adjusted (nuclide-density) */
    materialId?: number;
    /** Nuclide name (e.g. 'U235') adjusted by the search (nuclide-density) */
    nuclide?: string;
    /** First search guess (lower value) */
    x0: number;
    /** Second search guess (upper value) */
    x1: number;
    /** Absolute search bounds [min, max] */
    bracket: [number, number];
    /** Target k-effective (default 1.0) */
    targetKeff?: number;
    /** Absolute k-effective tolerance (default 1e-4) */
    kTol?: number;
    /** Maximum accepted k-effective uncertainty (default 3e-4) */
    sigmaFinal?: number;
    /** Maximum search iterations (default 50) */
    maxIterations?: number;
    /** Non-convergence behavior: stop the run or log a warning and continue */
    onFailure?: 'fail' | 'warn';
}

/** External feed/removal rate for a depletable material. */
export interface OpenMCExternalSourceRate {
    /** Depletable material ID */
    material: number;
    /** Composition vector; weight percent per element/nuclide */
    composition: OpenMCExternalSourceComposition[];
    /** Mass rate; positive feeds, negative removes */
    rate: number;
    /** Mass-per-time units (default 'g/s') */
    units?: 'g/s' | 'g/min' | 'g/h' | 'g/d' | 'g/a';
    /** Timestep indices the rate applies to; absent means every step */
    timesteps?: number[];
}

/** One element or nuclide in an external source rate composition. */
export interface OpenMCExternalSourceComposition {
    /** Element or nuclide name (e.g. 'U', 'U235') */
    name: string;
    /** Weight percent (OpenMC normalizes the vector) */
    weightPercent: number;
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
    /** Background color for regions outside every cell, as [r, g, b] */
    background?: [number, number, number];
    /** Show only the listed cell/material domains (per {@link colorBy}) */
    mask?: {
        /** Cell or material IDs to keep visible */
        components: number[];
        /** Color applied to every masked-out domain, as [r, g, b] */
        background?: [number, number, number];
    };
    /** Highlight overlapping regions (slice plots only) */
    showOverlaps?: boolean;
    /** Color applied to overlapping regions, as [r, g, b] (slice plots only) */
    overlapColor?: [number, number, number];
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
export const OPENMC_STATE_SCHEMA_VERSION = '1.2.0';
