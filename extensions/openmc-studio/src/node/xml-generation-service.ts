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
            
            // Generate geometry.xml
            if (request.files.geometry) {
                const geometryPath = path.join(request.outputDirectory, 'geometry.xml');
                const geometryXml = this.generateGeometryXML(request.state);
                fs.writeFileSync(geometryPath, geometryXml);
                generatedFiles.push(geometryPath);
                this.log(`Generated geometry.xml`);
            }
            
            // Generate settings.xml
            if (request.files.settings) {
                const settingsPath = path.join(request.outputDirectory, 'settings.xml');
                const settingsXml = this.generateSettingsXML(request.state);
                fs.writeFileSync(settingsPath, settingsXml);
                generatedFiles.push(settingsPath);
                this.log(`Generated settings.xml`);
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
        
        for (const material of state.materials) {
            lines.push(this.generateMaterialElement(material));
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

    private generateSurfaceElement(surface: OpenMCSurface): string {
        // Always use 'vacuum' for boundaries to allow particles to escape
        // 'transmission' causes particles to get lost when crossing surfaces
        // This is a workaround until proper boundary detection is implemented
        const boundary = surface.boundary === 'reflective' ? 'reflective' : 'vacuum';
        const boundaryAttr = ` boundary="${boundary}"`;
        const nameAttr = surface.name ? ` name="${this.escapeXml(surface.name)}"` : '';
        
        return `  <surface coeffs="${this.coeffsToString(surface)}" id="${surface.id}" type="${surface.type}"${boundaryAttr}${nameAttr}/>`;
    }

    private coeffsToString(surface: OpenMCSurface): string {
        // Format coefficients based on surface type
        const values = Object.values(surface.coefficients);
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
        
        // Source rejection fraction
        if (settings.sourceRejectionFraction !== undefined) {
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
        
        // Add tallies
        for (const tally of state.tallies) {
            lines.push(this.generateTallyElement(tally));
        }
        
        lines.push('</tallies>');
        
        return lines.join('\n');
    }

    private generateMeshElement(mesh: OpenMCMesh): string {
        const lines: string[] = [];
        
        if (mesh.type === 'regular') {
            const regularMesh = mesh as any;
            lines.push(`  <mesh id="${mesh.id}" type="regular">`);
            lines.push(`    <lower_left>${regularMesh.lowerLeft.join(' ')}</lower_left>`);
            lines.push(`    <upper_right>${regularMesh.upperRight.join(' ')}</upper_right>`);
            lines.push(`    <dimension>${regularMesh.dimension.join(' ')}</dimension>`);
            lines.push('  </mesh>');
        }
        
        lines.push('');
        return lines.join('\n');
    }

    private generateTallyElement(tally: OpenMCTally): string {
        const lines: string[] = [];
        
        const nameAttr = tally.name ? ` name="${this.escapeXml(tally.name)}"` : '';
        lines.push(`  <tally id="${tally.id}"${nameAttr}>`);
        
        // Add filters
        for (const filter of tally.filters) {
            lines.push(this.generateFilterElement(filter));
        }
        
        // Add nuclides
        for (const nuclide of tally.nuclides) {
            lines.push(`    <nuclide>${nuclide}</nuclide>`);
        }
        
        // Add scores
        for (const score of tally.scores) {
            lines.push(`    <score>${score}</score>`);
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
        
        lines.push(`    <filter type="${filter.type}">`);
        lines.push(`      <bins>${filter.bins.join(' ')}</bins>`);
        lines.push('    </filter>');
        
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
