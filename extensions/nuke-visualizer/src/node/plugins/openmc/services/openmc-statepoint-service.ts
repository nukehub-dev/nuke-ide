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

import { injectable, inject } from '@theia/core/shared/inversify';
import {
    OpenMCStatepointInfo,
    OpenMCTallyInfo,
    OpenMCFilter,
    OpenMCStatepointFullInfo,
    OpenMCKGenerationData,
    OpenMCSourceData,
    OpenMCEnergyDistribution,
    PythonConfig
} from '../../../../common/openmc-protocol';
import { PythonCommandHelper } from '../../../services/python-command-helper';

@injectable()
export class OpenMCStatepointService {
    @inject(PythonCommandHelper)
    protected readonly pythonHelper: PythonCommandHelper;

    private readonly scriptPath: string;
    private pythonConfig: PythonConfig = {};

    constructor() {
        // Script path resolved lazily since helper is injected
        this.scriptPath = '';
    }

    setPythonConfig(config: PythonConfig): void {
        this.pythonConfig = config;
    }

    private getScriptPath(): string {
        if (!this.scriptPath) {
            return this.pythonHelper.findScript('openmc_server.py');
        }
        return this.scriptPath;
    }

    async loadStatepoint(statepointPath: string): Promise<OpenMCStatepointInfo> {
        await this.pythonHelper.syncConfig(this.pythonConfig);
        const raw = await this.pythonHelper.executeScriptJson<{
            batches: number;
            generations_per_batch?: number;
            k_eff?: number;
            k_eff_std?: number;
            n_tallies: number;
            tally_ids: number[];
        }>(this.getScriptPath(), ['info', statepointPath], { timeout: 30000 });

        return {
            file: statepointPath,
            batches: raw.batches,
            generationsPerBatch: raw.generations_per_batch || 1,
            kEff: raw.k_eff,
            kEffStd: raw.k_eff_std,
            nTallies: raw.n_tallies,
            tallyIds: raw.tally_ids
        };
    }

    async listTallies(statepointPath: string): Promise<OpenMCTallyInfo[]> {
        await this.pythonHelper.syncConfig(this.pythonConfig);
        const raw = await this.pythonHelper.executeScriptJson<
            Array<{
                id: number;
                name: string;
                scores: string[];
                nuclides: string[];
                filters: Array<{
                    type: string;
                    bins: number;
                    mesh_dimensions?: number[];
                    mesh_info?: { lower_left: number[]; upper_right: number[] };
                    mesh_type?: 'regular' | 'cylindrical';
                    width?: number[];
                }>;
                has_mesh: boolean;
            }>
        >(this.getScriptPath(), ['list', statepointPath], { timeout: 30000 });

        return raw.map(t => ({
            id: t.id,
            name: t.name,
            scores: t.scores,
            nuclides: t.nuclides,
            filters: t.filters.map((f): OpenMCFilter => ({
                type: f.type,
                bins: f.bins,
                meshDimensions: f.mesh_dimensions,
                meshBounds: f.mesh_info ? {
                    lowerLeft: f.mesh_info.lower_left,
                    upperRight: f.mesh_info.upper_right
                } : undefined,
                meshType: f.mesh_type,
                meshWidth: f.width
            })),
            hasMesh: t.has_mesh
        }));
    }

    async getStatepointFullInfo(statepointPath: string): Promise<OpenMCStatepointFullInfo> {
        await this.pythonHelper.syncConfig(this.pythonConfig);
        return await this.pythonHelper.executeScriptJson<OpenMCStatepointFullInfo>(
            this.getScriptPath(),
            ['statepoint-info', statepointPath],
            { timeout: 30000 }
        );
    }

    async getKGenerationData(statepointPath: string): Promise<OpenMCKGenerationData> {
        await this.pythonHelper.syncConfig(this.pythonConfig);
        return await this.pythonHelper.executeScriptJson<OpenMCKGenerationData>(
            this.getScriptPath(),
            ['k-generation', statepointPath],
            { timeout: 30000 }
        );
    }

    async getSourceData(statepointPath: string, maxParticles?: number): Promise<OpenMCSourceData> {
        await this.pythonHelper.syncConfig(this.pythonConfig);
        const args = ['source-data', statepointPath];
        if (maxParticles !== undefined) {
            args.push('--max-particles', maxParticles.toString());
        }
        return await this.pythonHelper.executeScriptJson<OpenMCSourceData>(
            this.getScriptPath(),
            args,
            { timeout: 30000 }
        );
    }

    async getEnergyDistribution(statepointPath: string, nBins?: number): Promise<OpenMCEnergyDistribution> {
        await this.pythonHelper.syncConfig(this.pythonConfig);
        const args = ['energy-distribution', statepointPath];
        if (nBins !== undefined) {
            args.push('--bins', nBins.toString());
        }
        return await this.pythonHelper.executeScriptJson<OpenMCEnergyDistribution>(
            this.getScriptPath(),
            args,
            { timeout: 30000 }
        );
    }

