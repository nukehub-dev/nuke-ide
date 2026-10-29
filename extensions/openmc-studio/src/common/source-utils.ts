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
 * Source distribution helpers shared by the state model, XML generation/import,
 * Python export, and the source editor.
 *
 * The single {@link OpenMCUnivariate} model covers energy, time, spatial
 * coordinates, mu/phi, and nested mixture children. XML element names,
 * attributes, and parameter ordering mirror `openmc/stats/univariate.py`,
 * `openmc/stats/multivariate.py`, and `src/distribution*.cpp` exactly.
 *
 * Boundaries deliberately not modeled:
 * - `openmc.stats.Legendre` (`to_xml_element` raises NotImplementedError).
 * - `ignore_negative` for tabular densities: OpenMC XML has no attribute for
 *   it, so the editor rejects negative densities instead of letting XML and
 *   Python diverge.
 *
 * @module openmc-studio/common
 */

import {
    OpenMCBoxSourceSpatial,
    OpenMCCylinderSourceSpatial,
    OpenMCDecaySpectrumUnivariate,
    OpenMCDeltaTime,
    OpenMCDiscreteUnivariate,
    OpenMCIndependentSource,
    OpenMCMeshSpatial,
    OpenMCMonodirectionalAngle,
    OpenMCMuPhiAngle,
    OpenMCPointCloudSpatial,
    OpenMCPointSourceSpatial,
    OpenMCSource,
    OpenMCSourceAngle,
    OpenMCSourceEnergy,
    OpenMCSourceSpatial,
    OpenMCSourceTime,
    OpenMCSphereSourceSpatial,
    OpenMCTabularUnivariate,
    OpenMCUniformUnivariate,
    OpenMCMesh
} from './openmc-state-schema';
import { getMeshElementCount } from './mesh-utils';

/** Interpolation schemes accepted by `openmc.stats.Tabular` (univariate.py). */
export const TABULAR_INTERPOLATION_SCHEMES = ['histogram', 'linear-linear', 'linear-log', 'log-linear', 'log-log'] as const;

/** Two pi, matching OpenMC's azimuthal default range. */
const TWO_PI = 2 * Math.PI;

/** Tolerance for probability sums and vector comparisons. */
const EPSILON = 1e-9;

/** A validation message scoped to one source-editor section. */
export type SourceDistributionScope = 'spatial' | 'energy' | 'angle' | 'time';

/** One source-distribution validation finding (cause + fix). */
export interface SourceDistributionIssue {
    /** Editor section that owns the field. */
    scope: SourceDistributionScope;
    /** What is wrong. */
    message: string;
    /** How to fix it. */
    suggestion: string;
}

// ============================================================================
// Defaults
// ============================================================================

/**
 * Build a fresh distribution of the requested type with safe defaults.
 * @param type - Distribution type.
 * @param domain - Human/domain context used to choose sane bounds.
 * @returns A new distribution.
 */
export function defaultUnivariateOfType(
    type: OpenMCSourceEnergy['type'],
    domain: 'energy' | 'time' | 'coordinate' | 'angle-mu' | 'angle-phi' = 'energy'
): OpenMCSourceEnergy {
    switch (type) {
        case 'uniform':
            if (domain === 'time') return { type: 'uniform', min: 0, max: 1e-3 };
            if (domain === 'angle-mu') return { type: 'uniform', min: -1, max: 1 };
            if (domain === 'angle-phi') return { type: 'uniform', min: 0, max: TWO_PI };
            if (domain === 'coordinate') return { type: 'uniform', min: -1, max: 1 };
            return { type: 'uniform', min: 0, max: 20e6 };
        case 'maxwell':
            return { type: 'maxwell', temperature: 1.0 };
        case 'watt':
            return { type: 'watt', a: 0.988e6, b: 2.249e-6 };
        case 'normal':
            return { type: 'normal', mean: 14.1e6, stdDev: 0.3e6 };
        case 'powerlaw':
            return { type: 'powerlaw', a: 0.1e6, b: 20e6, n: 0 };
        case 'tabular': {
            const bounds =
                domain === 'time'
                    ? [0, 1e-3]
                    : domain === 'angle-mu' || domain === 'coordinate'
                      ? [-1, 1]
                      : domain === 'angle-phi'
                        ? [0, TWO_PI]
                        : [1e-5, 2e7];
            return { type: 'tabular', energies: bounds, probabilities: [1, 1], interpolation: 'linear-linear' };
        }
        case 'mixture': {
            const low = domain === 'time' ? 0 : domain === 'angle-mu' || domain === 'coordinate' ? -1 : 0;
            const high =
                domain === 'time' ? 1e-3 : domain === 'angle-mu' || domain === 'coordinate' ? 1 : domain === 'angle-phi' ? TWO_PI : 20e6;
            return {
                type: 'mixture',
                probability: [0.5, 0.5],
                distributions: [
                    { type: 'discrete', energies: [domain === 'time' ? 0 : domain === 'angle-mu' ? 1 : low] },
                    { type: 'uniform', min: low, max: high }
                ]
            };
        }
        case 'decay-spectrum':
            return { type: 'decay-spectrum', nuclides: [{ name: 'Cs137', density: 1e-8 }], volume: 1 };
        case 'muir':
            return { type: 'muir', e0: 14.08e6, m_rat: 5.0, kt: 20000 };
        default:
            return {
                type: 'discrete',
                energies: [domain === 'time' ? 0 : domain === 'angle-phi' ? 0 : domain === 'angle-mu' ? 1 : 1e6]
            };
    }
}

/** Build a fresh spatial distribution of the requested type with defaults. */
export function defaultSpatialOfType(type: OpenMCSourceSpatial['type']): OpenMCSourceSpatial {
    switch (type) {
        case 'box':
            return { type: 'box', lowerLeft: [-10, -10, -10], upperRight: [10, 10, 10] };
        case 'sphere':
            return { type: 'sphere', center: [0, 0, 0], radius: 5 };
        case 'cylinder':
            return { type: 'cylinder', center: [0, 0, 0], radius: 2, height: 10, axis: 'z' };
        case 'cartesian':
            return {
                type: 'cartesian',
                x: { type: 'uniform', min: -1, max: 1 },
                y: { type: 'uniform', min: -1, max: 1 },
                z: { type: 'uniform', min: -1, max: 1 }
            };
        case 'cylindrical':
            return {
                type: 'cylindrical',
                r: { type: 'uniform', min: 0, max: 1 },
                phi: { type: 'uniform', min: 0, max: TWO_PI },
                z: { type: 'uniform', min: -1, max: 1 },
                origin: [0, 0, 0],
                rDir: [1, 0, 0],
                zDir: [0, 0, 1]
            };
        case 'spherical':
            return {
                type: 'spherical',
                r: { type: 'uniform', min: 0, max: 1 },
                cosTheta: { type: 'uniform', min: -1, max: 1 },
                phi: { type: 'uniform', min: 0, max: TWO_PI },
                origin: [0, 0, 0]
            };
        case 'pointcloud':
            return { type: 'pointcloud', positions: [[0, 0, 0]] };
        case 'mesh':
            return { type: 'mesh', volumeNormalized: true };
        default:
            return { type: 'point', origin: [0, 0, 0] };
    }
}

/** Build a fresh angular distribution of the requested type with defaults. */
export function defaultAngleOfType(type: OpenMCSourceAngle['type']): OpenMCSourceAngle {
    switch (type) {
        case 'monodirectional':
            // C++ Monodirectional defaults to the positive z direction; use an
            // explicit vector so XML and Python export agree.
            return { type: 'monodirectional', referenceUvW: [0, 0, 1] };
        case 'mu-phi':
            return {
                type: 'mu-phi',
                mu: { type: 'uniform', min: -1, max: 1 },
                phi: { type: 'uniform', min: 0, max: TWO_PI },
                referenceUvW: [0, 0, 1],
                referenceVwu: [1, 0, 0]
            };
        default:
            return { type: 'isotropic' };
    }
}

/** Build a fresh time distribution of the requested type with defaults. */
export function defaultTimeOfType(type: 'delta' | OpenMCSourceTime['type']): OpenMCSourceTime {
    if (type === 'delta') {
        return { type: 'delta', time: 0 };
    }
    const distribution = defaultUnivariateOfType(type, 'time');
    return distribution as OpenMCSourceTime;
}

// ============================================================================
// Summaries (compact source card)
// ============================================================================

/** Format a number compactly without losing order of magnitude. */
function fmt(value: number): string {
    if (!Number.isFinite(value)) {
        return '—';
    }
    const abs = Math.abs(value);
    if (abs !== 0 && (abs >= 1e5 || abs < 1e-3)) {
        return value
            .toExponential(2)
            .replace(/e\+?/, 'e')
            .replace(/\.?0+e/, 'e');
    }
    return String(Number(value.toPrecision(4)));
}

/** Format a vector as `[x, y, z]`. */
function vector(v: [number, number, number] | number[] | undefined): string {
    return v && v.length >= 3 ? `[${v.slice(0, 3).map(fmt).join(', ')}]` : '[]';
}

