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
 * Python source-code generation for OpenMC source distributions.
 *
 * Uses the same shared univariate model as XML generation so the two export
 * paths cannot drift. Nested distributions are emitted as named variables
 * (`source_0_energy_0`, `source_0_space_x`, ...) before their parent.
 *
 * @module openmc-studio/browser
 */

import { OpenMCSourceAngle, OpenMCSourceEnergy, OpenMCSourceSpatial, OpenMCSourceTime } from '../../common/openmc-state-schema';

/** Generated statements plus the expression variable that holds the value. */
export interface GeneratedDistributionCode {
    /** Assignment lines (children first, parent last). */
    lines: string[];
    /** Variable name holding the generated value. */
    expression: string;
}

/** Render a numeric/string list as a Python list literal. */
function list(values: Array<number | string>): string {
    return `[${values.map((value) => String(value)).join(', ')}]`;
}

/** Render a point as `[x, y, z]`. */
function point(values: number[]): string {
    return list(values.slice(0, 3));
}

/**
 * Render a direction vector with float components. OpenMC's Python setters
 * mutate integer numpy arrays in place when normalizing, so `[0, 1, 0]` fails
 * for `r_dir`, `z_dir`, and `reference_vwu`; `[0.0, 1.0, 0.0]` is safe.
 */
function floatVector(values: number[]): string {
    return list(values.slice(0, 3).map((value) => (Number.isInteger(value) ? `${value}.0` : value)));
}

/** Render a 3-vector or Python `None`. */
function optionalVector(values: [number, number, number] | undefined): string | undefined {
    return values ? point(values) : undefined;
}

/** Add a keyword argument only when it has a value. */
function keyword(name: string, value: string | undefined): string | undefined {
    return value === undefined ? undefined : `${name}=${value}`;
}

/** Join constructor arguments, dropping undefined entries. */
function callArguments(...args: Array<string | undefined>): string {
    return args.filter((arg): arg is string => arg !== undefined).join(', ');
}

/**
 * Generate a Python expression/statement block for one univariate distribution.
 * @param distribution - Distribution to generate.
 * @param variableName - Base variable name for the declaration.
 * @returns Generated lines and the variable holding the value.
 */
export function generateUnivariateCode(distribution: OpenMCSourceEnergy, variableName: string): GeneratedDistributionCode {
    const generated = generateUnivariateCodeCore(distribution, variableName);
    if (!distribution.bias) {
        return generated;
    }
    const bias = generateUnivariateBiasCode(distribution, variableName);
    if (!bias) {
        return generated;
    }
    return {
        lines: [
            ...generated.lines.slice(0, -1),
            ...bias.lines,
            injectCallKeyword(generated.lines[generated.lines.length - 1], `bias=${bias.expression}`)
        ],
        expression: generated.expression
    };
}

/**
 * Inject a keyword argument into the final Python call on an assignment line.
 * @param line - Assignment line ending in `)`.
 * @param argument - Keyword argument text (for example `bias=...`).
 * @returns The rewritten line.
 */
function injectCallKeyword(line: string, argument: string): string {
    const close = line.lastIndexOf(')');
    if (close < 0) {
        return line;
    }
    return `${line.slice(0, close)}, ${argument}${line.slice(close)}`;
}

/**
 * Generate the Python expression for a univariate bias.
 * @param distribution - Parent distribution.
 * @param variableName - Base variable name.
 * @returns Generated bias code, or undefined when the bias shape is incompatible.
 */
function generateUnivariateBiasCode(distribution: OpenMCSourceEnergy, variableName: string): GeneratedDistributionCode | undefined {
    const bias = distribution.bias;
    if (!bias || distribution.type === 'decay-spectrum') {
        return undefined;
    }
    if ('probabilities' in bias) {
        if (distribution.type !== 'discrete' && distribution.type !== 'mixture') {
            return undefined;
        }
        return {
            lines: [`${variableName}_bias = [${bias.probabilities.map((probability) => String(probability)).join(', ')}]`],
            expression: `${variableName}_bias`
        };
    }
    if (distribution.type === 'discrete' || distribution.type === 'mixture') {
        return undefined;
    }
    if (bias.distribution.type === 'discrete' || bias.distribution.type === 'mixture' || bias.distribution.type === 'decay-spectrum') {
        return undefined;
    }
    return generateUnivariateCode(bias.distribution, `${variableName}_bias`);
}

