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

import { injectable, inject } from '@theia/core/shared/inversify';
import { PythonCommandHelper } from '../../../services/python-command-helper';
import { XSGroupStructuresResponse } from '../../../../common/openmc-protocol';

@injectable()
export class OpenMCXSService {
    @inject(PythonCommandHelper)
    protected readonly pythonHelper: PythonCommandHelper;

    private get scriptPath(): string {
        return this.pythonHelper.findScript('server.py');
    }

    async getXSData(request: any): Promise<any> {
        const args = ['openmc.xs-plot', '--reactions', request.reactions.join(',')];

        if (request.nuclides?.length > 0) {
            args.push('--nuclides', request.nuclides.join(','));
        }
        args.push('--temperature', (request.temperature || 294).toString());

        if (request.energyRegion) {
            args.push('--energy-region', request.energyRegion);
        } else if (request.energyRange) {
            args.push('--energy-min', request.energyRange[0].toString());
            args.push('--energy-max', request.energyRange[1].toString());
        }
        if (request.crossSectionsPath) {
            args.push('--cross-sections', request.crossSectionsPath);
        }
        if (request.temperatureComparison) {
            args.push('--temp-comparison', request.temperatureComparison.temperatures.join(','));
        }
        if (request.materials?.length > 0) {
            args.push('--materials', JSON.stringify(request.materials));
        }
        if (request.fluxSpectrum) {
            args.push('--flux-spectrum', JSON.stringify(request.fluxSpectrum));
        }
        if (request.libraryComparison) {
            args.push('--library-comparison', JSON.stringify(request.libraryComparison));
        }
        if (request.includeUncertainty) { args.push('--include-uncertainty'); }
        if (request.includeIntegrals) { args.push('--include-integrals'); }
        if (request.includeDerivative) { args.push('--include-derivative'); }
        if (request.groupStructure && request.groupStructure !== 'continuous') {
            args.push('--group-structure', request.groupStructure);
        }
        if (request.thermalScattering) {
            args.push('--thermal-scattering', JSON.stringify(request.thermalScattering));
        }

        const result = await this.pythonHelper.executeScript(this.scriptPath, args, {
            maxBuffer: 50 * 1024 * 1024,
            timeout: 120000
        });

        if (result.stderr) {
            console.log(`[OpenMC] Python stderr: ${result.stderr}`);
        }
        if (result.status !== 0) {
            throw new Error(result.stderr || 'Failed to get XS data');
        }
        return JSON.parse(result.stdout);
    }

    async getAvailableNuclides(crossSectionsPath?: string): Promise<string[]> {
        const args = ['openmc.list-nuclides'];
        if (crossSectionsPath) { args.push('--cross-sections', crossSectionsPath); }

        const result = await this.pythonHelper.executeScript(this.scriptPath, args, { timeout: 30000 });
        if (result.status !== 0) { return []; }
        try { return JSON.parse(result.stdout).nuclides || []; } catch { return []; }
    }

    async getAvailableThermalMaterials(crossSectionsPath?: string): Promise<string[]> {
        const args = ['openmc.list-thermal-materials'];
        if (crossSectionsPath) { args.push('--cross-sections', crossSectionsPath); }

        const result = await this.pythonHelper.executeScript(this.scriptPath, args, { timeout: 30000 });
        if (result.status !== 0) { return []; }
        try { return JSON.parse(result.stdout).materials || []; } catch { return []; }
    }

    async getGroupStructures(): Promise<XSGroupStructuresResponse> {
        const result = await this.pythonHelper.executeScript(this.scriptPath, ['openmc.list-group-structures'], { timeout: 10000 });
        if (result.status !== 0) {
            return { structures: [], metadata: { openmc_available: false, sources: [] } };
        }
        try {
            const data = JSON.parse(result.stdout);
            return {
                structures: data.structures || [],
                metadata: data.metadata || { openmc_available: false, sources: [] }
            };
        } catch {
            return { structures: [], metadata: { openmc_available: false, sources: [] } };
        }
    }
}