/** Format an energy value with a unit scaled for readability. */
function energy(value: number): string {
    const abs = Math.abs(value);
    if (abs >= 1e6) return `${fmt(value / 1e6)} MeV`;
    if (abs >= 1e3) return `${fmt(value / 1e3)} keV`;
    return `${fmt(value)} eV`;
}

/** Compact time formatting (always seconds). */
function seconds(value: number): string {
    return `${fmt(value)} s`;
}

/**
 * One-line summary for a univariate distribution.
 * @param distribution - Distribution to summarize.
 * @param domain - Domain used for units.
 * @returns Compact summary text.
 */
export function summarizeUnivariate(
    distribution: OpenMCSourceEnergy,
    domain: 'energy' | 'time' | 'coordinate' | 'angle-mu' | 'angle-phi' = 'energy'
): string {
    const unit = (value: number): string => {
        if (domain === 'energy') return energy(value);
        if (domain === 'time') return seconds(value);
        if (domain === 'angle-phi') return `${fmt(value)} rad`;
        return fmt(value);
    };
    switch (distribution.type) {
        case 'discrete':
            return distribution.energies.length === 1
                ? `Discrete ${unit(distribution.energies[0])}`
                : `Discrete ${distribution.energies.length} values`;
        case 'uniform':
            return `Uniform ${unit(distribution.min)}–${unit(distribution.max)}`;
        case 'maxwell':
            return `Maxwell θ=${fmt(distribution.temperature)} eV`;
        case 'watt':
            return `Watt a=${fmt(distribution.a)} eV, b=${fmt(distribution.b)} 1/eV`;
        case 'normal':
            return `Normal ${unit(distribution.mean)} ± ${unit(distribution.stdDev)}`;
        case 'powerlaw':
            return `Power law ${unit(distribution.a)}–${unit(distribution.b)} (n=${fmt(distribution.n)})`;
        case 'tabular':
            return distribution.energies.length > 0
                ? `Tabular ${unit(distribution.energies[0])}–${unit(distribution.energies[distribution.energies.length - 1])} (${distribution.energies.length} pts)`
                : 'Tabular (empty)';
        case 'mixture':
            return `Mixture (${distribution.distributions.length} component${distribution.distributions.length === 1 ? '' : 's'})`;
        case 'decay-spectrum':
            return `Decay spectrum (${distribution.nuclides.length} nuclide${distribution.nuclides.length === 1 ? '' : 's'}, ${fmt(distribution.volume)} cm³)`;
        case 'muir':
            return `Muir ${energy(distribution.e0)}`;
        default:
            return 'Distribution';
    }
}

/**
 * One-line summary for a spatial distribution.
 * @param spatial - Spatial distribution to summarize.
 * @returns Compact summary text.
 */
export function summarizeSpatial(spatial: OpenMCSourceSpatial): string {
    switch (spatial.type) {
        case 'point':
            return `Point ${vector(spatial.origin)}`;
        case 'box': {
            const [lx, ly, lz] = spatial.lowerLeft;
            const [ux, uy, uz] = spatial.upperRight;
            return lx === ly && ly === lz && ux === uy && uy === uz
                ? `Box [${fmt(lx)}, ${fmt(ux)}]³`
                : `Box [${spatial.lowerLeft.map(fmt).join(', ')}]–[${spatial.upperRight.map(fmt).join(', ')}]`;
        }
        case 'sphere':
            return `Sphere r=${fmt(spatial.radius)} at ${vector(spatial.center)}`;
        case 'cylinder':
            return `Cylinder r=${fmt(spatial.radius)}, h=${fmt(spatial.height)}, ${spatial.axis}-axis`;
        case 'cartesian':
            return `Cartesian x: ${summarizeUnivariate(spatial.x, 'coordinate')}; y: ${summarizeUnivariate(
                spatial.y,
                'coordinate'
            )}; z: ${summarizeUnivariate(spatial.z, 'coordinate')}`;
        case 'cylindrical':
            return `Cylindrical r: ${summarizeUnivariate(spatial.r, 'coordinate')}; φ: ${summarizeUnivariate(
                spatial.phi,
                'coordinate'
            )}; z: ${summarizeUnivariate(spatial.z, 'coordinate')}`;
        case 'spherical':
            return `Spherical r: ${summarizeUnivariate(spatial.r, 'coordinate')}; cos θ: ${summarizeUnivariate(
                spatial.cosTheta,
                'coordinate'
            )}; φ: ${summarizeUnivariate(spatial.phi, 'coordinate')}`;
        case 'pointcloud':
            return `Point cloud (${spatial.positions.length} point${spatial.positions.length === 1 ? '' : 's'}${
                spatial.strengths && spatial.strengths.length > 0 ? ', weighted' : ''
            })`;
        case 'mesh':
            return `Mesh spatial${spatial.meshId !== undefined ? ` #${spatial.meshId}` : ''}`;
        default:
            return 'Spatial distribution';
    }
}

/**
 * One-line summary for an angular distribution.
 * @param angle - Angular distribution to summarize.
 * @returns Compact summary text.
 */
export function summarizeAngle(angle: OpenMCSourceAngle | undefined): string {
    if (!angle || angle.type === 'isotropic') {
        return 'Isotropic';
    }
    if (angle.type === 'monodirectional') {
        return angle.referenceUvW ? `Monodirectional ${vector(angle.referenceUvW)}` : 'Monodirectional';
    }
    return 'Mu-phi';
}

/**
 * One-line summary for a time distribution (all values in seconds).
 * @param time - Time distribution to summarize.
 * @returns Compact summary text.
 */
export function summarizeTime(time: OpenMCSourceTime | undefined): string {
    if (!time) {
        return 't = 0';
    }
    if (time.type === 'delta') {
        return `t = ${seconds(time.time)}`;
    }
    if (time.type === 'uniform') {
        return `t ${seconds(time.min)}–${seconds(time.max)}`;
    }
    if (time.type === 'discrete') {
        return time.energies.length === 1 ? `t = ${seconds(time.energies[0])}` : `t: ${time.energies.length} discrete times`;
    }
    if (time.type === 'tabular') {
        const first = time.energies[0];
        const last = time.energies[time.energies.length - 1];
        return first !== undefined && last !== undefined ? `t ${seconds(first)}–${seconds(last)}` : 'Tabular time';
    }
    return summarizeUnivariate(time, 'time');
}

/**
 * One-line summary of an independent source for the summary card.
 * @param source - Independent source.
 * @returns `spatial · energy · angle · time` summary.
 */
export function summarizeSource(source: OpenMCIndependentSource): string {
    return [
        summarizeSpatial(source.spatial),
        summarizeUnivariate(source.energy, 'energy'),
        summarizeAngle(source.angle),
        summarizeTime(source.time)
    ].join(' · ');
}

// ============================================================================
// XML generation (OpenMC settings.xml)
// ============================================================================

/** Escape text/attribute content for XML. */
function escapeXmlText(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Join numbers with spaces using OpenMC's plain string formatting. */
function joinNumbers(values: number[]): string {
    return values.map((v) => String(v)).join(' ');
}

/** Whether a number list is finite. */
function finiteList(values: number[]): boolean {
    return values.every((v) => Number.isFinite(v));
}

/** Format a vector attribute value. */
function vectorAttr(value: [number, number, number] | number[]): string {
    return value
        .slice(0, 3)
        .map((v) => String(v))
        .join(' ');
}

/** Whether a vector is finite and non-zero. */
function validNonZeroVector(value: [number, number, number] | number[] | undefined): boolean {
    return !!value && value.length === 3 && finiteList(value) && value.some((v) => Math.abs(v) > EPSILON);
}

/** Whether two vectors are perpendicular within a small tolerance. */
function perpendicular(a: [number, number, number] | number[], b: [number, number, number] | number[]): boolean {
    const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const norm = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]) * Math.sqrt(b[0] * b[0] + b[1] * b[1] + b[2] * b[2]);
    return norm > EPSILON && Math.abs(dot) <= 1e-9 * norm;
}

/** Attributes appended only when a reference vector is provided. */
function referenceAttrs(angle: OpenMCMonodirectionalAngle | OpenMCMuPhiAngle): string {
    const attrs: string[] = [];
    if (angle.referenceUvW) {
        attrs.push(`reference_uvw="${vectorAttr(angle.referenceUvW)}"`);
    }
    if (angle.type === 'mu-phi' && angle.referenceVwu) {
        attrs.push(`reference_vwu="${vectorAttr(angle.referenceVwu)}"`);
    }
    return attrs.length > 0 ? ` ${attrs.join(' ')}` : '';
}

/**
 * Generate the XML element for a univariate distribution.
 *
 * Parameter shapes match `to_xml_element` in `openmc/stats/univariate.py`:
 * discrete/tabular use `<parameters>` (values then probabilities), uniform/
 * maxwell/watt/normal/powerlaw use the `parameters` attribute, mixture uses
 * `<pair probability="..."><dist/></pair>`, and decay spectra use
 * `<nuclides>` plus `<parameters>`.
 *
 * @param distribution - Distribution to serialize.
 * @param elementName - Element name (`energy`, `time`, `x`, `mu`, ...).
 * @param indent - Leading spaces for the element.
 * @returns XML text, or an empty string when the distribution is structurally invalid.
 */
