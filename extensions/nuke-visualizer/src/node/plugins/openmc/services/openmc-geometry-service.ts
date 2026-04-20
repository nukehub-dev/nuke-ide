// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

import { injectable, inject } from '@theia/core/shared/inversify';
import { PythonCommandHelper } from '../../../services/python-command-helper';

@injectable()
export class OpenMCGeometryService {
    @inject(PythonCommandHelper)
    protected readonly pythonHelper: PythonCommandHelper;

    private get scriptPath(): string {
        return this.pythonHelper.findScript('server.py');
    }

    async getGeometryHierarchy(filePath: string): Promise<any> {
        const result = await this.pythonHelper.executeScript(this.scriptPath, ['openmc.geometry', filePath], {
            timeout: 30000,
            maxBuffer: 10 * 1024 * 1024
        });

        if (!result.stdout || result.stdout.trim() === '') {
            throw new Error('Geometry parser returned empty output. The file may not be a valid OpenMC geometry file.');
        }

        try {
            const parsed = JSON.parse(result.stdout);
            if (parsed.error) { return parsed; }
            return parsed;
        } catch (e) {
            throw new Error('Failed to parse geometry data. The file may be corrupted or not a valid geometry file.');
        }
    }

    async getMaterials(filePath: string): Promise<any> {
        return this.pythonHelper.executeScriptJson<any>(
            this.scriptPath, ['openmc.materials', filePath], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
        );
    }

    async getMaterialCellLinkage(materialsPath: string, geometryPath: string): Promise<any> {
        return this.pythonHelper.executeScriptJson<any>(
            this.scriptPath, ['openmc.material-cell-linkage', materialsPath, geometryPath], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
        );
    }

    async mixMaterials(request: {
        filePath: string;
        materialIds: number[];
        fractions: number[];
        percentType: string;
        name?: string;
        id?: number;
    }): Promise<any> {
        const args = [
            'openmc.mix-materials', request.filePath,
            '--material-ids', request.materialIds.join(','),
            '--fractions', request.fractions.join(','),
            '--percent-type', request.percentType
        ];
        if (request.name) { args.push('--name', request.name); }
        if (request.id !== undefined) { args.push('--id', request.id.toString()); }

        const result = await this.pythonHelper.executeScript(this.scriptPath, args, { timeout: 30000 });

        if (result.stdout) {
            try {
                const data = JSON.parse(result.stdout);
                if (data.error) {
                    console.error(`[OpenMC] Mix materials failed: ${data.error}`);
                    return { error: data.error };
                }
                if (result.status === 0) {
                    return { material: data };
                }
            } catch { /* not JSON */ }
        }

        throw new Error(result.stderr || 'Failed to mix materials');
    }

    async addMaterialToFile(filePath: string, materialXml: string): Promise<void> {
        await this.pythonHelper.executeScriptJson<any>(
            this.scriptPath, ['openmc.add-material', filePath, materialXml], { timeout: 30000 }
        );
    }

    async checkOverlaps(request: {
        geometryPath: string;
        samplePoints?: number;
        tolerance?: number;
        bounds?: any;
        parallel?: boolean;
    }): Promise<any> {
        const args: string[] = [
            'openmc.check-overlaps', request.geometryPath,
            '--samples', (request.samplePoints || 100000).toString(),
            '--tolerance', (request.tolerance || 1e-6).toString()
        ];
        if (request.bounds) { args.push('--bounds', JSON.stringify(request.bounds)); }
        if (request.parallel) { args.push('--parallel'); }

        return this.pythonHelper.executeScriptJson<any>(
            this.scriptPath, args, { timeout: 300000, maxBuffer: 50 * 1024 * 1024 }
        );
    }

    async getOverlapVisualization(geometryPath: string, overlaps: any[]): Promise<any> {
        return this.pythonHelper.executeScriptJson<any>(
            this.scriptPath,
            ['openmc.overlap-viz', geometryPath, '--overlaps', JSON.stringify(overlaps), '--marker-size', '1.0'],
            { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
        );
    }
}
