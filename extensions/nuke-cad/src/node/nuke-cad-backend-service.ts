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
 * Nuke CAD backend service.
 *
 * Spawns the Python geometry service in the active nuke-core Python environment
 * and parses its stdout-JSON result.
 *
 * @module nuke-cad/node
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { resolvePythonScript } from 'nuke-core/lib/node/utils/script-resolver';
import { NukeCoreBackendService, NukeCoreBackendServiceInterface } from 'nuke-core/lib/common';
import * as path from 'path';

import { NukeCadBackendService, GeometryBuildRequest, GeometryBuildResult } from '../common/nuke-cad-protocol';
import { CAD_HEALTH_PACKAGES } from '../common/packages';

@injectable()
export class NukeCadBackendServiceImpl implements NukeCadBackendService {
    @inject(NukeCoreBackendService)
    protected readonly nukeCoreService: NukeCoreBackendServiceInterface;

    /**
     * Build geometry by invoking ``python/geometry_service.py``.
     */
    async buildGeometry(request: GeometryBuildRequest): Promise<GeometryBuildResult> {
        const scriptPath = resolvePythonScript({ packageName: 'nuke-cad', scriptName: 'geometry_service.py' });
        if (!scriptPath) {
            return {
                success: false,
                error: 'Geometry service script not found.',
                scriptPath: request.scriptPath
            };
        }

        const pythonCommand = await this.nukeCoreService.getPythonCommand();
        if (!pythonCommand) {
            return {
                success: false,
                error: 'No Python interpreter configured. Set a Python environment in Settings → Nuke Utils.',
                scriptPath: request.scriptPath
            };
        }

        const args = [scriptPath, request.scriptPath];
        if (request.outputDirectory) {
            args.push('--output-dir', request.outputDirectory);
        }
        if (request.tolerance !== undefined) {
            args.push('--tolerance', String(request.tolerance));
        }

        const { spawn } = await import('child_process');
        const pythonBinDir = path.dirname(pythonCommand);
        const currentPath = process.env.PATH || '';
        const newPath = currentPath.includes(pythonBinDir) ? currentPath : `${pythonBinDir}:${currentPath}`;

        return new Promise<GeometryBuildResult>((resolve) => {
            const child = spawn(pythonCommand, args, {
                cwd: path.dirname(request.scriptPath),
                env: { ...process.env, PATH: newPath },
                stdio: ['ignore', 'pipe', 'pipe']
            });

            let stdout = '';
            let stderr = '';

            child.stdout?.on('data', (data: Buffer) => {
                stdout += data.toString();
            });

            child.stderr?.on('data', (data: Buffer) => {
                stderr += data.toString();
            });

            child.on('error', (error) => {
                resolve({
                    success: false,
                    error: `Failed to start geometry service: ${error.message}`,
                    output: stderr,
                    scriptPath: request.scriptPath
                });
            });

            child.on('close', (code) => {
                const lines = stdout.trim().split('\n');
                for (let i = lines.length - 1; i >= 0; i--) {
                    const candidate = lines[i].trim();
                    if (!candidate.startsWith('{')) {
                        continue;
                    }
                    try {
                        const parsed = JSON.parse(candidate) as GeometryBuildResult;
                        const success = code !== 0 && parsed.success !== false ? false : parsed.success;
                        const result: GeometryBuildResult = {
                            ...parsed,
                            success,
                            error: success === false ? parsed.error || `Process exited with code ${code}` : parsed.error,
                            output: parsed.output ?? stderr
                        };
                        resolve(result);
                        return;
                    } catch {
                        // Not JSON; keep scanning backwards.
                    }
                }

                const detail = stderr.trim() || stdout.trim();
                resolve({
                    success: false,
                    error: `Geometry service exited with code ${code}${detail ? `: ${detail.slice(-500)}` : ''}`,
                    output: stderr,
                    scriptPath: request.scriptPath
                });
            });
        });
    }

    /**
     * Verify that the active environment has the CAD toolchain.
     */
    async checkCadEnvironment(): Promise<{ ready: boolean; missing: string[] }> {
        const pythonCommand = await this.nukeCoreService.getPythonCommand();
        if (!pythonCommand) {
            return { ready: false, missing: ['python'] };
        }

        const check = await this.nukeCoreService.checkDependencies(CAD_HEALTH_PACKAGES, pythonCommand);
        return { ready: check.available, missing: check.missing };
    }
}