export function generateUnivariateXml(distribution: OpenMCSourceEnergy, elementName: string, indent = 0): string {
    const pad = ' '.repeat(indent);
    const childPad = ' '.repeat(indent + 2);

    if (distribution.type === 'muir') {
        const stdDev = Math.sqrt((2 * distribution.e0 * distribution.kt) / distribution.m_rat);
        if (!Number.isFinite(stdDev)) {
            return '';
        }
        return `${pad}<${elementName} type="normal" parameters="${distribution.e0} ${stdDev}"/>`;
    }

    switch (distribution.type) {
        case 'uniform':
            if (!Number.isFinite(distribution.min) || !Number.isFinite(distribution.max) || distribution.max <= distribution.min) {
                return '';
            }
            return `${pad}<${elementName} type="uniform" parameters="${distribution.min} ${distribution.max}"/>`;
        case 'maxwell':
            if (!Number.isFinite(distribution.temperature) || distribution.temperature <= 0) {
                return '';
            }
            return `${pad}<${elementName} type="maxwell" parameters="${distribution.temperature}"/>`;
        case 'watt':
            if (!Number.isFinite(distribution.a) || !Number.isFinite(distribution.b) || distribution.a <= 0 || distribution.b <= 0) {
                return '';
            }
            return `${pad}<${elementName} type="watt" parameters="${distribution.a} ${distribution.b}"/>`;
        case 'normal':
            if (!Number.isFinite(distribution.mean) || !Number.isFinite(distribution.stdDev) || distribution.stdDev <= 0) {
                return '';
            }
            return `${pad}<${elementName} type="normal" parameters="${distribution.mean} ${distribution.stdDev}"/>`;
        case 'powerlaw':
            if (
                !Number.isFinite(distribution.a) ||
                !Number.isFinite(distribution.b) ||
                !Number.isFinite(distribution.n) ||
                distribution.a < 0 ||
                distribution.b <= distribution.a
            ) {
                return '';
            }
            return `${pad}<${elementName} type="powerlaw" parameters="${distribution.a} ${distribution.b} ${distribution.n}"/>`;
        case 'discrete': {
            if (distribution.energies.length === 0 || !finiteList(distribution.energies)) {
                return '';
            }
            const probabilities =
                distribution.probabilities && distribution.probabilities.length === distribution.energies.length
                    ? distribution.probabilities
                    : distribution.energies.map(() => 1 / distribution.energies.length);
            if (!finiteList(probabilities) || probabilities.some((probability) => probability < 0)) {
                return '';
            }
            return `${pad}<${elementName} type="discrete">\n${childPad}<parameters>${joinNumbers(distribution.energies)} ${joinNumbers(
                probabilities
            )}</parameters>\n${pad}</${elementName}>`;
        }
        case 'tabular': {
            const x = distribution.energies;
            const p = distribution.probabilities;
            const interpolation = distribution.interpolation ?? 'linear-linear';
            if (
                x.length < 2 ||
                p.length !== x.length ||
                !finiteList(x) ||
                !finiteList(p) ||
                p.some((probability) => probability < 0) ||
                x.some((value, index) => index > 0 && value <= x[index - 1]) ||
                (interpolation.startsWith('log') && x.some((value) => value <= 0)) ||
                (interpolation.endsWith('log') && p.some((value) => value <= 0))
            ) {
                return '';
            }
            if (!TABULAR_INTERPOLATION_SCHEMES.includes(interpolation)) {
                return '';
            }
            return `${pad}<${elementName} type="tabular" interpolation="${interpolation}">\n${childPad}<parameters>${joinNumbers(
                x
            )} ${joinNumbers(p)}</parameters>\n${pad}</${elementName}>`;
        }
        case 'mixture': {
            if (
                distribution.probability.length === 0 ||
                distribution.probability.length !== distribution.distributions.length ||
                !finiteList(distribution.probability) ||
                distribution.probability.some((probability) => probability < 0)
            ) {
                return '';
            }
            const pairs: string[] = [];
            for (let i = 0; i < distribution.distributions.length; i++) {
                const child = generateUnivariateXml(distribution.distributions[i], 'dist', indent + 4);
                if (!child) {
                    return '';
                }
                pairs.push(`${childPad}<pair probability="${distribution.probability[i]}">\n${child}\n${childPad}</pair>`);
            }
            return `${pad}<${elementName} type="mixture">\n${pairs.join('\n')}\n${pad}</${elementName}>`;
        }
        case 'decay-spectrum': {
            if (
                distribution.nuclides.length === 0 ||
                !Number.isFinite(distribution.volume) ||
                distribution.volume <= 0 ||
                distribution.nuclides.some((n) => !n.name.trim() || !Number.isFinite(n.density) || n.density <= 0)
            ) {
                return '';
            }
            const names = distribution.nuclides.map((n) => escapeXmlText(n.name)).join(' ');
            const densities = distribution.nuclides.map((n) => String(n.density)).join(' ');
            return `${pad}<${elementName} type="decay_spectrum" volume="${distribution.volume}">\n${childPad}<nuclides>${names}</nuclides>\n${childPad}<parameters>${densities}</parameters>\n${pad}</${elementName}>`;
        }
        default:
            return '';
    }
}

/**
 * Generate a `<space>` element.
 * @param spatial - Spatial distribution.
 * @param indent - Leading spaces.
 * @returns XML text, or an empty string when the distribution is invalid.
 */
export function generateSpatialXml(spatial: OpenMCSourceSpatial, indent = 0): string {
    const pad = ' '.repeat(indent);
    const childPad = ' '.repeat(indent + 2);

    switch (spatial.type) {
        case 'point':
            if (spatial.origin.length !== 3 || !finiteList(spatial.origin)) {
                return '';
            }
            return `${pad}<space type="point">\n${childPad}<parameters>${vectorAttr(spatial.origin)}</parameters>\n${pad}</space>`;
        case 'box':
            if (
                spatial.lowerLeft.length !== 3 ||
                spatial.upperRight.length !== 3 ||
                !finiteList(spatial.lowerLeft) ||
                !finiteList(spatial.upperRight) ||
                spatial.lowerLeft.some((v, i) => v >= spatial.upperRight[i])
            ) {
                return '';
            }
            return `${pad}<space type="box">\n${childPad}<parameters>${vectorAttr(spatial.lowerLeft)} ${vectorAttr(
                spatial.upperRight
            )}</parameters>\n${pad}</space>`;
        case 'sphere':
            if (spatial.center.length !== 3 || !finiteList(spatial.center) || !Number.isFinite(spatial.radius) || spatial.radius <= 0) {
                return '';
            }
            return `${pad}<space type="spherical" origin="${vectorAttr(spatial.center)}">\n${childPad}<r type="uniform" parameters="0 ${spatial.radius}"/>\n${childPad}<cos_theta type="uniform" parameters="-1 1"/>\n${childPad}<phi type="uniform" parameters="0 ${TWO_PI}"/>\n${pad}</space>`;
        case 'cylinder':
            return generateConvenienceCylinderXml(spatial, indent);
        case 'cartesian': {
            const x = generateUnivariateXml(spatial.x, 'x', indent + 2);
            const y = generateUnivariateXml(spatial.y, 'y', indent + 2);
            const z = generateUnivariateXml(spatial.z, 'z', indent + 2);
            if (!x || !y || !z) {
                return '';
            }
            return `${pad}<space type="cartesian">\n${x}\n${y}\n${z}\n${pad}</space>`;
        }
        case 'cylindrical': {
            const r = generateUnivariateXml(spatial.r, 'r', indent + 2);
            const phi = generateUnivariateXml(spatial.phi, 'phi', indent + 2);
            const z = generateUnivariateXml(spatial.z, 'z', indent + 2);
            if (!r || !phi || !z) {
                return '';
            }
            const attrs: string[] = [];
            if (spatial.origin && (spatial.origin.length !== 3 || !finiteList(spatial.origin))) {
                return '';
            }
            if (spatial.origin && !vectorEquals(spatial.origin, [0, 0, 0])) {
                attrs.push(`origin="${vectorAttr(spatial.origin)}"`);
            }
            const rDir = spatial.rDir ?? [1, 0, 0];
            const zDir = spatial.zDir ?? [0, 0, 1];
            if (!validNonZeroVector(rDir) || !validNonZeroVector(zDir) || !perpendicular(rDir, zDir)) {
                return '';
            }
            if (!vectorEquals(rDir, [1, 0, 0])) {
                attrs.push(`r_dir="${vectorAttr(rDir)}"`);
            }
            if (!vectorEquals(zDir, [0, 0, 1])) {
                attrs.push(`z_dir="${vectorAttr(zDir)}"`);
            }
            const attrText = attrs.length > 0 ? ` ${attrs.join(' ')}` : '';
            return `${pad}<space type="cylindrical"${attrText}>\n${r}\n${phi}\n${z}\n${pad}</space>`;
        }
        case 'spherical': {
            const r = generateUnivariateXml(spatial.r, 'r', indent + 2);
            const cosTheta = generateUnivariateXml(spatial.cosTheta, 'cos_theta', indent + 2);
            const phi = generateUnivariateXml(spatial.phi, 'phi', indent + 2);
            if (!r || !cosTheta || !phi) {
                return '';
            }
            const origin = spatial.origin ?? [0, 0, 0];
            if (origin.length !== 3 || !finiteList(origin)) {
                return '';
            }
            return `${pad}<space type="spherical" origin="${vectorAttr(origin)}">\n${r}\n${cosTheta}\n${phi}\n${pad}</space>`;
        }
        case 'pointcloud': {
            if (
                spatial.positions.length === 0 ||
                spatial.positions.some((p) => p.length !== 3 || p.some((v) => !Number.isFinite(v))) ||
                (spatial.strengths !== undefined &&
                    (spatial.strengths.length !== spatial.positions.length || !finiteList(spatial.strengths)))
            ) {
                return '';
            }
            const coords = spatial.positions.flat().join(' ');
            const strengths =
                spatial.strengths !== undefined && spatial.strengths.length > 0
                    ? `\n${childPad}<strengths>${joinNumbers(spatial.strengths)}</strengths>`
                    : '';
            return `${pad}<space type="cloud">\n${childPad}<coords>${coords}</coords>${strengths}\n${pad}</space>`;
        }
        case 'mesh': {
            if (spatial.meshId === undefined || (spatial.strengths !== undefined && !finiteList(spatial.strengths))) {
                return '';
            }
            const volumeNormalized = spatial.volumeNormalized ?? true;
            const strengths =
                spatial.strengths !== undefined && spatial.strengths.length > 0
                    ? `\n${childPad}<strengths>${joinNumbers(spatial.strengths)}</strengths>`
                    : '';
            return `${pad}<space type="mesh" mesh_id="${spatial.meshId}" volume_normalized="${volumeNormalized}">${strengths}\n${pad}</space>`;
        }
        default:
            return '';
    }
}

