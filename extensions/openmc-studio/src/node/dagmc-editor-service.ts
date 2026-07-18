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
 * DAGMC Editor Backend Service
 *
 * Provides backend operations for the DAGMC Editor using pydagmc.
 *
 * @module openmc-studio/node
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { resolvePythonScript } from 'nuke-core/lib/node/utils/script-resolver';
import { NukeCoreBackendService, NukeCoreBackendServiceInterface } from 'nuke-core/lib/common/nuke-core-protocol';

// Use CommonJS require for Node.js modules
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cp = require('child_process');

export interface DAGMCEditorLoadResult {
    success: boolean;
    data?: {
        filePath: string;
        fileName: string;
        fileSizeMB: number;
        volumeCount: number;
        surfaceCount: number;
        vertices: number;
        materials: Record<string, { volumeCount: number; volumes: number[] }>;
        volumes: Array<{
            id: number;
            material?: string;
            numTriangles: number;
            boundingBox: { min: number[]; max: number[] };
        }>;
        groups: Array<{
            name: string;
            type: string;
            volumeCount: number;
            volumes: number[];
        }>;
        boundingBox: { min: number[]; max: number[] };
    };
    error?: string;
}

export interface DAGMCEditorOperationResult {
    success: boolean;
    message?: string;
    error?: string;
}

export interface DAGMCFacetingParamsResult {
    success: boolean;
    data?: {
        facetingTolerance: number;
        totalTriangles: number;
        volumeCount: number;
        surfaceCount: number;
    };
    error?: string;
}

export interface DAGMCRefacetResult {
    success: boolean;
    data?: {
        outputPath: string;
        message?: string;
    };
    error?: string;
}

/** Child process reference for active re-faceting operation */
export interface RefacetJob {
    process: any;
    startTime: number;
}

/**
 * DAGMC Editor Backend Service
 *
 * Provides backend operations for the DAGMC Editor using pydagmc.
 * Supports loading models, assigning materials, and managing groups.
 *
 * @module openmc-studio/node
 * @see {@link OpenMCStudioBackendService.dagmcLoad}
 */
@injectable()
export class DAGMCEditorService {
    @inject(NukeCoreBackendService)
    protected readonly coreService!: NukeCoreBackendServiceInterface;

    private pythonPath?: string;
    private scriptPath?: string;
    private activeRefacetJob?: RefacetJob;

    /**
     * Initialize the service by finding Python and the dagmc_editor_service.py script.
     * @returns Whether initialization succeeded
     */
    async initialize(): Promise<boolean> {
        try {
            // Find Python with pydagmc (and pymoab which it depends on)
            const result = await this.coreService.detectPythonWithRequirements({
                requiredPackages: [
                    { name: 'pydagmc', required: true },
                    { name: 'pymoab', required: false }
                ],
                searchWorkspaceVenvs: true
            });

            if (!result.success || !result.command) {
                console.error('[DAGMC Editor] Python with pydagmc not found:', result.error);
                return false;
            }

            this.pythonPath = result.command;
            console.log(`[DAGMC Editor] Using Python: ${this.pythonPath}`);

            // Find the DAGMC editor service script
            this.scriptPath = this.findScriptPath();
            if (!this.scriptPath) {
                console.error('[DAGMC Editor] dagmc_editor_service.py script not found');
                return false;
            }

            console.log(`[DAGMC Editor] Using script: ${this.scriptPath}`);
            return true;
        } catch (error) {
            console.error('[DAGMC Editor] Initialization failed:', error);
            return false;
        }
    }

    /**
     * Load a DAGMC file and return model information.
     * @param filePath - Path to DAGMC .h5m file
     * @returns Model data with volumes, materials, and groups
     */
    async loadModel(filePath: string): Promise<DAGMCEditorLoadResult> {
        if (!this.pythonPath || !this.scriptPath) {
            const initialized = await this.initialize();
            if (!initialized) {
                return { success: false, error: 'DAGMC Editor service not initialized' };
            }
        }

        return new Promise((resolve) => {
            const args = [this.scriptPath!, 'load', filePath];

            const childProcess = cp.spawn(this.pythonPath!, args, {
                encoding: 'utf-8',
                stdio: ['ignore', 'pipe', 'pipe']
            });

            let stdout = '';
            let stderr = '';

            childProcess.stdout?.on('data', (data: Buffer) => {
                stdout += data.toString();
            });

            childProcess.stderr?.on('data', (data: Buffer) => {
                stderr += data.toString();
            });

            childProcess.on('close', (code: number) => {
                if (code !== 0) {
                    resolve({
                        success: false,
                        error: `Process exited with code ${code}: ${stderr}`
                    });
                    return;
                }

                try {
                    // Find JSON output (last line that starts with {)
                    const lines = stdout.split('\n');
                    const jsonLine = lines.reverse().find((l) => l.trim().startsWith('{'));

                    if (!jsonLine) {
                        resolve({
                            success: false,
                            error: 'No JSON output found'
                        });
                        return;
                    }

                    const result = JSON.parse(jsonLine);
                    resolve(result as DAGMCEditorLoadResult);
                } catch (error) {
                    resolve({
                        success: false,
                        error: `Failed to parse output: ${error}`
                    });
                }
            });

            childProcess.on('error', (error: Error) => {
                resolve({
                    success: false,
                    error: `Process error: ${error.message}`
                });
            });
        });
    }

