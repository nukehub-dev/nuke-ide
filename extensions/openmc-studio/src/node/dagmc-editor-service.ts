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

/**
 * DAGMC Editor Backend Service
 * 
 * Provides backend operations for the DAGMC Editor using pydagmc.
 * 
 * @module openmc-studio/node
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { NukeCoreBackendService, NukeCoreBackendServiceInterface } from 'nuke-core/lib/common/nuke-core-protocol';
import * as path from 'path';

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

@injectable()
export class DAGMCEditorService {

    @inject(NukeCoreBackendService)
    protected readonly coreService!: NukeCoreBackendServiceInterface;

    private pythonPath?: string;
    private scriptPath?: string;

    /**
     * Initialize the service by finding Python and the script.
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
                    const jsonLine = lines.reverse().find(l => l.trim().startsWith('{'));
                    
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
                    const jsonLine = lines.reverse().find(l => l.trim().startsWith('{'));
                    
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
     * Create a new group.
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
                    const jsonLine = lines.reverse().find(l => l.trim().startsWith('{'));
                    
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
     * Delete a group.
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
                    const jsonLine = lines.reverse().find(l => l.trim().startsWith('{'));
                    
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
     * Get the extension root path.
     */
    private getExtensionPath(): string {
        try {
            return path.dirname(require.resolve('openmc-studio/package.json'));
        } catch (e) {
            // Fallback to __dirname if require.resolve fails
            return path.resolve(__dirname, '../..');
        }
    }

    /**
     * Find the DAGMC editor service script.
     */
    private findScriptPath(): string | undefined {
        const fs = require('fs');
        
        const extensionPath = this.getExtensionPath();
        const scriptPath = path.resolve(extensionPath, 'python/dagmc_editor_service.py');
        
        console.log(`[DAGMC Editor] Checking extension path: ${scriptPath}`);
        if (fs.existsSync(scriptPath)) {
            return scriptPath;
        }

        return undefined;
    }
}
