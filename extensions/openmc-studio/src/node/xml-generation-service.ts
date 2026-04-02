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
 * XML Generation Service
 * 
 * Backend service for generating OpenMC XML files from the simulation state.
 * 
 * @module openmc-studio/node
 */

import { injectable } from '@theia/core/shared/inversify';

import {
    XMLGenerationRequest,
    XMLGenerationResult
} from '../common/openmc-studio-protocol';

import {
    OpenMCState,
    OpenMCSurface,
    OpenMCCell,
    OpenMCMaterial,
    OpenMCTally,
    OpenMCMesh,
    OpenMCRegularMesh,
    OpenMCCylindricalMesh,
    OpenMCSphericalMesh,
    OpenMCLattice,
    OpenMCEigenvalueSettings,
    OpenMCFixedSourceSettings
} from '../common/openmc-state-schema';

import { OpenMCStudioClient } from '../common/openmc-studio-protocol';

@injectable()
export class XMLGenerationService {

    /**
     * Set the client for log messages.
     * Note: Currently unused - client notifications disabled to prevent disconnect errors.
     */
    setClient(_client: OpenMCStudioClient): void {
        // Client logging disabled - see log() method
    }

    /**
     * Log a message to the console (client logging disabled to prevent disconnect errors).
     */
    protected log(message: string): void {
        console.log(`[XML Generation] ${message}`);
    }

    // ============================================================================
    // XML Generation
    // ============================================================================

    async generateXML(request: XMLGenerationRequest): Promise<XMLGenerationResult> {
        const generatedFiles: string[] = [];
        const warnings: string[] = [];
        
        try {
            const fs = await import('fs');
            const path = await import('path');
            
            // Create output directory if it doesn't exist
            if (!fs.existsSync(request.outputDirectory)) {
                fs.mkdirSync(request.outputDirectory, { recursive: true });
            }
            
            // Generate materials.xml
            if (request.files.materials) {
                const materialsPath = path.join(request.outputDirectory, 'materials.xml');
                const materialsXml = this.generateMaterialsXML(request.state);
                fs.writeFileSync(materialsPath, materialsXml);
                generatedFiles.push(materialsPath);
                this.log(`Generated materials.xml`);
            }
            
            // Generate geometry.xml (empty for DAGMC - geometry is in the .h5m file)
            if (request.files.geometry) {
                const geometryPath = path.join(request.outputDirectory, 'geometry.xml');
                if (request.state.settings.dagmcFile) {
                    // DAGMC mode: generate geometry.xml with dagmc_universe reference
                    const dagmcGeometryXml = this.generateDAGMCGeometryXML();
                    fs.writeFileSync(geometryPath, dagmcGeometryXml);
                    generatedFiles.push(geometryPath);
                    this.log(`Generated geometry.xml with DAGMC reference`);
                } else {
                    // CSG mode: generate full geometry.xml
                    const geometryXml = this.generateGeometryXML(request.state);
                    fs.writeFileSync(geometryPath, geometryXml);
                    generatedFiles.push(geometryPath);
                    this.log(`Generated geometry.xml`);
                }
            }
            
            // Generate settings.xml
            if (request.files.settings) {
                const settingsPath = path.join(request.outputDirectory, 'settings.xml');
                const settingsXml = this.generateSettingsXML(request.state);
                fs.writeFileSync(settingsPath, settingsXml);
                generatedFiles.push(settingsPath);
                this.log(`Generated settings.xml`);
            }
            
            // Copy DAGMC file to output directory as geometry.h5m (required by OpenMC)
            if (request.state.settings.dagmcFile) {
                const dagmcSource = request.state.settings.dagmcFile;
                const dagmcDest = path.join(request.outputDirectory, 'geometry.h5m');
                try {
                    fs.copyFileSync(dagmcSource, dagmcDest);
                    generatedFiles.push(dagmcDest);
                    this.log(`Copied DAGMC file to geometry.h5m`);
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    this.log(`Warning: Failed to copy DAGMC file: ${msg}`);
                }
            }
            
            // Generate tallies.xml
            if (request.files.tallies && request.state.tallies.length > 0) {
                const talliesPath = path.join(request.outputDirectory, 'tallies.xml');
                const talliesXml = this.generateTalliesXML(request.state);
                fs.writeFileSync(talliesPath, talliesXml);
                generatedFiles.push(talliesPath);
                this.log(`Generated tallies.xml`);
            }
            
            // Generate plots.xml
            if (request.files.plots && request.state.plots && request.state.plots.length > 0) {
                const plotsPath = path.join(request.outputDirectory, 'plots.xml');
                const plotsXml = this.generatePlotsXML(request.state);
                fs.writeFileSync(plotsPath, plotsXml);
                generatedFiles.push(plotsPath);
                this.log(`Generated plots.xml`);
            }
            
            return {
                success: true,
                generatedFiles,
                warnings: warnings.length > 0 ? warnings : undefined
            };
            
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.log(`Error generating XML: ${msg}`);
            
            return {
                success: false,
                generatedFiles,
                error: msg,
                warnings: warnings.length > 0 ? warnings : undefined
            };
        }
    }

