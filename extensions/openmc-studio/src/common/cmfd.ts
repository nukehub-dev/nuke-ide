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
 * CMFD (Coarse Mesh Finite Difference) acceleration codegen helpers.
 *
 * CMFD is a C-API feature in this OpenMC version: there is no settings.xml
 * representation, so configuration happens entirely through
 * `openmc.cmfd.CMFDMesh` / `openmc.cmfd.CMFDRun` property assignments. This
 * module is deliberately free of Theia imports so it can be unit-tested under
 * vitest's node environment and reused by the browser-side Python exporter.
 *
 * @module openmc-studio/common
 */

import { OpenMCCmfdSettings, OpenMCState } from './openmc-state-schema';

/**
 * Resolve the CMFD run configuration to send to the backend driver.
 *
 * The `python/run_cmfd.py` driver only understands an inline mesh spec, so a
 * `meshRef` pointing at a regular state mesh is resolved to that mesh's
 * bounds/dimension here (the driver has no access to the state). Returns
 * `undefined` when CMFD is disabled, so callers can spread the result
 * directly into the run request.
 *
 * @param state - The current {@link OpenMCState}.
 * @returns The CMFD config with an inline mesh spec, or `undefined`.
 */
export function resolveCmfdRunConfig(state: OpenMCState): OpenMCCmfdSettings | undefined {
    const cmfd = state.settings.cmfd;
    if (!cmfd?.enabled) {
        return undefined;
    }

    if (cmfd.meshRef !== undefined) {
        const ref = state.meshes.find((m) => m.id === cmfd.meshRef);
        if (ref?.type === 'regular') {
            return {
                ...cmfd,
                meshRef: undefined,
                mesh: {
                    lowerLeft: ref.lowerLeft,
                    upperRight: ref.upperRight,
                    dimension: ref.dimension,
                    albedo: cmfd.mesh?.albedo
                }
            };
        }
    }

    return cmfd;
}

/**
 * Generate the Python code lines for CMFD acceleration (openmc.cmfd).
 *
 * Assumes `state.settings.cmfd?.enabled` is true; callers gate on that.
 *
 * @param state - The current {@link OpenMCState}.
 * @param includeComments - Whether to emit the section header comments.
 * @returns An array of code lines.
 */
export function generateCmfdCodeLines(state: OpenMCState, includeComments: boolean): string[] {
    const lines: string[] = [];
    const cmfd = state.settings.cmfd!;

    if (includeComments) {
        lines.push('#==============================================================================');
        lines.push('# CMFD Acceleration (Coarse Mesh Finite Difference)');
        lines.push('#==============================================================================');
    }

    lines.push('import openmc.cmfd');
    lines.push('cmfd_mesh = openmc.cmfd.CMFDMesh()');

    // Mesh geometry: referenced state mesh (built in the mesh section) or inline spec
    if (cmfd.meshRef !== undefined) {
        lines.push(`cmfd_mesh.lower_left = mesh_${cmfd.meshRef}.lower_left`);
        lines.push(`cmfd_mesh.upper_right = mesh_${cmfd.meshRef}.upper_right`);
        lines.push(`cmfd_mesh.dimension = mesh_${cmfd.meshRef}.dimension`);
    } else if (cmfd.mesh) {
        if (cmfd.mesh.lowerLeft) {
            lines.push(`cmfd_mesh.lower_left = (${cmfd.mesh.lowerLeft.join(', ')})`);
        }
        if (cmfd.mesh.upperRight) {
            lines.push(`cmfd_mesh.upper_right = (${cmfd.mesh.upperRight.join(', ')})`);
        }
        if (cmfd.mesh.dimension) {
            lines.push(`cmfd_mesh.dimension = (${cmfd.mesh.dimension.join(', ')})`);
        }
    }
    const albedo = cmfd.mesh?.albedo ?? [1, 1, 1, 1, 1, 1];
    lines.push(`cmfd_mesh.albedo = (${albedo.join(', ')})`);

    lines.push('cmfd_run = openmc.cmfd.CMFDRun()');
    lines.push('cmfd_run.mesh = cmfd_mesh');
    lines.push(`cmfd_run.feedback = ${cmfd.feedback ? 'True' : 'False'}`);
    if (cmfd.tallyBegin !== undefined) {
        lines.push(`cmfd_run.tally_begin = ${cmfd.tallyBegin}`);
    }
    if (cmfd.solverBegin !== undefined) {
        lines.push(`cmfd_run.solver_begin = ${cmfd.solverBegin}`);
    }
    if (cmfd.cmfdKtol !== undefined) {
        lines.push(`cmfd_run.cmfd_ktol = ${cmfd.cmfdKtol}`);
    }
    if (cmfd.stol !== undefined) {
        lines.push(`cmfd_run.stol = ${cmfd.stol}`);
    }
    if (cmfd.norm !== undefined) {
        lines.push(`cmfd_run.norm = ${cmfd.norm}`);
    }
    if (cmfd.gaussSeidelTolerance) {
        lines.push(`cmfd_run.gauss_seidel_tolerance = [${cmfd.gaussSeidelTolerance.join(', ')}]`);
    }
    if (cmfd.downscatter !== undefined) {
        lines.push(`cmfd_run.downscatter = ${cmfd.downscatter ? 'True' : 'False'}`);
    }
    if (cmfd.powerMonitor !== undefined) {
        lines.push(`cmfd_run.power_monitor = ${cmfd.powerMonitor ? 'True' : 'False'}`);
    }
    if (cmfd.windowType) {
        lines.push(`cmfd_run.window_type = '${cmfd.windowType}'`);
    }
    if (cmfd.windowSize !== undefined) {
        lines.push(`cmfd_run.window_size = ${cmfd.windowSize}`);
    }
    if (cmfd.runAdjoint) {
        lines.push('cmfd_run.run_adjoint = True');
        if (cmfd.adjointType) {
            lines.push(`cmfd_run.adjoint_type = '${cmfd.adjointType}'`);
        }
    }

    lines.push('# cmfd_run.run()  # Uncomment to run with CMFD acceleration (replaces openmc.run())');

    return lines;
}