/** Whether two vectors match within tolerance. */
function vectorEquals(a: number[], b: number[]): boolean {
    return a.length >= 3 && b.length >= 3 && [0, 1, 2].every((i) => Math.abs(a[i] - b[i]) <= 1e-12);
}

/** Direction vectors for the convenience cylinder axes. */
function cylinderDirections(axis: 'x' | 'y' | 'z'): { rDir: [number, number, number]; zDir: [number, number, number] } {
    if (axis === 'x') return { rDir: [0, 1, 0], zDir: [1, 0, 0] };
    if (axis === 'y') return { rDir: [0, 0, 1], zDir: [0, 1, 0] };
    return { rDir: [1, 0, 0], zDir: [0, 0, 1] };
}

/** Serialize the uniform-in-cylinder convenience spatial distribution. */
function generateConvenienceCylinderXml(spatial: OpenMCCylinderSourceSpatial, indent: number): string {
    if (
        spatial.center.length !== 3 ||
        !finiteList(spatial.center) ||
        !Number.isFinite(spatial.radius) ||
        spatial.radius <= 0 ||
        !Number.isFinite(spatial.height) ||
        spatial.height <= 0
    ) {
        return '';
    }
    const pad = ' '.repeat(indent);
    const childPad = ' '.repeat(indent + 2);
    const { rDir, zDir } = cylinderDirections(spatial.axis);
    const attrs = [`origin="${vectorAttr(spatial.center)}"`];
    if (spatial.axis !== 'z') {
        attrs.push(`r_dir="${vectorAttr(rDir)}"`, `z_dir="${vectorAttr(zDir)}"`);
    }
    return `${pad}<space type="cylindrical" ${attrs.join(' ')}>\n${childPad}<r type="uniform" parameters="0 ${spatial.radius}"/>\n${childPad}<phi type="uniform" parameters="0 ${TWO_PI}"/>\n${childPad}<z type="uniform" parameters="${-spatial.height / 2} ${spatial.height / 2}"/>\n${pad}</space>`;
}

/**
 * Generate an `<angle>` element.
 * @param angle - Angular distribution.
 * @param indent - Leading spaces.
 * @returns XML text, or an empty string when the distribution is invalid.
 */
export function generateAngleXml(angle: OpenMCSourceAngle, indent = 0): string {
    const pad = ' '.repeat(indent);
    if (angle.type === 'isotropic') {
        return `${pad}<angle type="isotropic"/>`;
    }
    if (angle.type === 'monodirectional') {
        const reference = angle.referenceUvW ?? [0, 0, 1];
        if (!validNonZeroVector(reference)) {
            return '';
        }
        return `${pad}<angle type="monodirectional" reference_uvw="${vectorAttr(reference)}"/>`;
    }
    if (angle.referenceUvW && !validNonZeroVector(angle.referenceUvW)) {
        return '';
    }
    if (angle.referenceVwu && !validNonZeroVector(angle.referenceVwu)) {
        return '';
    }
    const referenceU = angle.referenceUvW ?? [0, 0, 1];
    const referenceV = angle.referenceVwu ?? [1, 0, 0];
    if (!perpendicular(referenceU, referenceV)) {
        return '';
    }
    const mu = generateUnivariateXml(angle.mu, 'mu', indent + 2);
    const phi = generateUnivariateXml(angle.phi, 'phi', indent + 2);
    if (!mu || !phi) {
        return '';
    }
    return `${pad}<angle type="mu-phi"${referenceAttrs(angle)}>\n${mu}\n${phi}\n${pad}</angle>`;
}

/**
 * Generate a `<time>` element (all values seconds).
 * @param time - Time distribution.
 * @param indent - Leading spaces.
 * @returns XML text, or an empty string when invalid.
 */
export function generateTimeXml(time: OpenMCSourceTime, indent = 0): string {
    if (time.type === 'delta') {
        if (!Number.isFinite(time.time) || time.time < 0) {
            return '';
        }
        const pad = ' '.repeat(indent);
        const childPad = ' '.repeat(indent + 2);
        return `${pad}<time type="discrete">\n${childPad}<parameters>${time.time} 1</parameters>\n${pad}</time>`;
    }
    return generateUnivariateXml(time, 'time', indent);
}

/**
 * Whether a source's energy distribution contains a decay spectrum (0.16+).
 * @param source - Source to inspect.
 * @returns True when any nested distribution is a decay spectrum.
 */
export function sourceUsesDecaySpectrum(source: OpenMCSource): boolean {
    if (source.type === 'mesh') {
        return (source.sources ?? []).some((sub) => sourceUsesDecaySpectrum(sub));
    }
    if (source.type && source.type !== 'independent' && source.type !== 'tokamak') {
        return false;
    }
    return distributionUsesDecaySpectrum((source as OpenMCIndependentSource).energy);
}

/** Recursive decay-spectrum check for a univariate distribution. */
function distributionUsesDecaySpectrum(distribution: OpenMCSourceEnergy | undefined): boolean {
    if (!distribution) {
        return false;
    }
    if (distribution.type === 'decay-spectrum') {
        return true;
    }
    if (distribution.type === 'mixture') {
        return distribution.distributions.some((child) => distributionUsesDecaySpectrum(child));
    }
    return false;
}

// ============================================================================
// XML import
// ============================================================================

/** Parse a whitespace-separated number list from an XML text node/attribute. */
function parseNumberList(value: unknown): number[] {
    if (value === undefined || value === null) {
        return [];
    }
    const text = typeof value === 'string' ? value : Array.isArray(value) ? value.join(' ') : String(value);
    return text
        .trim()
        .split(/\s+/)
        .filter((part) => part.length > 0)
        .map(Number)
        .filter((part) => Number.isFinite(part));
}

/** Read an attribute or child text node by name (xml2js shape). */
function xmlValue(node: any, name: string): any {
    return node?.$?.[name] ?? node?.[name];
}

/** Parse a 3-vector attribute/child, returning undefined when malformed. */
function parseVector3(value: unknown): [number, number, number] | undefined {
    const values = parseNumberList(value);
    return values.length === 3 ? [values[0], values[1], values[2]] : undefined;
}

/**
 * Parse a univariate distribution element into the shared model.
 * @param element - xml2js element for a distribution.
 * @returns Parsed distribution, or undefined for unsupported/malformed types.
 */