    // ============================================================================
    // Materials XML
    // ============================================================================

    private generateMaterialsXML(state: OpenMCState): string {
        const lines: string[] = [
            '<?xml version="1.0"?>',
            '<materials>',
            ''
        ];
        
        // Debug logging for DAGMC
        if (state.settings.dagmcFile) {
            this.log(`DAGMC mode detected. dagmcFile: ${state.settings.dagmcFile}`);
            this.log(`dagmcInfo present: ${!!state.settings.dagmcInfo}`);
            if (state.settings.dagmcInfo?.materials) {
                const matNames = Object.keys(state.settings.dagmcInfo.materials);
                this.log(`DAGMC materials found: ${matNames.join(', ')}`);
            } else {
                this.log('No DAGMC materials found in dagmcInfo');
            }
        }
        
        // Add user-defined materials
        for (const material of state.materials) {
            lines.push(this.generateMaterialElement(material));
        }
        
        // For DAGMC mode: check for missing materials (user must create them)
        if (state.settings.dagmcInfo?.materials) {
            const dagmcMaterials = state.settings.dagmcInfo.materials;
            const existingMaterialNames = new Set(state.materials.map(m => m.name.toLowerCase()));
            
            const missingMaterials: string[] = [];
            
            for (const dagmcMaterialName of Object.keys(dagmcMaterials)) {
                if (!existingMaterialNames.has(dagmcMaterialName.toLowerCase())) {
                    missingMaterials.push(dagmcMaterialName);
                }
            }
            
            if (missingMaterials.length > 0) {
                this.log(`WARNING: DAGMC materials not defined: ${missingMaterials.join(', ')}. ` +
                    `Create these materials in the Materials tab with appropriate nuclides.`);
            }
        }
        
        lines.push('</materials>');
        
        return lines.join('\n');
    }

    private generateMaterialElement(material: OpenMCMaterial): string {
        const lines: string[] = [];
        
        const depletableAttr = material.isDepletable ? ' depletable="true"' : '';
        const volumeAttr = material.volume ? ` volume="${material.volume}"` : '';
        const tempAttr = material.temperature ? ` temperature="${material.temperature}"` : '';
        
        lines.push(`  <material id="${material.id}" name="${this.escapeXml(material.name)}"${depletableAttr}${volumeAttr}${tempAttr}>`);
        lines.push(`    <density units="${material.densityUnit}" value="${material.density}"/>`);
        
        // Add nuclides
        for (const nuclide of material.nuclides) {
            lines.push(`    <nuclide ao="${nuclide.fraction}" name="${nuclide.name}"/>`);
        }
        
        // Add S(alpha,beta) if present
        for (const sab of material.thermalScattering) {
            lines.push(`    <sab name="${sab.name}"/>`);
        }
        
        lines.push('  </material>');
        lines.push('');
        
        return lines.join('\n');
    }

    // ============================================================================
    // Geometry XML
    // ============================================================================

    private generateGeometryXML(state: OpenMCState): string {
        const lines: string[] = [
            '<?xml version="1.0"?>',
            '<geometry>',
            ''
        ];
        
        // Add surfaces
        for (const surface of state.geometry.surfaces) {
            lines.push(this.generateSurfaceElement(surface));
        }
        
        // Add cells with their universe assignments
        for (const cell of state.geometry.cells) {
            // Find which universe this cell belongs to
            const universe = state.geometry.universes.find(u => u.cellIds.includes(cell.id));
            lines.push(this.generateCellElement(cell, universe?.id ?? 0));
        }
        
        // Add lattices
        for (const lattice of state.geometry.lattices) {
            lines.push(this.generateLatticeElement(lattice));
        }
        
        lines.push('</geometry>');
        
        return lines.join('\n');
    }

    /**
     * Generate a geometry.xml for DAGMC mode.
     * Contains a dagmc_universe element referencing the DAGMC file.
     */
    private generateDAGMCGeometryXML(): string {
        return `<?xml version="1.0"?>
<geometry>
  <dagmc_universe filename="geometry.h5m" id="1" />
</geometry>`;
    }