/**
 * Generate the core distribution without its own bias.
 * @param distribution - Distribution to generate.
 * @param variableName - Base variable name for the declaration.
 * @returns Generated lines and the variable holding the value.
 */
function generateUnivariateCodeCore(distribution: OpenMCSourceEnergy, variableName: string): GeneratedDistributionCode {
    if (distribution.type === 'muir') {
        return {
            lines: [`${variableName} = openmc.stats.muir(${distribution.e0}, ${distribution.m_rat}, ${distribution.kt})`],
            expression: variableName
        };
    }
    if (distribution.type === 'mixture') {
        const childLines: string[] = [];
        const childExpressions: string[] = [];
        distribution.distributions.forEach((child, index) => {
            const childCode = generateUnivariateCode(child, `${variableName}_${index}`);
            childLines.push(...childCode.lines);
            childExpressions.push(childCode.expression);
        });
        return {
            lines: [...childLines, `${variableName} = openmc.stats.Mixture(${list(distribution.probability)}, ${list(childExpressions)})`],
            expression: variableName
        };
    }
    switch (distribution.type) {
        case 'uniform':
            return {
                lines: [`${variableName} = openmc.stats.Uniform(${distribution.min}, ${distribution.max})`],
                expression: variableName
            };
        case 'maxwell':
            return {
                lines: [`${variableName} = openmc.stats.Maxwell(${distribution.temperature})`],
                expression: variableName
            };
        case 'watt':
            return {
                lines: [`${variableName} = openmc.stats.Watt(${distribution.a}, ${distribution.b})`],
                expression: variableName
            };
        case 'normal':
            return {
                lines: [`${variableName} = openmc.stats.Normal(${distribution.mean}, ${distribution.stdDev})`],
                expression: variableName
            };
        case 'powerlaw':
            return {
                lines: [`${variableName} = openmc.stats.PowerLaw(${distribution.a}, ${distribution.b}, ${distribution.n})`],
                expression: variableName
            };
        case 'tabular':
            return {
                lines: [
                    `${variableName} = openmc.stats.Tabular(${list(distribution.energies)}, ${list(
                        distribution.probabilities
                    )}, interpolation='${distribution.interpolation ?? 'linear-linear'}')`
                ],
                expression: variableName
            };
        case 'decay-spectrum': {
            const nuclides = distribution.nuclides.map((nuclide) => `${JSON.stringify(nuclide.name)}: ${nuclide.density}`).join(', ');
            return {
                lines: [`${variableName} = openmc.stats.DecaySpectrum({${nuclides}}, ${distribution.volume})`],
                expression: variableName
            };
        }
        case 'discrete': {
            const probabilities =
                distribution.probabilities && distribution.probabilities.length === distribution.energies.length
                    ? distribution.probabilities
                    : distribution.energies.map(() => 1 / distribution.energies.length);
            return {
                lines: [`${variableName} = openmc.stats.Discrete(${list(distribution.energies)}, ${list(probabilities)})`],
                expression: variableName
            };
        }
        default:
            return {
                lines: [`${variableName} = openmc.stats.Discrete([1e6], [1.0])`],
                expression: variableName
            };
    }
}

/**
 * Generate Python code for a spatial distribution.
 * @param spatial - Spatial distribution to generate.
 * @param variableName - Base variable name.
 * @returns Generated lines and the variable holding the value.
 */
