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

@injectable()
export class OpenMCDepletionService {
    @inject(PythonCommandHelper)
    protected readonly pythonHelper: PythonCommandHelper;

    private get scriptPath(): string {
        return this.pythonHelper.findScript('server.py');
    }

    async getDepletionSummary(filePath: string): Promise<any> {
        return this.pythonHelper.executeScriptJson<any>(
            this.scriptPath, ['openmc.depletion-summary', filePath], { timeout: 30000 }
        );
    }

    async getDepletionMaterials(filePath: string): Promise<any[]> {
        const result = await this.pythonHelper.executeScriptJson<any>(
            this.scriptPath, ['openmc.depletion-materials', filePath], { timeout: 30000 }
        );
        return result.materials || [];
    }

    async getDepletionData(
        filePath: string,
        materialIndex: number,
        nuclides?: string[],
        includeActivity?: boolean
    ): Promise<any> {
        const args = ['openmc.depletion-data', filePath, materialIndex.toString()];
        if (nuclides && nuclides.length > 0) {
            args.push('--nuclides', nuclides.join(','));
        }
        if (includeActivity) {
            args.push('--include-activity');
        }
        return this.pythonHelper.executeScriptJson<any>(
            this.scriptPath, args, { timeout: 60000, maxBuffer: 50 * 1024 * 1024 }
        );
    }
}