    private generateSurfaceElement(surface: OpenMCSurface): string {
        // Always use 'vacuum' for boundaries to allow particles to escape
        // 'transmission' causes particles to get lost when crossing surfaces
        // This is a workaround until proper boundary detection is implemented
        const boundary = surface.boundary === 'reflective' ? 'reflective' : 'vacuum';
        const boundaryAttr = ` boundary="${boundary}"`;
        const nameAttr = surface.name ? ` name="${this.escapeXml(surface.name)}"` : '';
        
        // Map internal surface type to OpenMC-compatible type
        const openmcType = this.mapSurfaceTypeToOpenMC(surface);
        
        return `  <surface coeffs="${this.coeffsToString(surface)}" id="${surface.id}" type="${openmcType}"${boundaryAttr}${nameAttr}/>`;
    }

    /**
     * Map internal surface type to OpenMC-compatible surface type.
     * OpenMC doesn't support generic 'cylinder' type - only x-cylinder, y-cylinder, z-cylinder.
     */
    private mapSurfaceTypeToOpenMC(surface: OpenMCSurface): string {
        const type = surface.type;
        const coeffs = surface.coefficients as any;
        
        // Handle generic cylinder type - determine axis from direction vector
        if (type === 'cylinder') {
            // Generic cylinder has: x0, y0, z0, r, vx, vy, vz (center and direction vector)
            const vx = coeffs.vx ?? 0;
            const vy = coeffs.vy ?? 0;
            const vz = coeffs.vz ?? 1; // default to z-axis
            
            // Determine principal axis from direction vector
            const absVx = Math.abs(vx);
            const absVy = Math.abs(vy);
            const absVz = Math.abs(vz);
            
            if (absVx >= absVy && absVx >= absVz) {
                return 'x-cylinder';
            } else if (absVy >= absVx && absVy >= absVz) {
                return 'y-cylinder';
            } else {
                return 'z-cylinder';
            }
        }
        
        // All other types map directly
        return type;
    }

    private coeffsToString(surface: OpenMCSurface): string {
        const type = surface.type;
        const coeffs = surface.coefficients as any;
        
        // Handle generic cylinder - need to output only relevant coefficients for axis-aligned
        if (type === 'cylinder') {
            const x0 = coeffs.x0 ?? 0;
            const y0 = coeffs.y0 ?? 0;
            const z0 = coeffs.z0 ?? 0;
            const r = coeffs.r ?? 1;
            const vx = coeffs.vx ?? 0;
            const vy = coeffs.vy ?? 0;
            const vz = coeffs.vz ?? 1;
            
            // Determine which axis the cylinder is aligned with
            const absVx = Math.abs(vx);
            const absVy = Math.abs(vy);
            const absVz = Math.abs(vz);
            
            if (absVx >= absVy && absVx >= absVz) {
                // x-cylinder: y0, z0, r
                return `${y0} ${z0} ${r}`;
            } else if (absVy >= absVx && absVy >= absVz) {
                // y-cylinder: x0, z0, r
                return `${x0} ${z0} ${r}`;
            } else {
                // z-cylinder: x0, y0, r
                return `${x0} ${y0} ${r}`;
            }
        }
        
        // All other types - format coefficients directly
        const values = Object.values(coeffs);
        return values.join(' ');
    }

    private generateCellElement(cell: OpenMCCell, universeId: number = 0): string {
        const nameAttr = cell.name ? ` name="${this.escapeXml(cell.name)}"` : '';
        const tempAttr = cell.temperature ? ` temperature="${cell.temperature}"` : '';
        const universeAttr = universeId !== 0 ? ` universe="${universeId}"` : '';
        
        // Build attributes for self-closing tag (compatible with OpenMC geometry viewer)
        let fillAttr = '';
        if (cell.fillType === 'material' && cell.fillId !== undefined) {
            fillAttr = ` material="${cell.fillId}"`;
        } else if (cell.fillType === 'universe' && cell.fillId !== undefined) {
            fillAttr = ` fill="${cell.fillId}"`;
        } else if (cell.fillType === 'lattice' && cell.fillId !== undefined) {
            fillAttr = ` fill="${cell.fillId}"`;
        }
        // Note: void cells don't need a material attribute (empty cell)
        
        // Build region attribute
        let regionAttr = '';
        let regionValue = '';
        if (cell.regionString) {
            regionValue = cell.regionString;
        } else if (cell.region) {
            regionValue = this.regionNodeToString(cell.region);
        }
        if (regionValue) {
            regionAttr = ` region="${this.escapeXml(regionValue)}"`;
        }
        
        // Use self-closing tag format for cleaner XML
        return `  <cell id="${cell.id}"${nameAttr}${fillAttr}${regionAttr}${tempAttr}${universeAttr}/>\n`;
    }