export function generateSpatialCode(spatial: OpenMCSourceSpatial, variableName: string): GeneratedDistributionCode {
    const lines: string[] = [];
    if (spatial.type === 'point') {
        return { lines: [`${variableName} = openmc.stats.Point(${point(spatial.origin)})`], expression: variableName };
    }
    if (spatial.type === 'box') {
        return {
            lines: [`${variableName} = openmc.stats.Box(${point(spatial.lowerLeft)}, ${point(spatial.upperRight)})`],
            expression: variableName
        };
    }
    if (spatial.type === 'sphere') {
        const r = generateUnivariateCode({ type: 'uniform', min: 0, max: spatial.radius }, `${variableName}_r`);
        const cosTheta = generateUnivariateCode({ type: 'uniform', min: -1, max: 1 }, `${variableName}_cos_theta`);
        const phi = generateUnivariateCode({ type: 'uniform', min: 0, max: 2 * Math.PI }, `${variableName}_phi`);
        lines.push(...r.lines, ...cosTheta.lines, ...phi.lines);
        lines.push(
            `${variableName} = openmc.stats.SphericalIndependent(${callArguments(
                `r=${r.expression}`,
                `cos_theta=${cosTheta.expression}`,
                `phi=${phi.expression}`,
                keyword('origin', point(spatial.center))
            )})`
        );
        return { lines, expression: variableName };
    }
    if (spatial.type === 'cylinder') {
        const directions =
            spatial.axis === 'x'
                ? { rDir: [0, 1, 0], zDir: [1, 0, 0] }
                : spatial.axis === 'y'
                  ? { rDir: [0, 0, 1], zDir: [0, 1, 0] }
                  : { rDir: [1, 0, 0], zDir: [0, 0, 1] };
        const r = generateUnivariateCode({ type: 'uniform', min: 0, max: spatial.radius }, `${variableName}_r`);
        const phi = generateUnivariateCode({ type: 'uniform', min: 0, max: 2 * Math.PI }, `${variableName}_phi`);
        const z = generateUnivariateCode({ type: 'uniform', min: -spatial.height / 2, max: spatial.height / 2 }, `${variableName}_z`);
        lines.push(...r.lines, ...phi.lines, ...z.lines);
        lines.push(
            `${variableName} = openmc.stats.CylindricalIndependent(${callArguments(
                `r=${r.expression}`,
                `phi=${phi.expression}`,
                `z=${z.expression}`,
                keyword('origin', point(spatial.center)),
                spatial.axis === 'z' ? undefined : keyword('r_dir', floatVector(directions.rDir)),
                spatial.axis === 'z' ? undefined : keyword('z_dir', floatVector(directions.zDir))
            )})`
        );
        return { lines, expression: variableName };
    }
    if (spatial.type === 'cartesian') {
        const x = generateUnivariateCode(spatial.x, `${variableName}_x`);
        const y = generateUnivariateCode(spatial.y, `${variableName}_y`);
        const z = generateUnivariateCode(spatial.z, `${variableName}_z`);
        lines.push(...x.lines, ...y.lines, ...z.lines);
        lines.push(`${variableName} = openmc.stats.CartesianIndependent(x=${x.expression}, y=${y.expression}, z=${z.expression})`);
        return { lines, expression: variableName };
    }
    if (spatial.type === 'cylindrical') {
        const r = generateUnivariateCode(spatial.r, `${variableName}_r`);
        const phi = generateUnivariateCode(spatial.phi, `${variableName}_phi`);
        const z = generateUnivariateCode(spatial.z, `${variableName}_z`);
        lines.push(...r.lines, ...phi.lines, ...z.lines);
        lines.push(
            `${variableName} = openmc.stats.CylindricalIndependent(${callArguments(
                `r=${r.expression}`,
                `phi=${phi.expression}`,
                `z=${z.expression}`,
                keyword('origin', optionalVector(spatial.origin)),
                spatial.rDir ? keyword('r_dir', floatVector(spatial.rDir)) : undefined,
                spatial.zDir ? keyword('z_dir', floatVector(spatial.zDir)) : undefined
            )})`
        );
        return { lines, expression: variableName };
    }
    if (spatial.type === 'spherical') {
        const r = generateUnivariateCode(spatial.r, `${variableName}_r`);
        const cosTheta = generateUnivariateCode(spatial.cosTheta, `${variableName}_cos_theta`);
        const phi = generateUnivariateCode(spatial.phi, `${variableName}_phi`);
        lines.push(...r.lines, ...cosTheta.lines, ...phi.lines);
        lines.push(
            `${variableName} = openmc.stats.SphericalIndependent(${callArguments(
                `r=${r.expression}`,
                `cos_theta=${cosTheta.expression}`,
                `phi=${phi.expression}`,
                keyword('origin', optionalVector(spatial.origin))
            )})`
        );
        return { lines, expression: variableName };
    }
    if (spatial.type === 'pointcloud') {
        const positions = `[${spatial.positions.map(point).join(', ')}]`;
        const strengths = spatial.strengths && spatial.strengths.length > 0 ? keyword('strengths', list(spatial.strengths)) : undefined;
        const bias = spatial.bias ? keyword('bias', list(spatial.bias.probabilities)) : undefined;
        lines.push(`${variableName} = openmc.stats.PointCloud(${callArguments(positions, strengths, bias)})`);
        return { lines, expression: variableName };
    }
    // Mesh spatial distribution
    const meshId = spatial.meshId ?? 0;
    const strengths = spatial.strengths && spatial.strengths.length > 0 ? keyword('strengths', list(spatial.strengths)) : undefined;
    const bias = spatial.bias ? keyword('bias', list(spatial.bias.probabilities)) : undefined;
    lines.push(
        `${variableName} = openmc.stats.MeshSpatial(${callArguments(
            `mesh_${meshId}`,
            strengths,
            `volume_normalized=${(spatial.volumeNormalized ?? true) ? 'True' : 'False'}`,
            bias
        )})`
    );
    return { lines, expression: variableName };
}

