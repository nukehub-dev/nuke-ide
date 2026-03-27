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
        
        // Add cells
        for (const cell of state.geometry.cells) {
            lines.push(this.generateCellElement(cell));
        }
        
        // Add lattices
        for (const lattice of state.geometry.lattices) {
            lines.push(this.generateLatticeElement(lattice));
        }
        
        lines.push('</geometry>');
        
        return lines.join('\n');
    }

    private generateSurfaceElement(surface: OpenMCSurface): string {
        const boundaryAttr = surface.boundary ? ` boundary="${surface.boundary}"` : '';
        const nameAttr = surface.name ? ` name="${this.escapeXml(surface.name)}"` : '';
        
        return `  <surface coeffs="${this.coeffsToString(surface)}" id="${surface.id}" type="${surface.type}"${boundaryAttr}${nameAttr}/>`;
    }

    private coeffsToString(surface: OpenMCSurface): string {
        // Format coefficients based on surface type
        const values = Object.values(surface.coefficients);
        return values.join(' ');
    }

    private generateCellElement(cell: OpenMCCell): string {
        const lines: string[] = [];
        
        const nameAttr = cell.name ? ` name="${this.escapeXml(cell.name)}"` : '';
        const tempAttr = cell.temperature ? ` temperature="${cell.temperature}"` : '';
        
        lines.push(`  <cell id="${cell.id}"${nameAttr}${tempAttr}>`);
        
        // Fill
        if (cell.fillType === 'material' && cell.fillId !== undefined) {
            lines.push(`    <material>${cell.fillId}</material>`);
        } else if (cell.fillType === 'universe' && cell.fillId !== undefined) {
            lines.push(`    <fill>${cell.fillId}</fill>`);
        } else if (cell.fillType === 'lattice' && cell.fillId !== undefined) {
            lines.push(`    <fill>${cell.fillId}</fill>`);
        } else if (cell.fillType === 'void') {
            lines.push(`    <material />`);
        }
        
        // Region
        if (cell.regionString) {
            lines.push(`    <region>${this.escapeXml(cell.regionString)}</region>`);
        } else if (cell.region) {
            const regionString = this.regionNodeToString(cell.region);
            if (regionString) {
                lines.push(`    <region>${this.escapeXml(regionString)}</region>`);
            }
        }
        
        lines.push('  </cell>');
        lines.push('');
        
        return lines.join('\n');
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
            for (const source of settings.sources) {
                lines.push(this.generateSourceElement(source));
            }
        }
        
        // Seed
        if (settings.seed) {
            lines.push(`  <seed>${settings.seed}</seed>`);
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
        
        lines.push('  <source>');
        lines.push('    <space type="' + source.spatial?.type + '">');
        // Add spatial parameters based on type
        lines.push('    </space>');
        
        if (source.energy) {
            lines.push('    <energy type="' + source.energy.type + '">');
            // Add energy parameters
            lines.push('    </energy>');
        }
        
        if (source.angle) {
            lines.push('    <angle type="' + source.angle.type + '">');
            lines.push('    </angle>');
        }
        
        lines.push('  </source>');
        
        return lines.join('\n');
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