export function parseUnivariateXml(element: any): OpenMCSourceEnergy | undefined {
    if (!element) {
        return undefined;
    }
    const type = xmlValue(element, 'type');
    switch (type) {
        case 'uniform': {
            const parameters = parseNumberList(xmlValue(element, 'parameters'));
            return parameters.length >= 2 ? { type: 'uniform', min: parameters[0], max: parameters[1] } : undefined;
        }
        case 'maxwell': {
            const parameters = parseNumberList(xmlValue(element, 'parameters'));
            return parameters.length >= 1 ? { type: 'maxwell', temperature: parameters[0] } : undefined;
        }
        case 'watt': {
            const parameters = parseNumberList(xmlValue(element, 'parameters'));
            return parameters.length >= 2 ? { type: 'watt', a: parameters[0], b: parameters[1] } : undefined;
        }
        case 'normal': {
            const parameters = parseNumberList(xmlValue(element, 'parameters'));
            return parameters.length >= 2 ? { type: 'normal', mean: parameters[0], stdDev: parameters[1] } : undefined;
        }
        case 'powerlaw': {
            const parameters = parseNumberList(xmlValue(element, 'parameters'));
            return parameters.length >= 3 ? { type: 'powerlaw', a: parameters[0], b: parameters[1], n: parameters[2] } : undefined;
        }
        case 'discrete': {
            const parameters = parseNumberList(xmlValue(element, 'parameters'));
            if (parameters.length < 2 || parameters.length % 2 !== 0) {
                return undefined;
            }
            const half = parameters.length / 2;
            const energies = parameters.slice(0, half);
            const probabilities = parameters.slice(half);
            return { type: 'discrete', energies, probabilities };
        }
        case 'tabular': {
            const parameters = parseNumberList(xmlValue(element, 'parameters'));
            if (parameters.length < 4) {
                return undefined;
            }
            const count = Math.ceil(parameters.length / 2);
            const energies = parameters.slice(0, count);
            let probabilities = parameters.slice(count);
            const interpolation = (xmlValue(element, 'interpolation') as OpenMCTabularUnivariate['interpolation']) ?? 'linear-linear';
            // Histogram XML may omit the last probability (OpenMC treats it as
            // ignored); pad so the editor table always has matching columns.
            if (interpolation === 'histogram' && probabilities.length === energies.length - 1) {
                probabilities = [...probabilities, probabilities[probabilities.length - 1] ?? 1];
            }
            return {
                type: 'tabular',
                energies,
                probabilities,
                interpolation: TABULAR_INTERPOLATION_SCHEMES.includes(interpolation as never) ? interpolation : 'linear-linear'
            };
        }
        case 'mixture': {
            const pairs = element.pair === undefined ? [] : Array.isArray(element.pair) ? element.pair : [element.pair];
            const probability: number[] = [];
            const distributions: OpenMCSourceEnergy[] = [];
            for (const pair of pairs) {
                const child = parseUnivariateXml(pair?.dist);
                if (!child) {
                    return undefined;
                }
                probability.push(parseFloat(xmlValue(pair, 'probability') ?? '0'));
                distributions.push(child);
            }
            return probability.length > 0 ? { type: 'mixture', probability, distributions } : undefined;
        }
        case 'decay_spectrum': {
            const volume = parseFloat(xmlValue(element, 'volume') ?? '');
            const names = String(xmlValue(element, 'nuclides') ?? '')
                .trim()
                .split(/\s+/)
                .filter((name) => name.length > 0);
            const densities = parseNumberList(xmlValue(element, 'parameters'));
            if (!Number.isFinite(volume) || names.length === 0 || names.length !== densities.length) {
                return undefined;
            }
            return {
                type: 'decay-spectrum',
                nuclides: names.map((name, index) => ({ name, density: densities[index] })),
                volume
            };
        }
        case 'muir': {
            // Legacy IDE XML from before muir() became a Normal factory.
            const parameters = parseNumberList(xmlValue(element, 'parameters'));
            if (parameters.length < 3) {
                return undefined;
            }
            return {
                type: 'normal',
                mean: parameters[0],
                stdDev: Math.sqrt((2 * parameters[0] * parameters[2]) / parameters[1])
            };
        }
        default:
            return undefined;
    }
}

/**
 * Parse a `<time>` element. A one-point discrete with probability 1 is the XML
 * representation of a delta distribution, so it imports back as `delta`.
 * @param element - xml2js time element.
 * @returns Parsed time distribution, or undefined.
 */
export function parseTimeXml(element: any): OpenMCSourceTime | undefined {
    const parsed = parseUnivariateXml(element);
    if (!parsed) {
        return undefined;
    }
    if (
        parsed.type === 'muir' ||
        parsed.type === 'normal' ||
        parsed.type === 'maxwell' ||
        parsed.type === 'watt' ||
        parsed.type === 'powerlaw' ||
        parsed.type === 'decay-spectrum'
    ) {
        return undefined;
    }
    if (parsed.type === 'discrete' && parsed.energies.length === 1 && (parsed.probabilities?.[0] ?? 1) === 1) {
        const delta: OpenMCDeltaTime = { type: 'delta', time: parsed.energies[0] };
        return delta;
    }
    return parsed;
}

/**
 * Parse an `<angle>` element.
 * @param element - xml2js angle element.
 * @param warnings - Optional warning sink for unsupported shapes.
 * @returns Parsed angular distribution, or undefined.
 */
export function parseAngleXml(element: any, warnings?: string[]): OpenMCSourceAngle | undefined {
    if (!element) {
        return undefined;
    }
    const type = xmlValue(element, 'type') ?? 'isotropic';
    if (type === 'isotropic') {
        return { type: 'isotropic' };
    }
    if (type === 'monodirectional' || type === 'reference') {
        const reference = parseVector3(xmlValue(element, 'reference_uvw')) ?? [0, 0, 1];
        if (type === 'reference') {
            warnings?.push('Legacy angle type "reference" was imported as monodirectional');
        }
        return { type: 'monodirectional', referenceUvW: reference };
    }
    if (type === 'mu-phi' || type === 'polar-azimuthal') {
        if (type === 'polar-azimuthal') {
            warnings?.push('Legacy angle type "polar-azimuthal" was imported as mu-phi');
        }
        const parsedMu = parseUnivariateXml(element.mu);
        const parsedPhi = parseUnivariateXml(element.phi);
        if (element.mu && !parsedMu) {
            warnings?.push('Unsupported mu distribution; defaulted to uniform on [-1, 1]');
        }
        if (element.phi && !parsedPhi) {
            warnings?.push('Unsupported phi distribution; defaulted to uniform on [0, 2π]');
        }
        const mu = parsedMu ?? ({ type: 'uniform', min: -1, max: 1 } as OpenMCUniformUnivariate);
        const phi = parsedPhi ?? ({ type: 'uniform', min: 0, max: TWO_PI } as OpenMCUniformUnivariate);
        return {
            type: 'mu-phi',
            mu,
            phi,
            referenceUvW: parseVector3(xmlValue(element, 'reference_uvw')),
            referenceVwu: parseVector3(xmlValue(element, 'reference_vwu'))
        } as OpenMCMuPhiAngle;
    }
    warnings?.push(`Unsupported angular distribution type "${type}"; defaulted to isotropic`);
    return { type: 'isotropic' };
}

/**
 * Parse a `<space>` element.
 * @param element - xml2js space element.
 * @param warnings - Optional warning sink for unsupported shapes.
 * @returns Parsed spatial distribution, or undefined when malformed.
 */
export function parseSpatialXml(element: any, warnings?: string[]): OpenMCSourceSpatial | undefined {
    if (!element) {
        return undefined;
    }
    const type = xmlValue(element, 'type') ?? 'point';
    if (type === 'point') {
        const parameters = parseNumberList(xmlValue(element, 'parameters'));
        return parameters.length >= 3
            ? ({ type: 'point', origin: [parameters[0], parameters[1], parameters[2]] } as OpenMCPointSourceSpatial)
            : undefined;
    }
    if (type === 'box' || type === 'fission') {
        if (type === 'fission') {
            warnings?.push('Deprecated "fission" spatial distribution imported as a box; use source constraints instead');
        }
        const parameters = parseNumberList(xmlValue(element, 'parameters'));
        if (parameters.length < 6) {
            return undefined;
        }
        return {
            type: 'box',
            lowerLeft: [parameters[0], parameters[1], parameters[2]],
            upperRight: [parameters[3], parameters[4], parameters[5]]
        } as OpenMCBoxSourceSpatial;
    }
    if (type === 'cartesian') {
        const x = parseUnivariateXml(element.x);
        const y = parseUnivariateXml(element.y);
        const z = parseUnivariateXml(element.z);
        return x && y && z ? { type: 'cartesian', x, y, z } : undefined;
    }
    if (type === 'spherical') {
        const r = parseUnivariateXml(element.r);
        const cosTheta = parseUnivariateXml(element.cos_theta ?? element.theta);
        const phi = parseUnivariateXml(element.phi);
        if (!r || !cosTheta || !phi) {
            return undefined;
        }
        const origin = parseVector3(xmlValue(element, 'origin')) ?? [0, 0, 0];
        const canonicalRadius = uniformRadius(r);
        if (canonicalRadius !== undefined && isUniformRange(cosTheta, -1, 1) && isUniformRange(phi, 0, TWO_PI)) {
            return { type: 'sphere', center: origin, radius: canonicalRadius } as OpenMCSphereSourceSpatial;
        }
        return { type: 'spherical', r, cosTheta, phi, origin };
    }
    if (type === 'cylindrical') {
        const r = parseUnivariateXml(element.r);
        const phi = parseUnivariateXml(element.phi);
        const z = parseUnivariateXml(element.z);
        if (!r || !phi || !z) {
            return undefined;
        }
        const origin = parseVector3(xmlValue(element, 'origin')) ?? [0, 0, 0];
        const rDir = parseVector3(xmlValue(element, 'r_dir')) ?? [1, 0, 0];
        const zDir = parseVector3(xmlValue(element, 'z_dir')) ?? [0, 0, 1];
        const canonical = canonicalCylinder(r, phi, z, rDir, zDir);
        if (canonical) {
            return { type: 'cylinder', center: origin, ...canonical } as OpenMCCylinderSourceSpatial;
        }
        return { type: 'cylindrical', r, phi, z, origin, rDir, zDir };
    }
    if (type === 'cloud') {
        const coords = parseNumberList(xmlValue(element, 'coords'));
        if (coords.length === 0 || coords.length % 3 !== 0) {
            return undefined;
        }
        const positions: [number, number, number][] = [];
        for (let i = 0; i < coords.length; i += 3) {
            positions.push([coords[i], coords[i + 1], coords[i + 2]]);
        }
        const strengths = parseNumberList(xmlValue(element, 'strengths'));
        const cloud: OpenMCPointCloudSpatial = { type: 'pointcloud', positions };
        if (strengths.length > 0) {
            cloud.strengths = strengths;
        }
        return cloud;
    }
    if (type === 'mesh') {
        const meshId = parseInt(xmlValue(element, 'mesh_id') ?? '');
        const strengths = parseNumberList(xmlValue(element, 'strengths'));
        const volumeNormalizedText = xmlValue(element, 'volume_normalized');
        const mesh: OpenMCMeshSpatial = {
            type: 'mesh',
            meshId: Number.isFinite(meshId) ? meshId : undefined,
            // C++ treats an omitted attribute as false; the Python
            // MeshSpatial default is true but always writes the attribute.
            volumeNormalized: volumeNormalizedText === undefined ? false : String(volumeNormalizedText).toLowerCase() === 'true'
        };
        if (strengths.length > 0) {
            mesh.strengths = strengths;
        }
        return mesh;
    }
    warnings?.push(`Unsupported spatial distribution type "${type}"`);
    return undefined;
}

