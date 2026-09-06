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
import * as os from 'os';
import * as path from 'path';
import { PythonCommandHelper } from '../../../services/python-command-helper';
import { OpenMCGeometryMeshResult } from '../../../../common/openmc-protocol';

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
            if (parsed.error) {
                return parsed;
            }
            return parsed;
        } catch (e) {
            throw new Error('Failed to parse geometry data. The file may be corrupted or not a valid geometry file.');
        }
    }

    async getMaterials(filePath: string): Promise<any> {
        return this.pythonHelper.executeScriptJson<any>(this.scriptPath, ['openmc.materials', filePath], {
            timeout: 30000,
            maxBuffer: 10 * 1024 * 1024
        });
    }

    async getMaterialCellLinkage(materialsPath: string, geometryPath: string): Promise<any> {
        return this.pythonHelper.executeScriptJson<any>(this.scriptPath, ['openmc.material-cell-linkage', materialsPath, geometryPath], {
            timeout: 30000,
            maxBuffer: 10 * 1024 * 1024
        });
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
            'openmc.mix-materials',
            request.filePath,
            '--material-ids',
            request.materialIds.join(','),
            '--fractions',
            request.fractions.join(','),
            '--percent-type',
            request.percentType
        ];
        if (request.name) {
            args.push('--name', request.name);
        }
        if (request.id !== undefined) {
            args.push('--id', request.id.toString());
        }

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
            } catch {
                /* not JSON */
            }
        }

        throw new Error(result.stderr || 'Failed to mix materials');
    }

    async addMaterialToFile(filePath: string, materialXml: string): Promise<void> {
        await this.pythonHelper.executeScriptJson<any>(this.scriptPath, ['openmc.add-material', filePath, materialXml], { timeout: 30000 });
    }

    async checkOverlaps(request: {
        geometryPath: string;
        samplePoints?: number;
        tolerance?: number;
        bounds?: any;
        parallel?: boolean;
    }): Promise<any> {
        const args: string[] = [
            'openmc.check-overlaps',
            request.geometryPath,
            '--samples',
            (request.samplePoints || 100000).toString(),
            '--tolerance',
            (request.tolerance || 1e-6).toString()
        ];
        if (request.bounds) {
            args.push('--bounds', JSON.stringify(request.bounds));
        }
        if (request.parallel) {
            args.push('--parallel');
        }

        return this.pythonHelper.executeScriptJson<any>(this.scriptPath, args, { timeout: 300000, maxBuffer: 50 * 1024 * 1024 });
    }

    async getOverlapVisualization(geometryPath: string, overlaps: any[]): Promise<any> {
        return this.pythonHelper.executeScriptJson<any>(
            this.scriptPath,
            ['openmc.overlap-viz', geometryPath, '--overlaps', JSON.stringify(overlaps), '--marker-size', '1.0'],
            { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
        );
    }

    /**
     * Extract CSG geometry as three.js-ready mesh JSON without starting a
     * server (`openmc.geometry-mesh --out <tmp>`). Failures surface as
     * `{ success: false, error }` — never a throw — so the native viewer
     * contribution can keep the tree + trame-3D path working.
     */
    async extractGeometryMesh(filePath: string, segments?: number): Promise<OpenMCGeometryMeshResult> {
        try {
            const args: string[] = ['openmc.geometry-mesh', '--file', filePath];
            if (segments !== undefined) {
                args.push('--segments', String(segments));
            }
            const outPath = path.join(os.tmpdir(), `nuke-geometry-mesh-${Date.now()}.json`);
            args.push('--out', outPath);
            // Raw execute (not executeScriptJson): openmc-plugin commands
            // report errors as `{"error": ...}` on stdout with exit 1, and
            // the stdout-first parse below surfaces that genuine message.
            const result = await this.pythonHelper.executeScript(this.scriptPath, args, {
                timeout: 120000,
                maxBuffer: 10 * 1024 * 1024
            });
            if (!result.stdout || result.stdout.trim() === '') {
                return { success: false, error: result.stderr.trim() || 'Geometry mesh extraction returned empty output' };
            }
            let parsed: Record<string, unknown>;
            try {
                parsed = JSON.parse(result.stdout) as Record<string, unknown>;
            } catch {
                return { success: false, error: `Geometry mesh extraction produced non-JSON output: ${result.stdout.substring(0, 500)}` };
            }
            if (result.status !== 0 || typeof parsed.error === 'string') {
                const message =
                    (typeof parsed.error === 'string' && parsed.error) ||
                    result.stderr.trim() ||
                    `Command 'openmc.geometry-mesh' exited with code ${result.status}`;
                return { success: false, error: message };
            }
            if (typeof parsed.meshPath !== 'string') {
                return { success: false, error: 'Geometry mesh extraction returned no meshPath' };
            }
            return {
                success: true,
                meshPath: parsed.meshPath,
                sourceFile: typeof parsed.sourceFile === 'string' ? parsed.sourceFile : undefined,
                stats: typeof parsed.stats === 'object' && parsed.stats !== null ? (parsed.stats as Record<string, unknown>) : undefined
            };
        } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    }
}
