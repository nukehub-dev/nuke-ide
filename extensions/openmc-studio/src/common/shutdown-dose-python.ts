// *****************************************************************************
// Copyright (C) 2026 NukeHub and others.
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
 * Python export for the driver-only shutdown-dose configuration.
 *
 * The model XML never carries R2S/D1S settings, so the exported Python script
 * appends an equivalent analysis driver after the normal model export. The
 * generated code uses the same OpenMC APIs as `python/run_r2s.py` and
 * `python/run_d1s.py`.
 *
 * @module openmc-studio/common
 */

import { OpenMCShutdownDoseConfig } from './openmc-state-schema';
import { normalizeShutdownDoseSchedule } from './shutdown-dose';

/** Quote a path for Python source. */
function pyString(value: string): string {
    return JSON.stringify(value);
}

/** Render a Python list of numbers. */
function pyNumbers(values: number[]): string {
    return `[${values.map((value) => String(value)).join(', ')}]`;
}

/** Render the timestep schedule as OpenMC `(value, unit)` tuples. */
function pyTimesteps(config: OpenMCShutdownDoseConfig): string {
    const { schedule } = normalizeShutdownDoseSchedule(config);
    if (schedule.length === 0) {
        return '[]';
    }
    return `[${schedule.map((step) => `(${step.value}, ${pyString(step.unit)})`).join(', ')}]`;
}

/** Render the source-rate list. */
function pySourceRates(config: OpenMCShutdownDoseConfig): string {
    if (Array.isArray(config.sourceRates)) {
        return pyNumbers(config.sourceRates);
    }
    return `[${config.sourceRates}]`;
}

/**
 * Generate the shutdown-dose Python driver block.
 *
 * @param config - Persisted shutdown-dose configuration.
 * @returns Python source lines (empty when no configuration exists).
 */
export function generateShutdownDosePythonDriver(config?: OpenMCShutdownDoseConfig): string[] {
    if (!config) {
        return [];
    }
    const lines: string[] = [];
    lines.push('# ==============================================================================');
    lines.push('# Shutdown dose driver (R2S/D1S)');
    lines.push('# Driver-only configuration: none of this is represented in settings.xml.');
    lines.push('# ==============================================================================');
    lines.push('import datetime');
    lines.push('import pathlib');
    lines.push('import openmc.deplete');
    lines.push('');
    const chainArg = config.chainFile ? `chain_file=${pyString(config.chainFile)}` : '';
    const outputBase = config.outputDirectory ? `pathlib.Path(${pyString(config.outputDirectory)})` : 'pathlib.Path.cwd()';
    const outputLine = (prefix: string): string => `${outputBase} / ("${prefix}_" + datetime.datetime.now().strftime("%Y-%m-%dT%H-%M-%S"))`;

    if (config.method === 'r2s') {
        const domains =
            (config.domainType ?? 'cell') === 'mesh'
                ? `[${(config.meshIds ?? []).map((id) => `mesh_${id}`).join(', ')}]`
                : `[${(config.cellIds ?? []).map((id) => `cell_${id}`).join(', ')}]`;
        lines.push(`r2s_domains = ${domains}`);
        lines.push('r2s = openmc.deplete.R2SManager(model, r2s_domains)');
        if (config.photonTallyIds && config.photonTallyIds.length > 0) {
            lines.push(`r2s.photon_model.tallies = openmc.Tallies([${config.photonTallyIds.map((id) => `tally_${id}`).join(', ')}])`);
        }
        lines.push('r2s.photon_model.settings.photon_transport = True');
        lines.push('');
        const runArgs: string[] = ['output_dir=r2s_output'];
        lines.push(`r2s_output = ${outputLine('r2s')}`);
        lines.push('r2s_output.mkdir(parents=True, exist_ok=True)');
        if (chainArg) {
            runArgs.push(chainArg);
        }
        const boundingBoxes = Object.entries(config.boundingBoxes ?? {});
        if (boundingBoxes.length > 0) {
            lines.push('r2s_bounding_boxes = {');
            for (const [cellId, box] of boundingBoxes) {
                lines.push(`    ${cellId}: openmc.BoundingBox(${pyNumbers(box.lowerLeft)}, ${pyNumbers(box.upperRight)}),`);
            }
            lines.push('}');
            runArgs.push('bounding_boxes=r2s_bounding_boxes');
        }
        if (config.photonTimeIndices && config.photonTimeIndices.length > 0) {
            runArgs.push(`photon_time_indices=${pyNumbers(config.photonTimeIndices)}`);
        }
        if (config.matVolSamples) {
            runArgs.push(`mat_vol_kwargs={'n_samples': ${config.matVolSamples}}`);
        }
        if (config.byParentNuclide) {
            runArgs.push('by_parent_nuclide=True');
        }
        lines.push('r2s_timesteps = ' + pyTimesteps(config));
        lines.push('r2s_source_rates = ' + pySourceRates(config));
        lines.push(`r2s.run(r2s_timesteps, r2s_source_rates, timestep_units="s"${runArgs.length > 0 ? ', ' + runArgs.join(', ') : ''})`);
        if (config.runPhoton === false) {
            lines.push('# Note: the project disables photon transport; run() above still performs it.');
        }
    } else {
        lines.push('from openmc.deplete import d1s');
        lines.push('model.settings.use_decay_photons = True');
        lines.push('model.settings.photon_transport = True');
        lines.push(`d1s_nuclides = d1s.get_radionuclides(model${chainArg ? ', ' + chainArg : ''})`);
        lines.push(`d1s.prepare_tallies(model, d1s_nuclides${chainArg ? ', ' + chainArg : ''})`);
        lines.push(`d1s_timesteps = ${pyTimesteps(config)}`);
        lines.push(`d1s_source_rates = ${pySourceRates(config)}`);
        lines.push('d1s_factors = d1s.time_correction_factors(d1s_nuclides, d1s_timesteps, d1s_source_rates)');
        lines.push(`d1s_output_dir = ${outputLine('d1s')}`);
        lines.push('d1s_output_dir.mkdir(parents=True, exist_ok=True)');
        lines.push('d1s_output = model.run(cwd=d1s_output_dir)');
        const tallyIds = config.photonTallyIds ?? [];
        if (tallyIds.length > 0) {
            lines.push(`d1s_tally_ids = ${pyNumbers(tallyIds)}`);
        } else {
            lines.push('d1s_tally_ids = [tally.id for tally in model.tallies]');
        }
        lines.push('with openmc.StatePoint(d1s_output) as d1s_statepoint:');
        lines.push('    d1s_corrected = {');
        lines.push('        tally_id: d1s.apply_time_correction(');
        lines.push('            d1s_statepoint.tallies[tally_id],');
        lines.push('            d1s_factors,');
        lines.push(`            index=${config.d1sTimeIndex ?? -1},`);
        lines.push(`            sum_nuclides=${config.d1sSumNuclides !== false ? 'True' : 'False'},`);
        lines.push('        )');
        lines.push('        for tally_id in d1s_tally_ids');
        lines.push('    }');
    }
    lines.push('');
    return lines;
}