    /**
     * Assign a material to a volume.
     * @param filePath - Path to DAGMC .h5m file
     * @param volumeId - Volume ID to modify
     * @param materialName - Material name to assign
     * @returns Operation result
     */
    async assignMaterial(filePath: string, volumeId: number, materialName: string): Promise<DAGMCEditorOperationResult> {
        if (!this.pythonPath || !this.scriptPath) {
            const initialized = await this.initialize();
            if (!initialized) {
                return { success: false, error: 'DAGMC Editor service not initialized' };
            }
        }

        return new Promise((resolve) => {
            const args = [this.scriptPath!, 'assign_material', filePath, String(volumeId), materialName];

            const childProcess = cp.spawn(this.pythonPath!, args, {
                encoding: 'utf-8',
                stdio: ['ignore', 'pipe', 'pipe']
            });

            let stdout = '';

            childProcess.stdout?.on('data', (data: Buffer) => {
                stdout += data.toString();
            });

            childProcess.on('close', (code: number) => {
                if (code !== 0) {
                    resolve({
                        success: false,
                        error: `Process exited with code ${code}`
                    });
                    return;
                }

                try {
                    const lines = stdout.split('\n');
                    const jsonLine = lines.reverse().find((l) => l.trim().startsWith('{'));

                    if (!jsonLine) {
                        resolve({ success: false, error: 'No JSON output found' });
                        return;
                    }

                    const result = JSON.parse(jsonLine);
                    resolve(result as DAGMCEditorOperationResult);
                } catch (error) {
                    resolve({ success: false, error: `Failed to parse output: ${error}` });
                }
            });

            childProcess.on('error', (error: Error) => {
                resolve({ success: false, error: `Process error: ${error.message}` });
            });
        });
    }

    /**
     * Create a new group in the DAGMC file.
     * @param filePath - Path to DAGMC .h5m file
     * @param groupName - Name for the new group
     * @param volumeIds - Optional volume IDs to include
     * @returns Operation result
     */
    async createGroup(filePath: string, groupName: string, volumeIds?: number[]): Promise<DAGMCEditorOperationResult> {
        if (!this.pythonPath || !this.scriptPath) {
            const initialized = await this.initialize();
            if (!initialized) {
                return { success: false, error: 'DAGMC Editor service not initialized' };
            }
        }

        return new Promise((resolve) => {
            const volumeIdsStr = volumeIds?.join(',') || '';
            const args = [this.scriptPath!, 'create_group', filePath, groupName, volumeIdsStr];

            const childProcess = cp.spawn(this.pythonPath!, args, {
                encoding: 'utf-8',
                stdio: ['ignore', 'pipe', 'pipe']
            });

            let stdout = '';

            childProcess.stdout?.on('data', (data: Buffer) => {
                stdout += data.toString();
            });

            childProcess.on('close', (code: number) => {
                if (code !== 0) {
                    resolve({ success: false, error: `Process exited with code ${code}` });
                    return;
                }

                try {
                    const lines = stdout.split('\n');
                    const jsonLine = lines.reverse().find((l) => l.trim().startsWith('{'));

                    if (!jsonLine) {
                        resolve({ success: false, error: 'No JSON output found' });
                        return;
                    }

                    const result = JSON.parse(jsonLine);
                    resolve(result as DAGMCEditorOperationResult);
                } catch (error) {
                    resolve({ success: false, error: `Failed to parse output: ${error}` });
                }
            });

            childProcess.on('error', (error: Error) => {
                resolve({ success: false, error: `Process error: ${error.message}` });
            });
        });
    }

    /**
     * Delete a group from the DAGMC file.
     * @param filePath - Path to DAGMC .h5m file
     * @param groupName - Name of group to delete
     * @returns Operation result
     */
    async deleteGroup(filePath: string, groupName: string): Promise<DAGMCEditorOperationResult> {
        if (!this.pythonPath || !this.scriptPath) {
            const initialized = await this.initialize();
            if (!initialized) {
                return { success: false, error: 'DAGMC Editor service not initialized' };
            }
        }

        return new Promise((resolve) => {
            const args = [this.scriptPath!, 'delete_group', filePath, groupName];

            const childProcess = cp.spawn(this.pythonPath!, args, {
                encoding: 'utf-8',
                stdio: ['ignore', 'pipe', 'pipe']
            });

            let stdout = '';

            childProcess.stdout?.on('data', (data: Buffer) => {
                stdout += data.toString();
            });

            childProcess.on('close', (code: number) => {
                if (code !== 0) {
                    resolve({ success: false, error: `Process exited with code ${code}` });
                    return;
                }

                try {
                    const lines = stdout.split('\n');
                    const jsonLine = lines.reverse().find((l) => l.trim().startsWith('{'));

                    if (!jsonLine) {
                        resolve({ success: false, error: 'No JSON output found' });
                        return;
                    }

                    const result = JSON.parse(jsonLine);
                    resolve(result as DAGMCEditorOperationResult);
                } catch (error) {
                    resolve({ success: false, error: `Failed to parse output: ${error}` });
                }
            });

            childProcess.on('error', (error: Error) => {
                resolve({ success: false, error: `Process error: ${error.message}` });
            });
        });
    }