    private regionNodeToString(node: any): string {
        if (!node) return '';
        
        if (node.type === 'surface') {
            return node.surfaceId > 0 ? `+${node.surfaceId}` : `${node.surfaceId}`;
        }
        
        if (node.type === 'operator') {
            const children = node.children?.map((c: any) => this.regionNodeToString(c)).filter(Boolean) || [];
            
            if (node.operator === 'intersection') {
                return children.join(' ');
            } else if (node.operator === 'union') {
                return children.join(' | ');
            } else if (node.operator === 'complement') {
                return `~${children[0] || ''}`;
            }
        }
        
        return '';
    }

    private generateLatticeElement(lattice: OpenMCLattice): string {
        const lines: string[] = [];
        
        // This is a simplified implementation
        // Full implementation would handle different lattice types
        lines.push(`  <!-- Lattice ${lattice.id} generation not yet fully implemented -->`);
        
        return lines.join('\n');
    }

    // ============================================================================
    // Settings XML
    // ============================================================================

    private generateSettingsXML(state: OpenMCState): string {
        const lines: string[] = [
            '<?xml version="1.0"?>',
            '<settings>',
            ''
        ];
        
        const settings = state.settings;
        const run = settings.run;
        
        // Run mode
        lines.push(`  <run_mode>${run.mode}</run_mode>`);
        
        // Handle different run modes
        if (run.mode === 'eigenvalue') {
            const eigenRun = run as OpenMCEigenvalueSettings;
            lines.push(`  <particles>${eigenRun.particles}</particles>`);
            lines.push(`  <batches>${eigenRun.batches}</batches>`);
            lines.push(`  <inactive>${eigenRun.inactive}</inactive>`);
        } else if (run.mode === 'fixed source') {
            const fixedRun = run as OpenMCFixedSourceSettings;
            lines.push(`  <particles>${fixedRun.particles}</particles>`);
            lines.push(`  <batches>${fixedRun.batches}</batches>`);
        }
        
        // Sources
        if (settings.sources && settings.sources.length > 0) {
            let validSources = 0;
            for (const source of settings.sources) {
                const sourceXml = this.generateSourceElement(source);
                if (sourceXml) {
                    lines.push(sourceXml);
                    validSources++;
                }
            }
            // If no valid sources were generated, add a default source
            if (validSources === 0 && run.mode !== 'volume') {
                this.log('Warning: No valid sources found, adding default point source at origin');
                lines.push('  <source>');
                lines.push('    <space type="point">');
                lines.push('      <parameters>0 0 0</parameters>');
                lines.push('    </space>');
                lines.push('  </source>');
            }
        } else if (run.mode !== 'volume') {
            // No sources defined - add a default for non-volume modes
            this.log('Warning: No sources defined, adding default point source at origin');
            lines.push('  <source>');
            lines.push('    <space type="point">');
            lines.push('      <parameters>0 0 0</parameters>');
            lines.push('    </space>');
            lines.push('  </source>');
        }
        
        // Seed
        if (settings.seed) {
            lines.push(`  <seed>${settings.seed}</seed>`);
        }
        
        // Source rejection fraction (must be > 0)
        if (settings.sourceRejectionFraction !== undefined && settings.sourceRejectionFraction > 0) {
            lines.push(`  <source_rejection_fraction>${settings.sourceRejectionFraction}</source_rejection_fraction>`);
        }
        
        // Temperature settings
        if (settings.temperature) {
            lines.push('  <temperature_default>');
            if (settings.temperature.default) {
                lines.push(`    <default>${settings.temperature.default}</default>`);
            }
            if (settings.temperature.method) {
                lines.push(`    <method>${settings.temperature.method}</method>`);
            }
            lines.push('  </temperature_default>');
        }
        
        // Cutoff
        if (settings.cutoff) {
            lines.push('  <cutoff>');
            if (settings.cutoff.weight) {
                lines.push(`    <weight>${settings.cutoff.weight}</weight>`);
            }
            if (settings.cutoff.weightAvg) {
                lines.push(`    <weight_avg>${settings.cutoff.weightAvg}</weight_avg>`);
            }
            lines.push('  </cutoff>');
        }
        
        // Photon transport
        if (settings.photonTransport) {
            lines.push(`  <photon_transport>true</photon_transport>`);
        }
        
        // DAGMC geometry file
        if (settings.dagmcFile) {
            lines.push('');
            lines.push('  <!-- DAGMC Geometry -->');
            lines.push(`  <dagmc>true</dagmc>`);
        }

        // Depletion settings (for reference - actual depletion requires Python API)
        if (state.depletion?.enabled) {
            lines.push('');
            lines.push('  <!-- Depletion Settings (requires Python API to run) -->');
            lines.push('  <depletion>');
            if (state.depletion.chainFile) {
                lines.push(`    <chain_file>${state.depletion.chainFile}</chain_file>`);
            }
            if (state.depletion.timeSteps && state.depletion.timeSteps.length > 0) {
                const timeSteps = state.depletion.timeSteps.map(ts => {
                    // If it's a string like "1 d", convert to seconds
                    if (typeof ts === 'string') {
                        const match = ts.match(/^([\d.]+)\s*([smhdwy])$/i);
                        if (match) {
                            const value = parseFloat(match[1]);
                            const unit = match[2].toLowerCase();
                            const multipliers: { [key: string]: number } = {
                                's': 1,
                                'm': 60,
                                'h': 3600,
                                'd': 86400,
                                'w': 604800,
                                'y': 31536000
                            };
                            return Math.round(value * (multipliers[unit] || 1));
                        }
                    }
                    return Number(ts);
                });
                lines.push(`    <time_steps>${timeSteps.join(' ')}</time_steps>`);
            }
            // Calculate and write power
            let totalPower = state.depletion.power;
            
            // If powerDensity is specified, calculate total power from depletable materials
            if (totalPower === undefined && state.depletion.powerDensity !== undefined && state.materials) {
                let totalMassG = 0;
                for (const mat of state.materials) {
                    if (mat.isDepletable && mat.volume) {
                        // Mass = density (g/cm³) × volume (cm³)
                        totalMassG += mat.density * mat.volume;
                    }
                }
                if (totalMassG > 0) {
                    totalPower = state.depletion.powerDensity * totalMassG;
                }
            }
            
            if (totalPower !== undefined && totalPower > 0) {
                lines.push(`    <power>${totalPower.toFixed(6)}</power>`);
            }
            
            // Also store power density if specified (for reference)
            if (state.depletion.powerDensity !== undefined) {
                lines.push(`    <power_density>${state.depletion.powerDensity}</power_density>`);
            }
            
            lines.push('  </depletion>');
        }

        // Variance Reduction settings
        if (state.varianceReduction) {
            const vr = state.varianceReduction;
            
            // Survival biasing
            if (vr.survivalBiasing) {
                lines.push('');
                lines.push('  <!-- Variance Reduction -->');
                lines.push('  <survival_biasing>true</survival_biasing>');
            }
            
            // Cutoff settings
            if (vr.cutoff && (vr.cutoff.weight !== undefined || vr.cutoff.weightAvg !== undefined)) {
                lines.push('  <cutoff>');
                if (vr.cutoff.weight !== undefined) {
                    lines.push(`    <weight>${vr.cutoff.weight}</weight>`);
                }
                if (vr.cutoff.weightAvg !== undefined) {
                    lines.push(`    <weight_avg>${vr.cutoff.weightAvg}</weight_avg>`);
                }
                lines.push('  </cutoff>');
            }
            
            // Weight window generator
            if (vr.weightWindowGenerator) {
                lines.push('  <weight_window_generator>');
                if (vr.weightWindowGenerator.iterations !== undefined) {
                    lines.push(`    <iterations>${vr.weightWindowGenerator.iterations}</iterations>`);
                }
                if (vr.weightWindowGenerator.particleType) {
                    lines.push(`    <particle_type>${vr.weightWindowGenerator.particleType}</particle_type>`);
                }
                lines.push('  </weight_window_generator>');
            }
            
            // Weight windows
            if (vr.weightWindows) {
                const ww = vr.weightWindows;
                lines.push('  <weight_windows id="1">');
                
                if (ww.meshId !== undefined) {
                    lines.push(`    <mesh>${ww.meshId}</mesh>`);
                }
                
                // Particle type (required, default neutron)
                lines.push(`    <particle_type>${ww.particleType || 'neutron'}</particle_type>`);
                
                // Calculate number of mesh cells for bounds array
                let numCells = 1;
                const mesh = state.meshes.find((m: OpenMCMesh) => m.id === ww.meshId);
                if (mesh) {
                    if (mesh.type === 'regular') {
                        const regularMesh = mesh as OpenMCRegularMesh;
                        numCells = regularMesh.dimension[0] * regularMesh.dimension[1] * regularMesh.dimension[2];
                    } else if (mesh.type === 'cylindrical') {
                        const cylMesh = mesh as OpenMCCylindricalMesh;
                        numCells = (cylMesh.rGrid.length - 1) * (cylMesh.phiGrid.length - 1) * (cylMesh.zGrid.length - 1);
                    } else if (mesh.type === 'spherical') {
                        const sphMesh = mesh as OpenMCSphericalMesh;
                        numCells = (sphMesh.rGrid.length - 1) * (sphMesh.thetaGrid.length - 1) * (sphMesh.phiGrid.length - 1);
                    }
                }
                
                // Number of energy groups (N bounds = N-1 groups)
                const numEnergyGroups = ww.energyBounds && ww.energyBounds.length > 1 ? ww.energyBounds.length - 1 : 1;
                const totalBounds = numCells * numEnergyGroups;
                
                // Lower ww bounds - must have one value per mesh cell per energy group
                const lowerBoundValue = typeof ww.lowerBound === 'number' ? ww.lowerBound : 0.5;
                const lowerBounds = Array(totalBounds).fill(lowerBoundValue);
                lines.push(`    <lower_ww_bounds>${lowerBounds.join(' ')}</lower_ww_bounds>`);
                
                // Upper ww bounds - must have one value per mesh cell per energy group
                const upperBoundValue = typeof ww.upperBound === 'number' ? ww.upperBound : lowerBoundValue * 2;
                const upperBounds = Array(totalBounds).fill(upperBoundValue);
                lines.push(`    <upper_ww_bounds>${upperBounds.join(' ')}</upper_ww_bounds>`);
                
                // Survival ratio (default 3.0)
                lines.push(`    <survival_ratio>${ww.survivalWeight !== undefined ? ww.survivalWeight : 3.0}</survival_ratio>`);
                
                // Required parameters
                lines.push(`    <max_split>10</max_split>`);
                lines.push(`    <weight_cutoff>1e-38</weight_cutoff>`);
                
                // Energy bounds - REQUIRED by OpenMC
                // Must have at least 2 bounds to define 1 energy group
                if (ww.energyBounds && ww.energyBounds.length >= 2) {
                    lines.push(`    <energy_bounds>${ww.energyBounds.join(' ')}</energy_bounds>`);
                } else {
                    this.log('Warning: Weight windows require energy_bounds (minimum 2 values)');
                }
                
                lines.push('  </weight_windows>');
            }
            
            // Uniform Fission Site (UFS)
            if (vr.ufs?.enabled) {
                lines.push('');
                lines.push('  <!-- Uniform Fission Site -->');
                lines.push('  <ufs>');
                if (vr.ufs.meshId !== undefined) {
                    lines.push(`    <mesh>${vr.ufs.meshId}</mesh>`);
                }
                lines.push('  </ufs>');
            }
        }

        lines.push('</settings>');
        
        return lines.join('\n');
    }

