// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

import { injectable, inject } from '@theia/core/shared/inversify';
import { PythonCommandHelper } from '../../../services/python-command-helper';

@injectable()
export class OpenMCDepletionService {
    @inject(PythonCommandHelper)
    protected readonly pythonHelper: PythonCommandHelper;

    private get scriptPath(): string {
        return this.pythonHelper.findScript('openmc_server.py');
    }

    async getDepletionSummary(filePath: string): Promise<any> {
        return this.pythonHelper.executeScriptJson<any>(
            this.scriptPath, ['depletion-summary', filePath], { timeout: 30000 }
        );
    }

    async getDepletionMaterials(filePath: string): Promise<any[]> {
        const result = await this.pythonHelper.executeScriptJson<any>(
            this.scriptPath, ['depletion-materials', filePath], { timeout: 30000 }
        );
        return result.materials || [];
    }

    async getDepletionData(
        filePath: string,
        materialIndex: number,
        nuclides?: string[],
        includeActivity?: boolean
    ): Promise<any> {
        const args = ['depletion-data', filePath, materialIndex.toString()];
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