/** Return the radius of a `Uniform(0, R)` distribution, or undefined. */
function uniformRadius(distribution: OpenMCSourceEnergy): number | undefined {
    return distribution.type === 'uniform' && Math.abs(distribution.min) <= EPSILON && distribution.max > 0 ? distribution.max : undefined;
}

/** Whether a distribution is a uniform on the given closed range. */
function isUniformRange(distribution: OpenMCSourceEnergy, min: number, max: number): boolean {
    return distribution.type === 'uniform' && Math.abs(distribution.min - min) <= 1e-9 && Math.abs(distribution.max - max) <= 1e-9;
}

/**
 * Detect the canonical uniform cylinder written by the convenience
 * `cylinder` spatial type, so IDE-generated XML imports back unchanged.
 * Non-canonical cylindrical distributions stay general.
 */
function canonicalCylinder(
    r: OpenMCSourceEnergy,
    phi: OpenMCSourceEnergy,
    z: OpenMCSourceEnergy,
    rDir: [number, number, number],
    zDir: [number, number, number]
): { radius: number; height: number; axis: 'x' | 'y' | 'z' } | undefined {
    const radius = uniformRadius(r);
    if (radius === undefined || !isUniformRange(phi, 0, TWO_PI) || z.type !== 'uniform') {
        return undefined;
    }
    if (z.max <= z.min || Math.abs(z.min + z.max) > 1e-9) {
        return undefined;
    }
    for (const axis of ['x', 'y', 'z'] as const) {
        const directions = cylinderDirections(axis);
        if (vectorEquals(rDir, directions.rDir) && vectorEquals(zDir, directions.zDir)) {
            return { radius, height: z.max - z.min, axis };
        }
    }
    return undefined;
}

// ============================================================================
// Legacy project normalization
// ============================================================================

/** Convert the pre-univariate time shape (`params`) to the shared model. */
function normalizeLegacyTime(time: any): OpenMCSourceTime | undefined {
    if (!time) {
        return undefined;
    }
    if (!time.params) {
        return time as OpenMCSourceTime;
    }
    const params = time.params;
    if (time.type === 'delta') {
        return { type: 'delta', time: params.time ?? 0 };
    }
    if (time.type === 'uniform') {
        return { type: 'uniform', min: params.min ?? 0, max: params.max ?? 1e-3 };
    }
    if (time.type === 'discrete') {
        return { type: 'discrete', energies: params.times ?? [], probabilities: params.probabilities };
    }
    return undefined;
}

/** Convert the pre-univariate angle shape (`params`/legacy type names) to the shared model. */
function normalizeLegacyAngle(angle: any): OpenMCSourceAngle | undefined {
    if (!angle) {
        return undefined;
    }
    const params = angle.params ?? {};
    if (angle.type === 'reference') {
        return params.referenceUvW
            ? ({ type: 'monodirectional', referenceUvW: params.referenceUvW } as OpenMCMonodirectionalAngle)
            : { type: 'monodirectional' };
    }
    if (angle.type === 'polar-azimuthal' || (angle.type === 'mu-phi' && (angle.mu === undefined || angle.phi === undefined))) {
        return {
            type: 'mu-phi',
            mu:
                typeof params.mu === 'number'
                    ? { type: 'discrete', energies: [params.mu], probabilities: [1] }
                    : { type: 'uniform', min: -1, max: 1 },
            phi:
                typeof params.phi === 'number'
                    ? { type: 'discrete', energies: [params.phi], probabilities: [1] }
                    : { type: 'uniform', min: 0, max: TWO_PI },
            referenceUvW: params.referenceUvW
        } as OpenMCMuPhiAngle;
    }
    if (angle.type === 'monodirectional' && angle.referenceUvW === undefined && params.referenceUvW) {
        return { ...angle, referenceUvW: params.referenceUvW } as OpenMCMonodirectionalAngle;
    }
    if (angle.type === 'mu-phi' && angle.referenceUvW === undefined && params.referenceUvW) {
        return { ...angle, referenceUvW: params.referenceUvW } as OpenMCMuPhiAngle;
    }
    return angle as OpenMCSourceAngle;
}

/**
 * Normalize a source loaded from an older project file to the current
 * univariate time/angle shapes. Safe to call on current files.
 * @param source - Source from a `.nuke-openmc` file.
 * @returns Source with legacy fields converted.
 */