    private generateSourceElement(source: any): string {
        const lines: string[] = [];
        
        // Skip sources without proper spatial definition
        if (!source.spatial || !source.spatial.type) {
            this.log(`Warning: Skipping source with no spatial definition`);
            return '';
        }
        
        // Source with required attributes (type, strength, particle)
        const strength = source.strength !== undefined ? source.strength : 1.0;
        const particle = source.particle || 'neutron';
        lines.push(`  <source type="independent" strength="${strength}" particle="${particle}">`);
        
        // Generate spatial distribution with parameters
        const spatialLines = this.generateSpatialElement(source.spatial);
        if (spatialLines) {
            lines.push(spatialLines);
        } else {
            // If we can't generate valid spatial, skip this source
            this.log(`Warning: Skipping source with unsupported spatial type: ${source.spatial.type}`);
            return '';
        }
        
        if (source.energy) {
            const energyLines = this.generateEnergyElement(source.energy);
            if (energyLines) {
                lines.push(energyLines);
            }
        }
        
        if (source.angle) {
            const angleLines = this.generateAngleElement(source.angle);
            if (angleLines) {
                lines.push(angleLines);
            }
        }
        
        lines.push('  </source>');
        
        return lines.join('\n');
    }
    
    private generateSpatialElement(spatial: any): string {
        const type = spatial.type;
        
        switch (type) {
            case 'box':
                const lowerLeft = spatial.lowerLeft || [-10, -10, -10];
                const upperRight = spatial.upperRight || [10, 10, 10];
                return `    <space type="box">\n      <parameters>${lowerLeft.join(' ')} ${upperRight.join(' ')}</parameters>\n    </space>`;
                
            case 'point':
                const origin = spatial.origin || [0, 0, 0];
                return `    <space type="point">\n      <parameters>${origin.join(' ')}</parameters>\n    </space>`;
                
            case 'sphere':
                // OpenMC XML uses 'spherical' with independent distributions for r, theta, phi
                const center = spatial.center || [0, 0, 0];
                const radius = spatial.radius !== undefined ? spatial.radius : 1;
                return `    <space type="spherical" origin="${center.join(' ')}">\n      <r type="uniform" parameters="0 ${radius}"/>\n      <cos_theta type="uniform" parameters="-1 1"/>\n      <phi type="uniform" parameters="0 6.28318530718"/>\n    </space>`;
                
            case 'cylinder':
                // OpenMC XML uses 'cylindrical' with independent distributions for r, phi, z
                const cylCenter = spatial.center || [0, 0, 0];
                const cylRadius = spatial.radius !== undefined ? spatial.radius : 1;
                const height = spatial.height !== undefined ? spatial.height : 1;
                return `    <space type="cylindrical" origin="${cylCenter.join(' ')}">\n      <r type="uniform" parameters="0 ${cylRadius}"/>\n      <phi type="uniform" parameters="0 6.28318530718"/>\n      <z type="uniform" parameters="-${height/2} ${height/2}"/>\n    </space>`;
                
            default:
                this.log(`Warning: Unknown spatial type '${type}', using default box`);
                return '    <space type="box">\n      <parameters>-10 -10 -10 10 10 10</parameters>\n    </space>';
        }
    }
    