/**
 * Generate Python code for an angular distribution.
 * @param angle - Angular distribution to generate.
 * @param variableName - Base variable name.
 * @returns Generated lines and the variable holding the value.
 */
export function generateAngleCode(angle: OpenMCSourceAngle, variableName: string): GeneratedDistributionCode {
    if (angle.type === 'isotropic') {
        if (!angle.bias || angle.bias.distribution.type !== 'mu-phi') {
            return { lines: [`${variableName} = openmc.stats.Isotropic()`], expression: variableName };
        }
        const bias = generateAngleCode(angle.bias.distribution, `${variableName}_bias`);
        return {
            lines: [...bias.lines, `${variableName} = openmc.stats.Isotropic(bias=${bias.expression})`],
            expression: variableName
        };
    }
    if (angle.type === 'monodirectional') {
        // Python's Monodirectional default is +x, but the C++ XML default is
        // +z; emit the explicit C++-compatible vector so both paths agree.
        const reference = floatVector(angle.referenceUvW ?? [0, 0, 1]);
        return {
            lines: [`${variableName} = openmc.stats.Monodirectional(${reference})`],
            expression: variableName
        };
    }
    const mu = generateUnivariateCode(angle.mu, `${variableName}_mu`);
    const phi = generateUnivariateCode(angle.phi, `${variableName}_phi`);
    return {
        lines: [
            ...mu.lines,
            ...phi.lines,
            `${variableName} = openmc.stats.PolarAzimuthal(${callArguments(
                `mu=${mu.expression}`,
                `phi=${phi.expression}`,
                angle.referenceUvW ? keyword('reference_uvw', floatVector(angle.referenceUvW)) : undefined,
                angle.referenceVwu ? keyword('reference_vwu', floatVector(angle.referenceVwu)) : undefined
            )})`
        ],
        expression: variableName
    };
}

/**
 * Generate Python code for a time distribution (seconds).
 * @param time - Time distribution to generate.
 * @param variableName - Base variable name.
 * @returns Generated lines and the variable holding the value.
 */
export function generateTimeCode(time: OpenMCSourceTime, variableName: string): GeneratedDistributionCode {
    if (time.type === 'delta') {
        return { lines: [`${variableName} = openmc.stats.delta_function(${time.time})`], expression: variableName };
    }
    return generateUnivariateCode(time, variableName);
}