export function normalizeLegacySource(source: OpenMCSource): OpenMCSource {
    if (!source) {
        return source;
    }
    const next: any = { ...source };
    if (next.time !== undefined) {
        next.time = normalizeLegacyTime(next.time);
    }
    if (next.angle !== undefined) {
        next.angle = normalizeLegacyAngle(next.angle);
    }
    if (next.type === 'mesh' && Array.isArray(next.sources)) {
        next.sources = next.sources.map((sub: OpenMCSource) => normalizeLegacySource(sub));
    }
    return next as OpenMCSource;
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate every distribution on an independent source.
 * Messages state the cause and the fix; the source editor scopes them by
 * section and the backend readiness check reports them as errors.
 *
 * @param source - Independent source to validate.
 * @param meshes - Known state meshes (for mesh spatial references).
 * @returns Validation findings.
 */
export function validateSourceDistributions(source: OpenMCIndependentSource, meshes: OpenMCMesh[] = []): SourceDistributionIssue[] {
    const issues: SourceDistributionIssue[] = [];
    validateSpatial(source.spatial, issues, meshes);
    validateEnergy(source.energy, issues, 'energy', 'Energy');
    if (source.angle) {
        validateAngle(source.angle, issues);
    }
    if (source.time) {
        validateTime(source.time, issues);
    }
    return issues;
}

/** Push one finding. */
function add(issues: SourceDistributionIssue[], scope: SourceDistributionScope, message: string, suggestion: string): void {
    issues.push({ scope, message, suggestion });
}

/** Validate sampled values and optional probabilities. */
function validateDiscrete(
    distribution: OpenMCDiscreteUnivariate,
    issues: SourceDistributionIssue[],
    scope: SourceDistributionScope,
    label: string,
    ordered: boolean,
    nonNegative: boolean
): void {
    if (distribution.energies.length === 0) {
        add(issues, scope, `${label} has no sampled values`, `Add at least one ${scope === 'time' ? 'time' : 'value'} row`);
        return;
    }
    if (!distribution.energies.every((v) => Number.isFinite(v))) {
        add(issues, scope, `${label} contains a non-numeric value`, 'Replace the highlighted row with a finite number');
    }
    if (nonNegative && distribution.energies.some((v) => v < 0)) {
        add(
            issues,
            scope,
            `${label} contains a negative ${scope === 'time' ? 'time' : 'value'}`,
            'Use values greater than or equal to zero'
        );
    }
    if (ordered) {
        for (let i = 1; i < distribution.energies.length; i++) {
            if (distribution.energies[i] < distribution.energies[i - 1]) {
                add(
                    issues,
                    scope,
                    `${label} values are not ordered (row ${i + 1} is smaller than row ${i})`,
                    'Sort the rows so each value is greater than or equal to the previous one'
                );
                break;
            }
        }
    }
    if (distribution.probabilities) {
        if (distribution.probabilities.length !== distribution.energies.length) {
            add(
                issues,
                scope,
                `${label} has ${distribution.energies.length} values but ${distribution.probabilities.length} probabilities`,
                'Give every row one probability, or remove the probability column to sample equally'
            );
        }
        if (!distribution.probabilities.every((p) => Number.isFinite(p) && p >= 0)) {
            add(issues, scope, `${label} has a negative or non-numeric probability`, 'Use probabilities greater than or equal to zero');
        }
    }
}

/** Validate a univariate distribution in the given context. */
function validateUnivariate(
    distribution: OpenMCSourceEnergy,
    issues: SourceDistributionIssue[],
    scope: SourceDistributionScope,
    label: string
): void {
    switch (distribution.type) {
        case 'discrete':
            validateDiscrete(distribution, issues, scope, label, scope === 'time', scope === 'time');
            return;
        case 'uniform':
            if (!Number.isFinite(distribution.min) || !Number.isFinite(distribution.max) || distribution.max <= distribution.min) {
                add(
                    issues,
                    scope,
                    `${label} range must have a finite maximum greater than its minimum`,
                    'Set a maximum larger than the minimum'
                );
            }
            if (scope === 'time' && distribution.min < 0) {
                add(issues, scope, `${label} minimum is negative`, 'Time values are seconds and must be non-negative');
            }
            return;
        case 'maxwell':
            if (!Number.isFinite(distribution.temperature) || distribution.temperature <= 0) {
                add(issues, scope, `${label} Maxwell theta must be positive`, 'Enter the effective temperature in eV (greater than zero)');
            }
            return;
        case 'watt':
            if (!Number.isFinite(distribution.a) || distribution.a <= 0 || !Number.isFinite(distribution.b) || distribution.b <= 0) {
                add(issues, scope, `${label} Watt parameters must be positive`, 'Enter a in eV and b in 1/eV, both greater than zero');
            }
            return;
        case 'normal':
            if (!Number.isFinite(distribution.mean) || !Number.isFinite(distribution.stdDev) || distribution.stdDev <= 0) {
                add(
                    issues,
                    scope,
                    `${label} normal distribution needs a finite mean and a positive standard deviation`,
                    'Set the standard deviation greater than zero'
                );
            }
            return;
        case 'powerlaw':
            if (
                !Number.isFinite(distribution.a) ||
                !Number.isFinite(distribution.b) ||
                !Number.isFinite(distribution.n) ||
                distribution.a < 0 ||
                distribution.b <= distribution.a
            ) {
                add(
                    issues,
                    scope,
                    `${label} power law needs 0 ≤ a < b and a finite exponent n`,
                    'Set the upper bound above the lower bound and enter a finite exponent'
                );
            }
            return;
        case 'tabular': {
            const x = distribution.energies;
            const p = distribution.probabilities;
            if (x.length < 2) {
                add(
                    issues,
                    scope,
                    `${label} table needs at least two rows`,
                    'Add another x/probability row so the distribution has a range'
                );
            }
            if (p.length !== x.length) {
                add(
                    issues,
                    scope,
                    `${label} table has ${x.length} x values but ${p.length} probabilities`,
                    'Give every x value one probability; use the Paste button to replace both columns together'
                );
            }
            for (let i = 1; i < x.length; i++) {
                if (!(x[i] > x[i - 1])) {
                    add(
                        issues,
                        scope,
                        `${label} x values must strictly increase (row ${i + 1}: ${fmt(x[i])} is not greater than ${fmt(x[i - 1])})`,
                        'Sort the rows by x and remove duplicate x values; a tabular distribution cannot repeat an abscissa'
                    );
                    break;
                }
            }
            if (!x.every((v) => Number.isFinite(v)) || !p.every((v) => Number.isFinite(v))) {
                add(issues, scope, `${label} table contains a non-numeric entry`, 'Replace the highlighted entry with a finite number');
            }
            if (p.some((v) => v < 0)) {
                add(
                    issues,
                    scope,
                    `${label} table contains a negative probability density`,
                    'Use non-negative densities; OpenMC XML cannot carry the Python-only ignore_negative flag'
                );
            }
            const interpolation = distribution.interpolation ?? 'linear-linear';
            if (interpolation.startsWith('log') && x.some((v) => v <= 0)) {
                add(
                    issues,
                    scope,
                    `${label} log interpolation needs strictly positive x values`,
                    'Use positive x values or switch to linear interpolation'
                );
            }
            if (interpolation.endsWith('log') && p.some((v) => v <= 0)) {
                add(
                    issues,
                    scope,
                    `${label} log interpolation needs strictly positive probabilities`,
                    'Use a small positive density (for example 1e-12) or switch to linear interpolation'
                );
            }
            if (scope === 'time' && x.some((v) => v < 0)) {
                add(issues, scope, `${label} table contains a negative time`, 'Time values are seconds and must be non-negative');
            }
            if (distribution.interpolation && !TABULAR_INTERPOLATION_SCHEMES.includes(distribution.interpolation)) {
                add(
                    issues,
                    scope,
                    `${label} table has an unknown interpolation scheme`,
                    'Choose histogram, linear-linear, linear-log, log-linear, or log-log'
                );
            }
            return;
        }
        case 'mixture': {
            if (distribution.distributions.length === 0) {
                add(issues, scope, `${label} mixture has no component distributions`, 'Add at least one component with a probability');
                return;
            }
            if (distribution.probability.length !== distribution.distributions.length) {
                add(
                    issues,
                    scope,
                    `${label} mixture has ${distribution.distributions.length} components but ${distribution.probability.length} probabilities`,
                    'Keep one probability per component; add or remove rows together'
                );
            }
            if (distribution.probability.some((p) => !Number.isFinite(p) || p < 0)) {
                add(
                    issues,
                    scope,
                    `${label} mixture probabilities must be non-negative numbers`,
                    'Replace negative or empty probabilities with values at least zero'
                );
            }
            const sum = distribution.probability.reduce((total, p) => total + (Number.isFinite(p) ? p : 0), 0);
            if (Math.abs(sum - 1) > 1e-6) {
                add(
                    issues,
                    scope,
                    `${label} mixture probabilities sum to ${fmt(sum)} (must be 1)`,
                    'Adjust the component probabilities so they add up to 1; the editor shows the running sum'
                );
            }
            distribution.distributions.forEach((child, index) => {
                validateUnivariate(child, issues, scope, `${label} mixture component ${index + 1}`);
            });
            return;
        }
        case 'decay-spectrum':
            if (scope !== 'energy') {
                add(issues, scope, `${label} cannot use a decay spectrum`, 'Decay spectra are energy distributions for photon sources');
            }
            validateDecaySpectrum(distribution, issues, label);
            return;
        case 'muir':
            if (
                !Number.isFinite(distribution.e0) ||
                distribution.e0 <= 0 ||
                !Number.isFinite(distribution.m_rat) ||
                distribution.m_rat <= 0 ||
                !Number.isFinite(distribution.kt) ||
                distribution.kt <= 0
            ) {
                add(issues, scope, `${label} Muir parameters must be positive`, 'Enter e0, the mass ratio, and kt as positive numbers');
            }
            return;
        default:
            add(issues, scope, `${label} has an unsupported distribution type`, 'Choose a supported distribution from the type selector');
    }
}

/** Validate a decay spectrum's nuclides and volume. */
function validateDecaySpectrum(distribution: OpenMCDecaySpectrumUnivariate, issues: SourceDistributionIssue[], label: string): void {
    if (distribution.nuclides.length === 0) {
        add(issues, 'energy', `${label} decay spectrum has no nuclides`, 'Add at least one nuclide with a positive atom density');
    }
    const seen = new Set<string>();
    distribution.nuclides.forEach((nuclide, index) => {
        if (!nuclide.name.trim()) {
            add(
                issues,
                'energy',
                `${label} decay spectrum row ${index + 1} has no nuclide name`,
                'Enter a chain nuclide name such as Cs137'
            );
        } else if (seen.has(nuclide.name)) {
            add(
                issues,
                'energy',
                `${label} decay spectrum repeats nuclide ${nuclide.name}`,
                'Combine duplicate nuclide rows into one density'
            );
        }
        seen.add(nuclide.name);
        if (!Number.isFinite(nuclide.density) || nuclide.density <= 0) {
            add(
                issues,
                'energy',
                `${label} decay spectrum density for ${nuclide.name || `row ${index + 1}`} must be positive`,
                'Enter the atom density in atom/b-cm (greater than zero)'
            );
        }
    });
    if (!Number.isFinite(distribution.volume) || distribution.volume <= 0) {
        add(
            issues,
            'energy',
            `${label} decay spectrum volume must be positive`,
            'Enter the source-region volume in cm³ (greater than zero)'
        );
    }
}

/** Validate an energy distribution. */
function validateEnergy(
    distribution: OpenMCSourceEnergy,
    issues: SourceDistributionIssue[],
    scope: SourceDistributionScope,
    label: string
): void {
    validateUnivariate(distribution, issues, scope, label);
}

/** Validate an angular distribution. */
function validateAngle(angle: OpenMCSourceAngle, issues: SourceDistributionIssue[]): void {
    if (angle.type === 'monodirectional') {
        if (angle.referenceUvW && !validNonZeroVector(angle.referenceUvW)) {
            add(
                issues,
                'angle',
                'Monodirectional reference vector must be non-zero',
                'Enter a direction such as 0 0 1; OpenMC normalizes the vector'
            );
        }
        return;
    }
    if (angle.type === 'mu-phi') {
        if (angle.referenceUvW && !validNonZeroVector(angle.referenceUvW)) {
            add(issues, 'angle', 'mu-phi polar reference vector must be non-zero', 'Enter a direction such as 0 0 1');
        }
        if (angle.referenceVwu && !validNonZeroVector(angle.referenceVwu)) {
            add(issues, 'angle', 'mu-phi azimuthal reference vector must be non-zero', 'Enter a direction such as 1 0 0');
        }
        const referenceU = angle.referenceUvW ?? [0, 0, 1];
        const referenceV = angle.referenceVwu ?? [1, 0, 0];
        if (validNonZeroVector(referenceU) && validNonZeroVector(referenceV) && !perpendicular(referenceU, referenceV)) {
            add(
                issues,
                'angle',
                'mu-phi reference vectors must not be parallel',
                'Choose two perpendicular directions, for example uvw = 0 0 1 and vwu = 1 0 0'
            );
        }
        validateUnivariate(angle.mu, issues, 'angle', 'mu distribution');
        validateUnivariate(angle.phi, issues, 'angle', 'phi distribution');
    }
}

/** Validate a time distribution (seconds). */
function validateTime(time: OpenMCSourceTime, issues: SourceDistributionIssue[]): void {
    if (time.type === 'delta') {
        if (!Number.isFinite(time.time) || time.time < 0) {
            add(
                issues,
                'time',
                'Delta time must be non-negative',
                'Enter a particle birth time in seconds (greater than or equal to zero)'
            );
        }
        return;
    }
    validateUnivariate(time, issues, 'time', 'Time');
}

/** Validate a spatial distribution. */
function validateSpatial(spatial: OpenMCSourceSpatial, issues: SourceDistributionIssue[], meshes: OpenMCMesh[]): void {
    switch (spatial.type) {
        case 'point':
            if (spatial.origin.length !== 3 || !spatial.origin.every((v) => Number.isFinite(v))) {
                add(issues, 'spatial', 'Point source needs three finite coordinates', 'Enter x, y, and z values');
            }
            return;
        case 'box':
            if (
                spatial.lowerLeft.length !== 3 ||
                spatial.upperRight.length !== 3 ||
                !spatial.lowerLeft.every((v) => Number.isFinite(v)) ||
                !spatial.upperRight.every((v) => Number.isFinite(v))
            ) {
                add(
                    issues,
                    'spatial',
                    'Box source corners need three finite coordinates each',
                    'Enter lower-left and upper-right x, y, z values'
                );
            } else if (spatial.lowerLeft.some((v, i) => v >= spatial.upperRight[i])) {
                add(
                    issues,
                    'spatial',
                    'Box upper-right corner must be greater than the lower-left corner on every axis',
                    'Increase the max x/y/z values or decrease the min values'
                );
            }
            return;
        case 'sphere':
            if (!Number.isFinite(spatial.radius) || spatial.radius <= 0) {
                add(issues, 'spatial', 'Sphere radius must be positive', 'Enter a radius greater than zero');
            }
            if (spatial.center.length !== 3 || !spatial.center.every((v) => Number.isFinite(v))) {
                add(issues, 'spatial', 'Sphere center needs three finite coordinates', 'Enter the center x, y, and z values');
            }
            return;
        case 'cylinder':
            if (!Number.isFinite(spatial.radius) || spatial.radius <= 0) {
                add(issues, 'spatial', 'Cylinder radius must be positive', 'Enter a radius greater than zero');
            }
            if (!Number.isFinite(spatial.height) || spatial.height <= 0) {
                add(issues, 'spatial', 'Cylinder height must be positive', 'Enter a height greater than zero');
            }
            if (!['x', 'y', 'z'].includes(spatial.axis)) {
                add(issues, 'spatial', 'Cylinder axis must be x, y, or z', 'Choose a cylinder axis');
            }
            return;
        case 'cartesian':
            validateUnivariate(spatial.x, issues, 'spatial', 'Cartesian x distribution');
            validateUnivariate(spatial.y, issues, 'spatial', 'Cartesian y distribution');
            validateUnivariate(spatial.z, issues, 'spatial', 'Cartesian z distribution');
            return;
        case 'cylindrical': {
            validateUnivariate(spatial.r, issues, 'spatial', 'Cylindrical r distribution');
            validateUnivariate(spatial.phi, issues, 'spatial', 'Cylindrical phi distribution');
            validateUnivariate(spatial.z, issues, 'spatial', 'Cylindrical z distribution');
            const rDir = spatial.rDir ?? [1, 0, 0];
            const zDir = spatial.zDir ?? [0, 0, 1];
            if (!validNonZeroVector(rDir) || !validNonZeroVector(zDir)) {
                add(issues, 'spatial', 'Cylindrical r_dir and z_dir must be non-zero vectors', 'Enter three components for each direction');
            } else if (!perpendicular(rDir, zDir)) {
                add(
                    issues,
                    'spatial',
                    'Cylindrical r_dir must be perpendicular to z_dir',
                    'Adjust r_dir so its dot product with z_dir is zero'
                );
            }
            if (spatial.origin && (spatial.origin.length !== 3 || !spatial.origin.every((v) => Number.isFinite(v)))) {
                add(issues, 'spatial', 'Cylindrical origin needs three finite coordinates', 'Enter the reference-frame origin x, y, and z');
            }
            return;
        }
        case 'spherical':
            validateUnivariate(spatial.r, issues, 'spatial', 'Spherical r distribution');
            validateUnivariate(spatial.cosTheta, issues, 'spatial', 'Spherical cos_theta distribution');
            validateUnivariate(spatial.phi, issues, 'spatial', 'Spherical phi distribution');
            if (spatial.origin && (spatial.origin.length !== 3 || !spatial.origin.every((v) => Number.isFinite(v)))) {
                add(issues, 'spatial', 'Spherical origin needs three finite coordinates', 'Enter the center x, y, and z');
            }
            return;
        case 'pointcloud': {
            if (spatial.positions.length === 0) {
                add(issues, 'spatial', 'Point cloud has no points', 'Add at least one x/y/z row');
                return;
            }
            const bad = spatial.positions.findIndex((position) => position.length !== 3 || !position.every((v) => Number.isFinite(v)));
            if (bad >= 0) {
                add(
                    issues,
                    'spatial',
                    `Point cloud row ${bad + 1} does not have three finite coordinates`,
                    'Give every row x, y, and z values'
                );
            }
            if (spatial.strengths) {
                if (spatial.strengths.length !== spatial.positions.length) {
                    add(
                        issues,
                        'spatial',
                        `Point cloud has ${spatial.positions.length} positions but ${spatial.strengths.length} strengths`,
                        'Give every point one strength, or clear the strength column to sample points equally'
                    );
                }
                if (spatial.strengths.some((s) => !Number.isFinite(s) || s < 0)) {
                    add(
                        issues,
                        'spatial',
                        'Point cloud strengths must be non-negative numbers',
                        'Replace negative or empty strengths with values at least zero'
                    );
                }
            }
            return;
        }
        case 'mesh': {
            if (spatial.meshId === undefined) {
                add(
                    issues,
                    'spatial',
                    'Mesh spatial distribution has no mesh selected',
                    'Select a mesh from the list, or use a Mesh source for per-element sub-sources'
                );
                return;
            }
            const mesh = meshes.find((m) => m.id === spatial.meshId);
            if (!mesh) {
                add(
                    issues,
                    'spatial',
                    `Mesh spatial distribution references mesh ${spatial.meshId}, which does not exist`,
                    'Select an existing mesh or create one in the Tally Configurator'
                );
                return;
            }
            const elementCount = getMeshElementCount(mesh);
            if (spatial.strengths) {
                if (spatial.strengths.some((s) => !Number.isFinite(s) || s < 0)) {
                    add(
                        issues,
                        'spatial',
                        'Mesh spatial strengths must be non-negative numbers',
                        'Replace negative or empty strengths with values at least zero'
                    );
                }
                if (elementCount !== undefined && spatial.strengths.length !== elementCount) {
                    add(
                        issues,
                        'spatial',
                        `Mesh spatial distribution has ${spatial.strengths.length} strengths but the mesh has ${elementCount} elements`,
                        'Provide one strength per mesh element, or clear the strengths field to sample elements uniformly'
                    );
                }
            }
            return;
        }
        default:
            add(issues, 'spatial', 'Unsupported spatial distribution', 'Choose a supported spatial type');
    }
}