    private generateEnergyElement(energy: any): string {
        const type = energy.type;
        
        switch (type) {
            case 'discrete':
                const energies = energy.energies || [1e6];
                // For discrete energy, parameters are: energy1 prob1 energy2 prob2 ...
                // If only energies provided, assume equal probability (sum to 1)
                const params: string[] = [];
                const prob = 1.0 / energies.length;
                for (const e of energies) {
                    params.push(String(e));
                    params.push(String(prob));
                }
                return `    <energy type="discrete">\n      <parameters>${params.join(' ')}</parameters>\n    </energy>`;
                
            case 'uniform':
                const min = energy.min !== undefined ? energy.min : 1e-5;
                const max = energy.max !== undefined ? energy.max : 2e7;
                return `    <energy type="uniform">\n      <parameters>${min} ${max}</parameters>\n    </energy>`;
                
            case 'maxwell':
                const temp = energy.temperature || 0.025;
                return `    <energy type="maxwell">\n      <parameters>${temp}</parameters>\n    </energy>`;
                
            case 'watt':
                const a = energy.a || 0.988;
                const b = energy.b || 2.249;
                return `    <energy type="watt">\n      <parameters>${a} ${b}</parameters>\n    </energy>`;
                
            case 'muir':
            case 'tabular':
                this.log(`Warning: Energy type '${type}' not fully implemented`);
                return '';
                
            default:
                return '';
        }
    }
    