    async getEnergySpectrum(
        statepointPath: string,
        tallyId: number,
        scoreIndex?: number,
        nuclideIndex?: number
    ): Promise<{ energy_bins: number[]; values: number[]; std_dev: number[]; error?: string }> {
        await this.pythonHelper.syncConfig(this.pythonConfig);
        const args = ['spectrum', statepointPath, tallyId.toString()];
        if (scoreIndex !== undefined) {
            args.push('--score-index', scoreIndex.toString());
        }
        if (nuclideIndex !== undefined) {
            args.push('--nuclide-index', nuclideIndex.toString());
        }
        return await this.pythonHelper.executeScriptJson<{ energy_bins: number[]; values: number[]; std_dev: number[]; error?: string }>(
            this.getScriptPath(),
            args,
            { timeout: 30000 }
        );
    }

    async getSpatialPlot(
        statepointPath: string,
        tallyId: number,
        axis: 'x' | 'y' | 'z',
        scoreIndex?: number,
        nuclideIndex?: number
    ): Promise<{ positions: number[]; values: number[]; std_dev?: number[]; axis: string; error?: string }> {
        await this.pythonHelper.syncConfig(this.pythonConfig);
        const args = ['spatial', statepointPath, tallyId.toString(), axis];
        if (scoreIndex !== undefined) {
            args.push('--score-index', scoreIndex.toString());
        }
        if (nuclideIndex !== undefined) {
            args.push('--nuclide-index', nuclideIndex.toString());
        }
        return await this.pythonHelper.executeScriptJson<{ positions: number[]; values: number[]; std_dev?: number[]; axis: string; error?: string }>(
            this.getScriptPath(),
            args,
            { timeout: 30000 }
        );
    }

    async getHeatmapSlice(
        statepointPath: string,
        tallyId: number,
        plane: 'xy' | 'xz' | 'yz',
        sliceIndex: number,
        scoreIndex?: number,
        nuclideIndex?: number
    ): Promise<{
        values: number[][];
        std_dev?: number[][];
        x_coords: number[];
        y_coords: number[];
        x_label: string;
        y_label: string;
        plane: string;
        slice_index: number;
        total_slices: number;
        slice_position: number;
        slice_label: string;
        mesh_dimensions: number[];
        error?: string;
    }> {
        await this.pythonHelper.syncConfig(this.pythonConfig);
        const args = ['heatmap', statepointPath, tallyId.toString(), plane, sliceIndex.toString()];
        if (scoreIndex !== undefined) {
            args.push('--score-index', scoreIndex.toString());
        }
        if (nuclideIndex !== undefined) {
            args.push('--nuclide-index', nuclideIndex.toString());
        }
        return await this.pythonHelper.executeScriptJson<{
            values: number[][];
            std_dev?: number[][];
            x_coords: number[];
            y_coords: number[];
            x_label: string;
            y_label: string;
            plane: string;
            slice_index: number;
            total_slices: number;
            slice_position: number;
            slice_label: string;
            mesh_dimensions: number[];
            error?: string;
        }>(
            this.getScriptPath(),
            args,
            { timeout: 30000 }
        );
    }

    async getAllHeatmapSlices(
        statepointPath: string,
        tallyId: number,
        plane: 'xy' | 'xz' | 'yz',
        scoreIndex: number = 0,
        nuclideIndex: number = 0
    ): Promise<any[]> {
        await this.pythonHelper.syncConfig(this.pythonConfig);
        const args = [
            'heatmap-all', statepointPath, tallyId.toString(),
            plane,
            '--score-index', scoreIndex.toString(),
            '--nuclide-index', nuclideIndex.toString()
        ];

        const result = await this.pythonHelper.executeScript(this.getScriptPath(), args, {
            timeout: 60000,
            maxBuffer: 100 * 1024 * 1024  // 100MB for all slices
        });

        if (result.status !== 0) {
            console.error(`[OpenMC] Heatmap-all command failed with status ${result.status}`);
            console.error(`[OpenMC] stderr: ${result.stderr}`);
            throw new Error(result.stderr || `Command failed with status ${result.status}`);
        }

        try {
            console.log(`[OpenMC] Heatmap-all output length: ${result.stdout?.length || 0} characters`);
            return JSON.parse(result.stdout);
        } catch (e) {
            console.error(`[OpenMC] Failed to parse heatmap-all JSON: ${e}`);
            console.error(`[OpenMC] Raw output (first 500 chars): ${result.stdout?.substring(0, 500)}`);
            throw e;
        }
    }
}