    /**
     * Get faceting parameters from a DAGMC file.
     * @param filePath - Path to DAGMC .h5m file
     * @returns Faceting tolerance and triangle count
     */
    async getFacetingParams(filePath: string): Promise<DAGMCFacetingParamsResult> {
        if (!this.pythonPath || !this.scriptPath) {
            const initialized = await this.initialize();
            if (!initialized) {
                return { success: false, error: 'DAGMC Editor service not initialized' };
            }
        }

        return new Promise((resolve) => {
            const args = [this.scriptPath!, 'get_faceting_params', filePath];

            const childProcess = cp.spawn(this.pythonPath!, args, {
                encoding: 'utf-8',
                stdio: ['ignore', 'pipe', 'pipe']
            });

            let stdout = '';

            childProcess.stdout?.on('data', (data: Buffer) => {
                stdout += data.toString();
            });

            childProcess.on('close', (code: number) => {
                if (code !== 0) {
                    resolve({ success: false, error: `Process exited with code ${code}` });
                    return;
                }

                try {
                    const lines = stdout.split('\n');
                    const jsonLine = lines.reverse().find((l) => l.trim().startsWith('{'));

                    if (!jsonLine) {
                        resolve({ success: false, error: 'No JSON output found' });
                        return;
                    }

                    const result = JSON.parse(jsonLine);
                    resolve(result as DAGMCFacetingParamsResult);
                } catch (error) {
                    resolve({ success: false, error: `Failed to parse output: ${error}` });
                }
            });

            childProcess.on('error', (error: Error) => {
                resolve({ success: false, error: `Process error: ${error.message}` });
            });
        });
    }

    /**
     * Re-export a DAGMC file from source CAD with a new faceting tolerance.
     * @param filePath - Path to existing DAGMC .h5m file
     * @param sourceCadPath - Path to source CAD file (STEP/STP/etc.)
     * @param tolerance - Desired faceting tolerance
     * @returns Operation result with output file path
     */
    async refacet(filePath: string, sourceCadPath: string, tolerance: number): Promise<DAGMCRefacetResult> {
        if (!this.pythonPath || !this.scriptPath) {
            const initialized = await this.initialize();
            if (!initialized) {
                return { success: false, error: 'DAGMC Editor service not initialized' };
            }
        }

        // Kill any previous refacet job
        this.cancelRefacet();

        return new Promise((resolve) => {
            const args = [this.scriptPath!, 'refacet', filePath, sourceCadPath, String(tolerance)];

            const childProcess = cp.spawn(this.pythonPath!, args, {
                encoding: 'utf-8',
                stdio: ['ignore', 'pipe', 'pipe']
            });

            this.activeRefacetJob = {
                process: childProcess,
                startTime: Date.now()
            };

            let stdout = '';
            let stderr = '';

            childProcess.stdout?.on('data', (data: Buffer) => {
                stdout += data.toString();
            });

            childProcess.stderr?.on('data', (data: Buffer) => {
                stderr += data.toString();
            });

            childProcess.on('close', (code: number) => {
                this.activeRefacetJob = undefined;
                if (code !== 0) {
                    resolve({
                        success: false,
                        error: `Process exited with code ${code}: ${stderr || stdout}`
                    });
                    return;
                }

                try {
                    const lines = stdout.split('\n');
                    const jsonLine = lines.reverse().find((l) => l.trim().startsWith('{'));

                    if (!jsonLine) {
                        resolve({ success: false, error: 'No JSON output found' });
                        return;
                    }

                    const result = JSON.parse(jsonLine);
                    resolve(result as DAGMCRefacetResult);
                } catch (error) {
                    resolve({ success: false, error: `Failed to parse output: ${error}` });
                }
            });

            childProcess.on('error', (error: Error) => {
                this.activeRefacetJob = undefined;
                resolve({ success: false, error: `Process error: ${error.message}` });
            });
        });
    }

    /**
     * Cancel any active re-faceting operation by killing the child process.
     */
    cancelRefacet(): void {
        if (this.activeRefacetJob) {
            try {
                this.activeRefacetJob.process.kill('SIGTERM');
            } catch {
                // ignore kill errors
            }
            this.activeRefacetJob = undefined;
        }
    }

    /**
     * Find the DAGMC editor service script.
     */
    private findScriptPath(): string | undefined {
        return resolvePythonScript({ packageName: 'openmc-studio', scriptName: 'dagmc_editor_service.py' });
    }
}