    private generateAngleElement(angle: any): string {
        const type = angle.type;
        
        switch (type) {
            case 'isotropic':
                return '    <angle type="isotropic"/>';
                
            case 'monodirectional':
                return '    <angle type="monodirectional"/>';
                
            default:
                this.log(`Warning: Angle type '${type}' not fully implemented`);
                return '';
        }
    }

    // ============================================================================
    // Tallies XML
    // ============================================================================

    private generateTalliesXML(state: OpenMCState): string {
        const lines: string[] = [
            '<?xml version="1.0"?>',
            '<tallies>',
            ''
        ];
        
        // Add meshes first
        for (const mesh of state.meshes) {
            lines.push(this.generateMeshElement(mesh));
        }
        
        // Collect all unique filters and assign them IDs
        const filterMap = new Map<string, { id: number; type: string; bins: number[]; meshId?: number }>();
        let nextFilterId = 1;
        
        for (const tally of state.tallies) {
            for (const filter of tally.filters) {
                // Create a unique key for this filter
                const key = this.getFilterKey(filter);
                if (!filterMap.has(key)) {
                    filterMap.set(key, {
                        id: nextFilterId++,
                        type: filter.type,
                        bins: filter.bins,
                        meshId: filter.meshId
                    });
                }
            }
        }
        
        // Generate filter elements at the top level
        for (const filter of filterMap.values()) {
            lines.push(this.generateFilterElement(filter));
        }
        
        // Add tallies with filter references
        for (const tally of state.tallies) {
            lines.push(this.generateTallyElement(tally, filterMap));
        }
        
        lines.push('</tallies>');
        
        return lines.join('\n');
    }
    
    private getFilterKey(filter: any): string {
        // Create a unique key based on filter type, bins, and meshId
        const baseKey = `${filter.type}:${filter.bins.join(',')}`;
        if (filter.meshId !== undefined) {
            return `${baseKey}:mesh${filter.meshId}`;
        }
        return baseKey;
    }

