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

    /**
     * Set the client for receiving log messages.
     * Note: Client logging is currently disabled to prevent errors on disconnect.
     */
    setClient(_client: OpenMCStudioClient): void {
        // Client logging disabled - see log() method
    }

    /**
     * Set Python configuration (called from nuke-visualizer preferences).
     */
    async setPythonConfig(config: { pythonPath?: string; condaEnv?: string }): Promise<void> {
        await this.runnerService.setPythonConfig(config);
    }

    /**
     * Log a message to the console (client logging disabled to prevent disconnect errors).
     */
    protected log(message: string): void {
        console.log(`[OpenMC Studio] ${message}`);
    }

    /**
     * Log an error to the console (client logging disabled to prevent disconnect errors).
     */
    protected error(message: string): void {
        console.error(`[OpenMC Studio] ${message}`);
    }

    // ============================================================================
    // Lifecycle
    // ============================================================================

    onStop(): void {
        console.log('[OpenMC Studio] Shutting down backend service');
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
        
        try {
            const fs = await import('fs');
            const path = await import('path');
            
            const materialsPath = path.join(request.directory, 'materials.xml');
            const geometryPath = path.join(request.directory, 'geometry.xml');
            const settingsPath = path.join(request.directory, 'settings.xml');
            
            const warnings: string[] = [];
            const errors: string[] = [];
            
            // Create default state
            const state = this.createDefaultState();
            
            // Import materials.xml
            if (fs.existsSync(materialsPath)) {
                try {
                    const materialsData = await this.parseMaterialsXML(materialsPath);
                    state.materials = materialsData.materials;
                    warnings.push(...materialsData.warnings);
                    this.log(`Imported ${materialsData.materials.length} materials`);
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    errors.push(`Failed to parse materials.xml: ${msg}`);
                }
            } else {
                warnings.push('materials.xml not found');
            }
            
            // Import geometry.xml
            if (fs.existsSync(geometryPath)) {
                try {
                    const geometryData = await this.parseGeometryXML(geometryPath);
                    state.geometry = geometryData.geometry;
                    warnings.push(...geometryData.warnings);
                    this.log(`Imported ${geometryData.geometry.cells.length} cells, ${geometryData.geometry.surfaces.length} surfaces`);
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    errors.push(`Failed to parse geometry.xml: ${msg}`);
                }
            } else {
                warnings.push('geometry.xml not found');
            }
            
            // Import settings.xml
            if (fs.existsSync(settingsPath)) {
                try {
                    const settingsData = await this.parseSettingsXML(settingsPath);
                    state.settings = settingsData.settings;
                    warnings.push(...settingsData.warnings);
                    this.log(`Imported settings`);
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    errors.push(`Failed to parse settings.xml: ${msg}`);
                }
            } else {
                warnings.push('settings.xml not found');
            }
            
            if (state.materials.length === 0 && state.geometry.cells.length === 0) {
                errors.push('No materials or geometry found in XML files');
                return {
                    success: false,
                    state: undefined,
                    errors,
                    warnings
                };
            }
            
            return {
                success: true,
                state,
                errors: errors.length > 0 ? errors : [],
                warnings: warnings.length > 0 ? warnings : []
            };
            
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.error(`XML import failed: ${msg}`);
            return {
                success: false,
                state: undefined,
                errors: [msg],
                warnings: []
            };
        }
    }
    
    private createDefaultState(): OpenMCState {
        const now = new Date().toISOString();
        return {
            metadata: {
                version: OPENMC_STATE_SCHEMA_VERSION,
                name: 'Imported Project',
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
    }
    
    private async parseMaterialsXML(filePath: string): Promise<{ materials: any[]; warnings: string[] }> {
        const fs = await import('fs');
        const xml2js = await import('xml2js');
        
        const warnings: string[] = [];
        const xml = fs.readFileSync(filePath, 'utf-8');
        const parser = new xml2js.Parser({ explicitArray: false });
        const result = await parser.parseStringPromise(xml);
        
        const materials: any[] = [];
        
        if (!result.materials || !result.materials.material) {
            warnings.push('No materials found in materials.xml');
            return { materials, warnings };
        }
        
        const materialArray = Array.isArray(result.materials.material) 
            ? result.materials.material 
            : [result.materials.material];
        
        for (const mat of materialArray) {
            try {
                const material: any = {
                    id: parseInt(mat.$.id),
                    name: mat.$.name || `Material ${mat.$.id}`,
                    density: 1.0,
                    densityUnit: 'g/cm3',
                    nuclides: [],
                    thermalScattering: []
                };
                
                // Parse density
                if (mat.density) {
                    material.density = parseFloat(mat.density.$.value);
                    material.densityUnit = mat.density.$.units as any;
                }
                
                // Parse nuclides
                if (mat.nuclide) {
                    const nuclides = Array.isArray(mat.nuclide) ? mat.nuclide : [mat.nuclide];
                    for (const nuc of nuclides) {
                        material.nuclides.push({
                            name: nuc.$.name,
                            fraction: parseFloat(nuc.$.ao || nuc.$.wo || '1.0'),
                            fractionType: nuc.$.ao ? 'ao' : 'wo'
                        });
                    }
                }
                
                // Parse S(alpha,beta)
                if (mat.sab) {
                    const sabs = Array.isArray(mat.sab) ? mat.sab : [mat.sab];
                    for (const sab of sabs) {
                        material.thermalScattering.push({
                            name: sab.$.name,
                            fraction: 1.0
                        });
                    }
                }
                
                // Parse temperature
                if (mat.$.temperature) {
                    material.temperature = parseFloat(mat.$.temperature);
                }
                
                materials.push(material);
            } catch (err) {
                warnings.push(`Failed to parse material ${mat.$.id}: ${err}`);
            }
        }
        
        return { materials, warnings };
    }
    
    private async parseGeometryXML(filePath: string): Promise<{ geometry: any; warnings: string[] }> {
        const fs = await import('fs');
        const xml2js = await import('xml2js');
        
        const warnings: string[] = [];
        const xml = fs.readFileSync(filePath, 'utf-8');
        const parser = new xml2js.Parser({ explicitArray: false });
        const result = await parser.parseStringPromise(xml);
        
        const geometry = {
            surfaces: [] as any[],
            cells: [] as any[],
            universes: [{
                id: 0,
                name: 'root',
                cellIds: [] as number[],
                isRoot: true
            }],
            lattices: [] as any[],
            rootUniverseId: 0
        };
        
        if (!result.geometry) {
            warnings.push('No geometry element found in geometry.xml');
            return { geometry, warnings };
        }
        
        // Parse surfaces
        if (result.geometry.surface) {
            const surfaces = Array.isArray(result.geometry.surface) 
                ? result.geometry.surface 
                : [result.geometry.surface];
            
            for (const surf of surfaces) {
                try {
                    const surface: any = {
                        id: parseInt(surf.$.id),
                        type: surf.$.type,
                        coefficients: this.parseCoeffs(surf.$.coeffs),
                        boundary: surf.$.boundary || 'transmission'
                    };
                    if (surf.$.name) surface.name = surf.$.name;
                    geometry.surfaces.push(surface);
                } catch (err) {
                    warnings.push(`Failed to parse surface ${surf.$.id}: ${err}`);
                }
            }
        }
        
        // Parse cells
        if (result.geometry.cell) {
            const cells = Array.isArray(result.geometry.cell) 
                ? result.geometry.cell 
                : [result.geometry.cell];
            
            for (const cell of cells) {
                try {
                    const cellObj: any = {
                        id: parseInt(cell.$.id),
                        fillType: 'void'
                    };
                    if (cell.$.name) cellObj.name = cell.$.name;
                    if (cell.$.temperature) cellObj.temperature = parseFloat(cell.$.temperature);
                    
                    // Parse fill
                    if (cell.material) {
                        if (cell.material === '' || cell.material === 'void') {
                            cellObj.fillType = 'void';
                        } else {
                            cellObj.fillType = 'material';
                            cellObj.fillId = parseInt(cell.material);
                        }
                    } else if (cell.fill) {
                        cellObj.fillType = 'universe';
                        cellObj.fillId = parseInt(cell.fill);
                    }
                    
                    // Parse region
                    if (cell.region) {
                        cellObj.regionString = cell.region;
                    }
                    
                    geometry.cells.push(cellObj);
                    
                    // Add to root universe by default
                    if (!geometry.universes[0].cellIds.includes(cellObj.id)) {
                        geometry.universes[0].cellIds.push(cellObj.id);
                    }
                } catch (err) {
                    warnings.push(`Failed to parse cell ${cell.$.id}: ${err}`);
                }
            }
        }
        
        return { geometry, warnings };
    }
    
    private parseCoeffs(coeffsStr: string): any {
        const values = coeffsStr.split(/\s+/).map(v => parseFloat(v.trim())).filter(v => !isNaN(v));
        // Return as object - the specific coefficients depend on surface type
        // For simplicity, we'll store them as an array
        return values;
    }
    
    private async parseSettingsXML(filePath: string): Promise<{ settings: any; warnings: string[] }> {
        const fs = await import('fs');
        const xml2js = await import('xml2js');
        
        const warnings: string[] = [];
        const xml = fs.readFileSync(filePath, 'utf-8');
        const parser = new xml2js.Parser({ explicitArray: false });
        const result = await parser.parseStringPromise(xml);
        
        const settings: any = {
            run: {
                mode: 'eigenvalue',
                particles: 1000,
                inactive: 10,
                batches: 100
            },
            sources: []
        };
        
        if (!result.settings) {
            warnings.push('No settings element found in settings.xml');
            return { settings, warnings };
        }
        
        const s = result.settings;
        
        // Run mode
        if (s.run_mode) {
            settings.run.mode = s.run_mode;
        }
        
        // Particles and batches
        if (s.particles) {
            settings.run.particles = parseInt(s.particles);
        }
        if (s.batches) {
            settings.run.batches = parseInt(s.batches);
        }
        if (s.inactive) {
            settings.run.inactive = parseInt(s.inactive);
        }
        
        // Source
        if (s.source) {
            // Parse source - simplified
            settings.sources.push({
                spatial: { type: 'point', origin: [0, 0, 0] },
                energy: { type: 'discrete', energies: [1e6] }
            });
        }
        
        return { settings, warnings };
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
