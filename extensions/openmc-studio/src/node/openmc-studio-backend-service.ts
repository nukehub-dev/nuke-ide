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
 * OpenMC Studio Backend Service Implementation
 * 
 * Main backend service for the OpenMC Studio extension.
 * Implements the JSON-RPC interface for frontend-backend communication.
 * 
 * @module openmc-studio/node
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node';

import {
    OpenMCStudioBackendService,
    OpenMCStudioClient,
    XMLGenerationRequest,
    XMLGenerationResult,
    XMLImportRequest,
    XMLImportResult,
    XMLValidationResult,
    SimulationRunRequest,
    SimulationRunResult,
    ValidationRequest,
    ValidationResult,
    OverlapCheckRequest,
    OverlapCheckResult,
    ProjectCreateRequest,
    ProjectCreateResult,
    ProjectSaveRequest,
    ProjectLoadResult,
    TemplatesResponse,
    ApplyTemplateRequest,
    OPENMC_STATE_SCHEMA_VERSION
} from '../common/openmc-studio-protocol';

import { OpenMCState, OpenMCProjectFile } from '../common/openmc-state-schema';
import { OpenMCRunnerService } from './openmc-runner-service';
import { XMLGenerationService } from './xml-generation-service';

@injectable()
export class OpenMCStudioBackendServiceImpl 
    implements OpenMCStudioBackendService, BackendApplicationContribution {
    
    @inject(OpenMCRunnerService)
    protected readonly runnerService: OpenMCRunnerService;
    
    @inject(XMLGenerationService)
    protected readonly xmlService: XMLGenerationService;

    private client?: OpenMCStudioClient;

    /**
     * Set the client for receiving log messages.
     */
    setClient(client: OpenMCStudioClient): void {
        this.client = client;
        this.runnerService.setClient(client);
        this.xmlService.setClient(client);
    }

    /**
     * Set Python configuration (called from nuke-visualizer preferences).
     */
    async setPythonConfig(config: { pythonPath?: string; condaEnv?: string }): Promise<void> {
        await this.runnerService.setPythonConfig(config);
    }

    /**
     * Log a message to the client if available.
     */
    protected log(message: string): void {
        console.log(`[OpenMC Studio] ${message}`);
        this.client?.log(message);
    }

    /**
     * Log an error to the client if available.
     */
    protected error(message: string): void {
        console.error(`[OpenMC Studio] ${message}`);
        this.client?.error(message);
    }

    // ============================================================================
    // Lifecycle
    // ============================================================================

    onStop(): void {
        this.log('Shutting down backend service');
        // Cleanup any running simulations
        this.runnerService.cleanup();
    }

    // ============================================================================
    // XML Generation
    // ============================================================================

    async generateXML(request: XMLGenerationRequest): Promise<XMLGenerationResult> {
        this.log(`Generating XML files in ${request.outputDirectory}`);
        return this.xmlService.generateXML(request);
    }

    async importXML(request: XMLImportRequest): Promise<XMLImportResult> {
        this.log(`Importing XML from ${request.directory}`);
        // TODO: Implement XML import in Phase 1
        return {
            success: false,
            errors: ['XML import not yet implemented'],
            warnings: []
        };
    }

    async validateXML(directory: string): Promise<XMLValidationResult> {
        this.log(`Validating XML in ${directory}`);
        // TODO: Implement XML validation in Phase 1
        return {
            valid: true,
            errors: [],
            warnings: []
        };
    }

    // ============================================================================
    // Simulation Runner
    // ============================================================================

    async runSimulation(request: SimulationRunRequest): Promise<SimulationRunResult> {
        this.log(`Running simulation in ${request.workingDirectory}`);
        return this.runnerService.runSimulation(request);
    }

    async cancelSimulation(processId: string): Promise<boolean> {
        this.log(`Cancelling simulation ${processId}`);
        return this.runnerService.cancelSimulation(processId);
    }

    async checkOpenMC(): Promise<{ available: boolean; version?: string; path?: string; error?: string }> {
        return this.runnerService.checkOpenMC();
    }

    async checkMPI(): Promise<{ available: boolean; version?: string; processes?: number; error?: string }> {
        return this.runnerService.checkMPI();
    }

    // ============================================================================
    // Validation
    // ============================================================================

    async validateState(request: ValidationRequest): Promise<ValidationResult> {
        this.log('Validating simulation state');
        
        const issues: ValidationResult['issues'] = [];
        
        // Basic validation
        if (!request.state.materials || request.state.materials.length === 0) {
            issues.push({
                severity: 'error',
                category: 'materials',
                message: 'No materials defined',
                suggestion: 'Add at least one material to the model'
            });
        }
        
        if (!request.state.geometry.cells || request.state.geometry.cells.length === 0) {
            issues.push({
                severity: 'error',
                category: 'geometry',
                message: 'No cells defined',
                suggestion: 'Add at least one cell to the geometry'
            });
        }
        
        // Check for source in fixed source mode
        if (request.state.settings.run.mode === 'fixed source') {
            if (!request.state.settings.sources || request.state.settings.sources.length === 0) {
                issues.push({
                    severity: 'error',
                    category: 'settings',
                    message: 'Fixed source mode requires at least one source definition',
                    suggestion: 'Add an external source in the settings'
                });
            }
        }
        
        return {
            valid: issues.filter(i => i.severity === 'error').length === 0,
            issues,
            summary: {
                errors: issues.filter(i => i.severity === 'error').length,
                warnings: issues.filter(i => i.severity === 'warning').length,
                info: issues.filter(i => i.severity === 'info').length
            }
        };
    }

    async checkOverlaps(request: OverlapCheckRequest): Promise<OverlapCheckResult> {
        this.log('Checking for geometry overlaps');
        // TODO: Implement overlap checking in Phase 2
        return {
            complete: true,
            overlaps: [],
            samplesChecked: 0,
            elapsedTime: 0
        };
    }

    async validateRegion(region: string, surfaces: any[]): Promise<{ valid: boolean; error?: string }> {
        this.log(`Validating region expression: ${region}`);
        // TODO: Implement region validation in Phase 2
        return { valid: true };
    }

    // ============================================================================
    // Project Management
    // ============================================================================

    async createProject(request: ProjectCreateRequest): Promise<ProjectCreateResult> {
        this.log(`Creating new project: ${request.name}`);
        
        try {
            const fs = await import('fs');
            const path = await import('path');
            
            // Create directory if it doesn't exist
            if (!fs.existsSync(request.directory)) {
                fs.mkdirSync(request.directory, { recursive: true });
            }
            
            // Create initial state
            const now = new Date().toISOString();
            const initialState: OpenMCState = {
                metadata: {
                    version: OPENMC_STATE_SCHEMA_VERSION,
                    name: request.name,
                    description: request.description || '',
                    author: request.author,
                    created: now,
                    modified: now
                },
                geometry: {
                    surfaces: [],
                    cells: [],
                    universes: [{
                        id: 0,
                        name: 'root',
                        cellIds: [],
                        isRoot: true
                    }],
                    lattices: [],
                    rootUniverseId: 0
                },
                materials: [],
                settings: {
                    run: {
                        mode: 'eigenvalue',
                        particles: 1000,
                        inactive: 10,
                        batches: 100
                    },
                    sources: []
                },
                tallies: [],
                meshes: []
            };
            
            // Create project file
            const projectFile: OpenMCProjectFile = {
                version: OPENMC_STATE_SCHEMA_VERSION,
                state: initialState
            };
            
            const projectPath = path.join(request.directory, `${request.name}.nuke-openmc`);
            fs.writeFileSync(projectPath, JSON.stringify(projectFile, null, 2));
            
            return {
                success: true,
                projectFile: projectPath,
                initialState
            };
            
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            return {
                success: false,
                error: msg
            };
        }
    }

    async loadProject(projectPath: string): Promise<ProjectLoadResult> {
        this.log(`Loading project: ${projectPath}`);
        
        try {
            const fs = await import('fs');
            const content = fs.readFileSync(projectPath, 'utf-8');
            const project: OpenMCProjectFile = JSON.parse(content);
            
            return {
                success: true,
                project
            };
            
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            return {
                success: false,
                error: msg
            };
        }
    }

    async saveProject(request: ProjectSaveRequest): Promise<{ success: boolean; error?: string }> {
        this.log(`Saving project: ${request.projectPath}`);
        
        try {
            const fs = await import('fs');
            
            const projectFile: OpenMCProjectFile = {
                version: OPENMC_STATE_SCHEMA_VERSION,
                state: request.state
            };
            
            fs.writeFileSync(request.projectPath, JSON.stringify(projectFile, null, 2));
            
            // Also generate XML if requested
            if (request.generateXml) {
                const path = await import('path');
                const outputDir = path.dirname(request.projectPath);
                await this.xmlService.generateXML({
                    state: request.state,
                    outputDirectory: outputDir,
                    files: {
                        geometry: true,
                        materials: true,
                        settings: true,
                        tallies: true,
                        plots: false
                    },
                    overwrite: true
                });
            }
            
            return { success: true };
            
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            return {
                success: false,
                error: msg
            };
        }
    }

    async getTemplates(): Promise<TemplatesResponse> {
        this.log('Getting available templates');
        
        return {
            templates: [
                {
                    id: 'pin-cell',
                    name: 'Pin Cell',
                    description: 'Basic fuel pin cell with cladding and moderator',
                    icon: 'fa fa-circle',
                    defaultState: {}
                },
                {
                    id: 'fuel-assembly',
                    name: 'Fuel Assembly',
                    description: '17x17 PWR fuel assembly with guide tubes',
                    icon: 'fa fa-th',
                    defaultState: {}
                },
                {
                    id: 'full-core',
                    name: 'Full Core',
                    description: 'Full reactor core with multiple assemblies',
                    icon: 'fa fa-dot-circle-o',
                    defaultState: {}
                },
                {
                    id: 'shielding',
                    name: 'Shielding',
                    description: 'Shielding and criticality safety model',
                    icon: 'fa fa-shield',
                    defaultState: {}
                },
                {
                    id: 'blank',
                    name: 'Blank Project',
                    description: 'Start from scratch',
                    icon: 'fa fa-file-o',
                    defaultState: {}
                }
            ]
        };
    }

    async applyTemplate(request: ApplyTemplateRequest): Promise<{ success: boolean; state?: OpenMCState; error?: string }> {
        this.log(`Applying template: ${request.templateId}`);
        // TODO: Implement template application with specific configurations
        return {
            success: false,
            error: 'Template application not yet implemented'
        };
    }

    // ============================================================================
    // Utility Methods
    // ============================================================================

    async getCrossSectionsPath(): Promise<{ path?: string; found: boolean }> {
        const crossSectionsEnv = process.env.OPENMC_CROSS_SECTIONS;
        
        if (crossSectionsEnv) {
            const fs = await import('fs');
            const exists = fs.existsSync(crossSectionsEnv);
            return {
                path: crossSectionsEnv,
                found: exists
            };
        }
        
        return { found: false };
    }

    async suggestMaterialId(state: OpenMCState): Promise<number> {
        const ids = state.materials.map(m => m.id);
        return ids.length > 0 ? Math.max(...ids) + 1 : 1;
    }

    async suggestCellId(state: OpenMCState): Promise<number> {
        const ids = state.geometry.cells.map(c => c.id);
        return ids.length > 0 ? Math.max(...ids) + 1 : 1;
    }

    async suggestSurfaceId(state: OpenMCState): Promise<number> {
        const ids = state.geometry.surfaces.map(s => s.id);
        return ids.length > 0 ? Math.max(...ids) + 1 : 1;
    }

    async suggestTallyId(state: OpenMCState): Promise<number> {
        const ids = state.tallies.map(t => t.id);
        return ids.length > 0 ? Math.max(...ids) + 1 : 1;
    }

    async suggestMeshId(state: OpenMCState): Promise<number> {
        const ids = state.meshes.map(m => m.id);
        return ids.length > 0 ? Math.max(...ids) + 1 : 1;
    }
}