    private generateMeshElement(mesh: OpenMCMesh): string {
        const lines: string[] = [];

        if (mesh.type === 'regular') {
            const regularMesh = mesh as OpenMCRegularMesh;
            lines.push(`  <mesh id="${mesh.id}" type="regular">`);
            lines.push(`    <lower_left>${regularMesh.lowerLeft.join(' ')}</lower_left>`);
            lines.push(`    <upper_right>${regularMesh.upperRight.join(' ')}</upper_right>`);
            lines.push(`    <dimension>${regularMesh.dimension.join(' ')}</dimension>`);
            lines.push('  </mesh>');
        } else if (mesh.type === 'cylindrical') {
            const cylMesh = mesh as OpenMCCylindricalMesh;
            lines.push(`  <mesh id="${mesh.id}" type="cylindrical">`);
            if (cylMesh.origin) {
                lines.push(`    <origin>${cylMesh.origin.join(' ')}</origin>`);
            }
            if (cylMesh.axis) {
                lines.push(`    <axis>${cylMesh.axis.join(' ')}</axis>`);
            }
            lines.push(`    <r_grid>${cylMesh.rGrid.join(' ')}</r_grid>`);
            lines.push(`    <phi_grid>${cylMesh.phiGrid.join(' ')}</phi_grid>`);
            lines.push(`    <z_grid>${cylMesh.zGrid.join(' ')}</z_grid>`);
            lines.push('  </mesh>');
        } else if (mesh.type === 'spherical') {
            const sphMesh = mesh as OpenMCSphericalMesh;
            lines.push(`  <mesh id="${mesh.id}" type="spherical">`);
            if (sphMesh.origin) {
                lines.push(`    <origin>${sphMesh.origin.join(' ')}</origin>`);
            }
            lines.push(`    <r_grid>${sphMesh.rGrid.join(' ')}</r_grid>`);
            lines.push(`    <theta_grid>${sphMesh.thetaGrid.join(' ')}</theta_grid>`);
            lines.push(`    <phi_grid>${sphMesh.phiGrid.join(' ')}</phi_grid>`);
            lines.push('  </mesh>');
        }

        lines.push('');
        return lines.join('\n');
    }
    private generateTallyElement(tally: OpenMCTally, filterMap: Map<string, any>): string {
        const lines: string[] = [];
        
        const nameAttr = tally.name ? ` name="${this.escapeXml(tally.name)}"` : '';
        lines.push(`  <tally id="${tally.id}"${nameAttr}>`);
        
        // Collect filter IDs for this tally
        const filterIds: number[] = [];
        for (const filter of tally.filters) {
            const key = this.getFilterKey(filter);
            const filterDef = filterMap.get(key);
            if (filterDef) {
                filterIds.push(filterDef.id);
            }
        }
        
        // Add filters reference if there are any filters
        if (filterIds.length > 0) {
            lines.push(`    <filters>${filterIds.join(' ')}</filters>`);
        }
        
        // Add nuclides
        for (const nuclide of tally.nuclides) {
            lines.push(`    <nuclide>${nuclide}</nuclide>`);
        }
        
        // Add scores - space-separated in a single element
        if (tally.scores.length > 0) {
            lines.push(`    <scores>${tally.scores.join(' ')}</scores>`);
        }
        
        // Estimator
        if (tally.estimator) {
            lines.push(`    <estimator>${tally.estimator}</estimator>`);
        }
        
        lines.push('  </tally>');
        lines.push('');
        
        return lines.join('\n');
    }

    private generateFilterElement(filter: any): string {
        const lines: string[] = [];
        
        // Mesh filter needs a mesh attribute
        if (filter.meshId !== undefined) {
            lines.push(`  <filter id="${filter.id}" type="mesh">`);
            lines.push(`    <bins>${filter.bins.join(' ')}</bins>`);
        } else {
            lines.push(`  <filter id="${filter.id}" type="${filter.type}">`);
            lines.push(`    <bins>${filter.bins.join(' ')}</bins>`);
        }
        lines.push('  </filter>');
        lines.push('');
        
        return lines.join('\n');
    }

    // ============================================================================
    // Plots XML
    // ============================================================================

    private generatePlotsXML(state: OpenMCState): string {
        const lines: string[] = [
            '<?xml version="1.0"?>',
            '<plots>',
            ''
        ];
        
        for (const plot of state.plots || []) {
            lines.push(this.generatePlotElement(plot));
        }
        
        lines.push('</plots>');
        
        return lines.join('\n');
    }

    private generatePlotElement(plot: any): string {
        const lines: string[] = [];
        
        lines.push(`  <plot basis="${plot.basis}" color_by="${plot.colorBy}" id="${plot.id}" type="${plot.type}">`);
        lines.push(`    <origin>${plot.origin.join(' ')}</origin>`);
        
        if (plot.type === 'slice') {
            lines.push(`    <width>${plot.width}</width>`);
            lines.push(`    <height>${plot.height}</height>`);
            lines.push(`    <pixels>${plot.pixels.join(' ')}</pixels>`);
        }
        
        if (plot.meshlines) {
            lines.push('    <meshlines>1</meshlines>');
        }
        
        lines.push('  </plot>');
        lines.push('');
        
        return lines.join('\n');
    }

    // ============================================================================
    // Utilities
    // ============================================================================

    private escapeXml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }
}
