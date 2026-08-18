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
import * as fs from 'fs';
import * as path from 'path';

import {
    NukeCadBackendService,
    GeometryBuildRequest,
    GeometryBuildResult,
    FemRunRequest,
    FemRunResult,
    FemMaterial,
    JobRunRequest,
    JobRunResult,
    FoamCaseRequest,
    FoamCaseResult,
    FoamStlExportRequest,
    FoamStlExportResult
} from '../common/nuke-cad-protocol';
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

        const ext = request.scriptPath.split('.').pop()?.toLowerCase();
        const sourceType = request.sourceType ?? (ext === 'step' || ext === 'stp' ? 'step' : 'script');
        const args = [scriptPath, request.scriptPath];
        if (sourceType === 'step') {
            args.push('--from-step');
        }
        if (request.outputDirectory) {
            args.push('--output-dir', request.outputDirectory);
        }
        if (request.tolerance !== undefined) {
            args.push('--tolerance', String(request.tolerance));
        }
        if (request.exportDagmc === false) {
            args.push('--no-dagmc');
        }
        if (request.exportMesh === false) {
            args.push('--no-mesh');
        }
        if (request.meshEngine) {
            args.push('--mesh-engine', request.meshEngine);
        }
        if (request.meshSize !== undefined) {
            args.push('--mesh-size', String(request.meshSize));
        }
        if (request.meshMinSize !== undefined) {
            args.push('--mesh-min-size', String(request.meshMinSize));
        }
        if (request.meshMaxSize !== undefined) {
            args.push('--mesh-max-size', String(request.meshMaxSize));
        }
        if (request.meshOrder !== undefined) {
            args.push('--mesh-order', String(request.meshOrder));
        }

        return this._spawnJsonService<GeometryBuildResult>(pythonCommand, args, path.dirname(request.scriptPath), request.scriptPath);
    }

    /**
     * Spawn a Python service that emits a JSON result on stdout and return the
     * parsed object.  Diagnostics on stderr are forwarded into the result's
     * ``output`` field when the service does not provide one.
     */
    private async _spawnJsonService<T extends { success?: boolean; output?: string; error?: string }>(
        pythonCommand: string,
        args: string[],
        cwd: string,
        scriptPath?: string
    ): Promise<T> {
        const { spawn } = await import('child_process');
        const pythonBinDir = path.dirname(pythonCommand);
        const currentPath = process.env.PATH || '';
        const newPath = currentPath.includes(pythonBinDir) ? currentPath : `${pythonBinDir}:${currentPath}`;

        return new Promise<T>((resolve) => {
            const child = spawn(pythonCommand, args, {
                cwd,
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
                    error: `Failed to start service: ${error.message}`,
                    output: stderr,
                    scriptPath
                } as unknown as T);
            });

            child.on('close', (code) => {
                const lines = stdout.trim().split('\n');
                for (let i = lines.length - 1; i >= 0; i--) {
                    const candidate = lines[i].trim();
                    if (!candidate.startsWith('{')) {
                        continue;
                    }
                    try {
                        const parsed = JSON.parse(candidate) as T;
                        const success = code !== 0 && parsed.success !== false ? false : parsed.success;
                        const result: T = {
                            ...parsed,
                            success,
                            error: success === false ? parsed.error || `Process exited with code ${code}` : parsed.error,
                            output: parsed.output ?? stderr
                        };
                        if (scriptPath !== undefined) {
                            (result as any).scriptPath = scriptPath;
                        }
                        resolve(result);
                        return;
                    } catch {
                        // Not JSON; keep scanning backwards.
                    }
                }

                const detail = stderr.trim() || stdout.trim();
                resolve({
                    success: false,
                    error: `Service exited with code ${code}${detail ? `: ${detail.slice(-500)}` : ''}`,
                    output: stderr,
                    scriptPath
                } as unknown as T);
            });
        });
    }

    /**
     * Run the FEM service: write a CalculiX input deck and optionally run ccx.
     */
    async runFem(request: FemRunRequest): Promise<FemRunResult> {
        const scriptPath = resolvePythonScript({ packageName: 'nuke-cad', scriptName: 'fem_service.py' });
        if (!scriptPath) {
            return { success: false, error: 'FEM service script not found.' };
        }

        const pythonCommand = await this.nukeCoreService.getPythonCommand();
        if (!pythonCommand) {
            return {
                success: false,
                error: 'No Python interpreter configured. Set a Python environment in Settings → Nuke Utils.'
            };
        }

        const requestPath = path.join(path.dirname(request.mshPath), `.nuke-cad-fem-request-${Date.now()}.json`);
        fs.writeFileSync(
            requestPath,
            JSON.stringify({
                mshPath: request.mshPath,
                outputDir: path.dirname(request.mshPath),
                materials: request.materials,
                boundaryConditions: request.boundaryConditions,
                step: request.step,
                run: request.run ?? true,
                ccxPath: request.ccxPath
            }),
            'utf-8'
        );

        try {
            return await this._spawnJsonService<FemRunResult>(
                pythonCommand,
                [scriptPath, '--request', requestPath],
                path.dirname(request.mshPath)
            );
        } finally {
            try {
                fs.unlinkSync(requestPath);
            } catch {
                // Temporary request file cleanup is best-effort.
            }
        }
    }

    /**
     * Return the built-in FEM material database from the Python service.
     */
    async listFemMaterials(): Promise<FemMaterial[]> {
        const scriptPath = resolvePythonScript({ packageName: 'nuke-cad', scriptName: 'fem_service.py' });
        if (!scriptPath) {
            return [];
        }

        const pythonCommand = await this.nukeCoreService.getPythonCommand();
        if (!pythonCommand) {
            return [];
        }

        return new Promise<FemMaterial[]>((resolve) => {
            const { spawn } = require('child_process');
            const child = spawn(pythonCommand, [scriptPath, '--list-materials'], {
                stdio: ['ignore', 'pipe', 'pipe']
            });

            let stdout = '';
            child.stdout?.on('data', (data: Buffer) => {
                stdout += data.toString();
            });

            child.on('close', () => {
                try {
                    const parsed = JSON.parse(stdout);
                    resolve(Object.values(parsed) as FemMaterial[]);
                } catch {
                    resolve([]);
                }
            });

            child.on('error', () => {
                resolve([]);
            });
        });
    }

    /**
     * Run a declarative job through the generic nuke-cad job runner.
     */
    async runJob(request: JobRunRequest): Promise<JobRunResult> {
        const scriptPath = resolvePythonScript({ packageName: 'nuke-cad', scriptName: 'job_service.py' });
        if (!scriptPath) {
            return { success: false, error: 'Job service script not found.', artifacts: [] };
        }

        const pythonCommand = await this.nukeCoreService.getPythonCommand();
        if (!pythonCommand) {
            return {
                success: false,
                error: 'No Python interpreter configured. Set a Python environment in Settings → Nuke Utils.',
                artifacts: []
            };
        }

        const requestPath = path.join(request.workingDirectory, `.nuke-cad-job-request-${Date.now()}.json`);
        fs.writeFileSync(requestPath, JSON.stringify(request), 'utf-8');

        try {
            return await this._spawnJsonService<JobRunResult>(
                pythonCommand,
                [scriptPath, '--request', requestPath],
                request.workingDirectory
            );
        } finally {
            try {
                fs.unlinkSync(requestPath);
            } catch {
                // Temporary request file cleanup is best-effort.
            }
        }
    }

    /**
     * Scaffold a new OpenFOAM case directory.
     */
    async buildFoamCase(request: FoamCaseRequest): Promise<FoamCaseResult> {
        return this._spawnFoamService<FoamCaseResult>(request, { operation: 'buildCase', ...request });
    }

    /**
     * Export per-solid STL files from a STEP file.
     */
    async exportFoamStl(request: FoamStlExportRequest): Promise<FoamStlExportResult> {
        return this._spawnFoamService<FoamStlExportResult>(request, { operation: 'exportStl', ...request });
    }

    /**
     * Return the built-in OpenFOAM solver template names.
     */
    async listFoamSolvers(): Promise<string[]> {
        const scriptPath = resolvePythonScript({ packageName: 'nuke-cad', scriptName: 'foam_service.py' });
        if (!scriptPath) {
            return [];
        }

        const pythonCommand = await this.nukeCoreService.getPythonCommand();
        if (!pythonCommand) {
            return [];
        }

        const requestPath = path.join(path.dirname(scriptPath), `.nuke-cad-foam-list-${Date.now()}.json`);
        fs.writeFileSync(requestPath, JSON.stringify({ operation: 'listSolvers', caseDir: path.dirname(scriptPath) }), 'utf-8');

        try {
            const result = await this._spawnJsonService<{ success: boolean; solvers?: string[]; error?: string }>(
                pythonCommand,
                [scriptPath, '--request', requestPath],
                path.dirname(scriptPath)
            );
            return result.success && result.solvers ? result.solvers : [];
        } catch {
            return [];
        } finally {
            try {
                fs.unlinkSync(requestPath);
            } catch {
                // Temporary request file cleanup is best-effort.
            }
        }
    }

    /**
     * Helper to spawn foam_service.py with a JSON request file.
     */
    private async _spawnFoamService<T extends { success: boolean; error?: string }>(
        request: { caseDir?: string; stepPath?: string },
        payload: Record<string, unknown>
    ): Promise<T> {
        const scriptPath = resolvePythonScript({ packageName: 'nuke-cad', scriptName: 'foam_service.py' });
        if (!scriptPath) {
            return { success: false, error: 'OpenFOAM service script not found.' } as unknown as T;
        }

        const pythonCommand = await this.nukeCoreService.getPythonCommand();
        if (!pythonCommand) {
            return {
                success: false,
                error: 'No Python interpreter configured. Set a Python environment in Settings → Nuke Utils.'
            } as unknown as T;
        }

        const workingDirectory = request.caseDir
            ? path.dirname(request.caseDir)
            : request.stepPath
              ? path.dirname(request.stepPath)
              : path.dirname(scriptPath);
        const requestPath = path.join(workingDirectory, `.nuke-cad-foam-request-${Date.now()}.json`);
        fs.writeFileSync(requestPath, JSON.stringify(payload), 'utf-8');

        try {
            return await this._spawnJsonService<T>(pythonCommand, [scriptPath, '--request', requestPath], workingDirectory);
        } finally {
            try {
                fs.unlinkSync(requestPath);
            } catch {
                // Temporary request file cleanup is best-effort.
            }
        }
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
