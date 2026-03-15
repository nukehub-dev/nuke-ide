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

import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { MessageService } from '@theia/core/lib/common/message-service';
import { Emitter, Event } from '@theia/core/lib/common';
import URI from '@theia/core/lib/common/uri';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import {
    OpenMCBackendService,
    OpenMCStatepointInfo,
    OpenMCTallyInfo,
    XSPlotRequest,
    XSPlotData,
    XSGroupStructuresResponse,
    PythonConfig
} from '../../common/visualizer-protocol';
import { VisualizerWidget } from '../visualizer-widget';
import { WidgetManager, ApplicationShell } from '@theia/core/lib/browser';
import { OpenMCMultiScoreData } from '../plotly/plotly-utils';
import { VisualizerPreferences } from '../visualizer-preferences';

export interface OpenMCFileSet {
    /** Geometry file (DAGMC .h5m or VTK) */
    geometry?: URI;
    /** Statepoint file with tally results */
    statepoint?: URI;
    /** Source file with particle distribution */
    source?: URI;
}

export interface TallyVisualizationOptions {
    /** Tally ID to visualize */
    tallyId: number;
    /** Score to visualize (e.g., 'flux', 'heating') */
    score?: string;
    /** Nuclide to visualize (e.g., 'U235', 'total') */
    nuclide?: string;
    /** Whether to normalize values */
    normalize?: boolean;
    /** Color map to use */
    colorMap?: string;
}

@injectable()
export class OpenMCService {
    @inject(MessageService)
    protected readonly messageService: MessageService;

    @inject(FileService)
    protected readonly fileService: FileService;

    @inject(WidgetManager)
    protected readonly widgetManager: WidgetManager;

    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    @inject(OpenMCBackendService)
    protected readonly openmcBackend: OpenMCBackendService;

    @inject(VisualizerPreferences)
    protected readonly preferences: VisualizerPreferences;

    private readonly _onStatepointLoaded = new Emitter<OpenMCStatepointInfo>();
    readonly onStatepointLoaded: Event<OpenMCStatepointInfo> = this._onStatepointLoaded.event;

    private readonly _onTallyVisualized = new Emitter<OpenMCTallyInfo>();
    readonly onTallyVisualized: Event<OpenMCTallyInfo> = this._onTallyVisualized.event;

    private currentStatepoint: OpenMCStatepointInfo | null = null;
    private currentTallies: OpenMCTallyInfo[] = [];

    @postConstruct()
    protected init(): void {
        this.updatePythonConfig();
        this.preferences.onPreferenceChanged(event => {
            if (event.preferenceName === 'nukeVisualizer.pythonPath' || event.preferenceName === 'nukeVisualizer.condaEnv') {
                this.updatePythonConfig();
            }
        });
    }

    protected updatePythonConfig(): void {
        const config: PythonConfig = {
            pythonPath: this.preferences['nukeVisualizer.pythonPath'] || undefined,
            condaEnv: this.preferences['nukeVisualizer.condaEnv'] || undefined,
        };
        this.openmcBackend.setPythonConfig(config);
    }

    /**
     * Check if OpenMC integration is available.
     */
    async checkAvailability(): Promise<boolean> {
        try {
            const result = await this.openmcBackend.checkOpenMCAvailable();
            if (result.warning) {
                this.messageService.warn(result.warning);
            }
            if (!result.available) {
                this.messageService.warn(`OpenMC integration: ${result.message}`);
                return false;
            }
            return true;
        } catch (error) {
            console.error('[OpenMC] Error checking availability:', error);
            return false;
        }
    }

    /**
     * Load a statepoint file and return summary information.
     */
    async loadStatepoint(statepointUri: URI): Promise<OpenMCStatepointInfo | null> {
        const available = await this.checkAvailability();
        if (!available) {
            return null;
        }

        try {
            const statepointPath = statepointUri.path.toString();
            const info = await this.openmcBackend.loadStatepoint(statepointPath);
            
            this.currentStatepoint = info;
            this._onStatepointLoaded.fire(info);
            
            this.messageService.info(
                `Loaded OpenMC statepoint: ${info.batches} batches, ${info.nTallies} tallies` +
                (info.kEff ? `, keff=${info.kEff.toFixed(5)}` : '')
            );
            
            // Load tally list
            await this.loadTallyList(statepointUri);
            
            return info;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.messageService.error(`Failed to load statepoint: ${msg}`);
            return null;
        }
    }

    /**
     * Load list of tallies from statepoint file.
     */
    async loadTallyList(statepointUri: URI): Promise<OpenMCTallyInfo[]> {
        try {
            const statepointPath = statepointUri.path.toString();
            const tallies = await this.openmcBackend.listTallies(statepointPath);
            this.currentTallies = tallies;
            return tallies;
        } catch (error) {
            console.error('[OpenMC] Error loading tally list:', error);
            return [];
        }
    }

    /**
     * Get the currently loaded tallies.
     */
    getCurrentTallies(): OpenMCTallyInfo[] {
        return this.currentTallies;
    }

    /**
     * Get the currently loaded statepoint info.
     */
    getCurrentStatepoint(): OpenMCStatepointInfo | null {
        return this.currentStatepoint;
    }

    /**
     * Visualize a mesh tally from a statepoint file.
     */
    async visualizeMeshTally(
        statepointUri: URI,
        options: TallyVisualizationOptions
    ): Promise<VisualizerWidget | null> {
        const available = await this.checkAvailability();
        if (!available) {
            return null;
        }

        try {
            // Check if a widget for this exact tally already exists
            const deterministicId = this.getTallyWidgetId(statepointUri, options);
            const existingWidget = this.findExistingWidget(deterministicId);
            if (existingWidget) {
                // Just activate the existing widget
                await this.shell.activateWidget(existingWidget.id);
                this.messageService.info('Tally visualization already open');
                return existingWidget;
            }

            const progress = await this.messageService.showProgress({
                text: 'Loading mesh tally visualization...',
                options: { cancelable: false }
            });

            const statepointPath = statepointUri.path.toString();
            const result = await this.openmcBackend.visualizeMeshTally(
                statepointPath,
                options.tallyId,
                options.score,
                options.nuclide
            );

            progress.cancel();

            if (!result.success || !result.port || !result.url) {
                throw new Error(result.error || 'Unknown error loading visualization');
            }
            
            // Build label with tally name if available (skip default "Tally N" names)
            let label = `OpenMC Tally ${options.tallyId}`;
            const tallyName = result.tallyInfo?.name;
            const defaultName = `Tally ${options.tallyId}`;
            // Only add name if it's set and not the default "Tally N" pattern
            if (tallyName && tallyName !== defaultName && !tallyName.match(/^Tally\s+\d+$/i)) {
                label += `: ${tallyName}`;
            }
            if (options.score) {
                label += ` (${options.score})`;
            }
            
            // Create and configure widget with deterministic ID
            const widget = await this.createVisualizerWidget(
                statepointUri,
                result.port,
                result.url,
                label,
                deterministicId
            );

            if (result.tallyInfo) {
                this._onTallyVisualized.fire(result.tallyInfo);
            }

            this.messageService.info(`Loaded mesh tally visualization on port ${result.port}`);
            return widget;

        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.messageService.error(`Failed to visualize mesh tally: ${msg}`);
            return null;
        }
    }

    /**
     * Generate a deterministic widget ID for a tally visualization.
     * This allows us to check if the same tally is already open.
     */
    private getTallyWidgetId(statepointUri: URI, options: TallyVisualizationOptions): string {
        const baseId = statepointUri.path.toString();
        return `${VisualizerWidget.ID}:${baseId}:${options.tallyId}:${options.score || 'default'}:${options.nuclide || 'total'}`;
    }

    /**
     * Find an existing widget with the given ID.
     */
    private findExistingWidget(widgetId: string): VisualizerWidget | undefined {
        for (const widget of this.shell.getWidgets('main')) {
            if (widget.id === widgetId && widget instanceof VisualizerWidget) {
                return widget;
            }
        }
        return undefined;
    }

    /**
     * Visualize source distribution from source.h5 file.
     */
    async visualizeSource(sourceUri: URI): Promise<VisualizerWidget | null> {
        const available = await this.checkAvailability();
        if (!available) {
            return null;
        }

        try {
            const progress = await this.messageService.showProgress({
                text: 'Loading source distribution...',
                options: { cancelable: false }
            });

            const sourcePath = sourceUri.path.toString();
            const result = await this.openmcBackend.visualizeSource(sourcePath);

            progress.cancel();

            if (!result.success || !result.port || !result.url) {
                throw new Error(result.error || 'Unknown error loading source');
            }

            // Create unique suffix for source visualization
            const uniqueSuffix = `source:${Date.now()}`;
            
            const widget = await this.createVisualizerWidget(
                sourceUri,
                result.port,
                result.url,
                'OpenMC Source Distribution',
                uniqueSuffix
            );

            this.messageService.info('Loaded source distribution');
            return widget;

        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.messageService.error(`Failed to visualize source: ${msg}`);
            return null;
        }
    }

    /**
     * Overlay tally results on geometry.
     */
    async visualizeTallyOnGeometry(
        geometryUri: URI,
        statepointUri: URI,
        options: TallyVisualizationOptions
    ): Promise<VisualizerWidget | null> {
        const available = await this.checkAvailability();
        if (!available) {
            return null;
        }

        try {
            const progress = await this.messageService.showProgress({
                text: 'Loading tally overlay on geometry...',
                options: { cancelable: false }
            });

            const geometryPath = geometryUri.path.toString();
            const statepointPath = statepointUri.path.toString();

            const result = await this.openmcBackend.visualizeTallyOnGeometry(
                geometryPath,
                statepointPath,
                options.tallyId,
                options.score
            );

            progress.cancel();

            if (!result.success || !result.port || !result.url) {
                throw new Error(result.error || 'Unknown error loading overlay');
            }

            // Create unique suffix for overlay visualization
            const uniqueSuffix = `overlay:${options.tallyId}:${options.score || 'default'}:${Date.now()}`;
            
            // Build label with tally name if available (skip default "Tally N" names)
            let label = `OpenMC Tally ${options.tallyId}`;
            const tallyName = result.tallyInfo?.name;
            const defaultName = `Tally ${options.tallyId}`;
            // Only add name if it's set and not the default "Tally N" pattern
            if (tallyName && tallyName !== defaultName && !tallyName.match(/^Tally\s+\d+$/i)) {
                label += `: ${tallyName}`;
            }
            if (options.score) {
                label += ` (${options.score})`;
            }
            label += ' on Geometry';
            
            const widget = await this.createVisualizerWidget(
                statepointUri,
                result.port,
                result.url,
                label,
                uniqueSuffix
            );

            if (result.tallyInfo) {
                this._onTallyVisualized.fire(result.tallyInfo);
            }

            this.messageService.info('Loaded tally overlay on geometry');
            return widget;

        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.messageService.error(`Failed to overlay tally: ${msg}`);
            return null;
        }
    }

    /**
     * Get energy spectrum data for a tally.
     */
    async getEnergySpectrum(statepointUri: URI, tallyId: number, scoreIndex?: number, nuclideIndex?: number) {
        return this.openmcBackend.getEnergySpectrum(statepointUri.path.toString(), tallyId, scoreIndex, nuclideIndex);
    }

    /**
     * Get spectrum for multiple scores/nuclides.
     */
    async getMultiScoreSpectrum(statepointUri: URI, tallyId: number, scores: string[], nuclide: string = 'total'): Promise<OpenMCMultiScoreData> {
        const tally = this.currentTallies.find(t => t.id === tallyId);
        if (!tally) throw new Error(`Tally ${tallyId} not found`);

        const multiData: OpenMCMultiScoreData = { scores: [] };
        
        for (const scoreName of scores) {
            const sIdx = tally.scores.indexOf(scoreName);
            const nIdx = tally.nuclides.indexOf(nuclide);
            if (sIdx === -1) continue;

            const data = await this.getEnergySpectrum(statepointUri, tallyId, sIdx, nIdx);
            if (!multiData.energy_bins) {
                multiData.energy_bins = data.energy_bins;
            }
            multiData.scores.push({
                name: `${scoreName} (${nuclide})`,
                values: data.values,
                std_dev: data.std_dev
            });
        }

        return multiData;
    }

    /**
     * Get spatial plot data for a mesh tally.
     */
    async getSpatialPlot(statepointUri: URI, tallyId: number, axis: 'x' | 'y' | 'z', scoreIndex?: number, nuclideIndex?: number) {
        return this.openmcBackend.getSpatialPlot(statepointUri.path.toString(), tallyId, axis, scoreIndex, nuclideIndex);
    }

    /**
     * Get spatial plot for multiple scores.
     */
    async getMultiScoreSpatialPlot(statepointUri: URI, tallyId: number, axis: 'x' | 'y' | 'z', scores: string[], nuclide: string = 'total'): Promise<OpenMCMultiScoreData> {
        const tally = this.currentTallies.find(t => t.id === tallyId);
        if (!tally) throw new Error(`Tally ${tallyId} not found`);

        const multiData: OpenMCMultiScoreData = { scores: [] };
        
        for (const scoreName of scores) {
            const sIdx = tally.scores.indexOf(scoreName);
            const nIdx = tally.nuclides.indexOf(nuclide);
            if (sIdx === -1) continue;

            const data = await this.getSpatialPlot(statepointUri, tallyId, axis, sIdx, nIdx);
            if (!multiData.positions) {
                multiData.positions = data.positions;
            }
            multiData.scores.push({
                name: `${scoreName} (${nuclide})`,
                values: data.values,
                std_dev: data.std_dev
            });
        }

        return multiData;
    }

    /**
     * Discover OpenMC-related files in a directory.
     */
    async discoverFilesInDirectory(directoryUri: URI): Promise<OpenMCFileSet> {
        const files: OpenMCFileSet = {};

        try {
            const stat = await this.fileService.resolve(directoryUri);
            
            if (!stat.isDirectory) {
                return files;
            }

            for (const child of stat.children || []) {
                const name = child.name.toLowerCase();
                
                // Look for geometry files
                if (name.endsWith('.h5m') || name.endsWith('.vtk')) {
                    files.geometry = child.resource;
                }
                
                // Look for statepoint files
                if (name.startsWith('statepoint') && name.endsWith('.h5')) {
                    files.statepoint = child.resource;
                }
                
                // Look for source files
                if (name === 'source.h5') {
                    files.source = child.resource;
                }
            }

        } catch (error) {
            console.error('[OpenMC] Error discovering files:', error);
        }

        return files;
    }

    /**
     * Auto-detect and suggest visualization for a file.
     */
    async suggestVisualization(fileUri: URI): Promise<string | null> {
        const name = fileUri.path.base.toLowerCase();
        const parent = fileUri.parent;

        if (name.startsWith('statepoint') && name.endsWith('.h5')) {
            return 'statepoint';
        }

        if (name === 'source.h5') {
            return 'source';
        }

        if (name.endsWith('.h5m')) {
            // Check if there's a statepoint in the same directory
            const files = await this.discoverFilesInDirectory(parent);
            if (files.statepoint) {
                return 'geometry_with_tally';
            }
            return 'geometry';
        }

        return null;
    }

    /**
     * Create and configure a visualizer widget.
     */
    private async createVisualizerWidget(
        fileUri: URI,
        port: number,
        url: string,
        label: string,
        widgetId?: string
    ): Promise<VisualizerWidget> {
        // Use provided widgetId or create default one
        const finalWidgetId = widgetId || `${VisualizerWidget.ID}:${fileUri.path.toString()}`;
        
        // Create widget with unique ID - always create new for different visualizations
        const widget = await this.widgetManager.getOrCreateWidget<VisualizerWidget>(
            VisualizerWidget.ID, 
            { uri: fileUri.toString(), id: finalWidgetId }
        );
        
        // Set the actual widget ID (before setUri which might overwrite it)
        widget.id = finalWidgetId;
        
        // Set the file URI and label
        widget.setUri(fileUri);
        
        // Restore the ID since setUri overwrites it
        widget.id = finalWidgetId;
        
        widget.title.label = label;
        widget.title.caption = label;
        
        // IMPORTANT: Set the server URL directly on the widget
        // This bypasses the normal loadFile() flow since the server is already running
        widget.setServerUrl(url, port);
        
        // Add widget to main area and activate it
        await this.shell.addWidget(widget, { area: 'main' });
        await this.shell.activateWidget(widget.id);
        
        return widget;
    }

    /**
     * Get filter description for display.
     */
    getFilterDescription(filter: { type: string; bins: number; meshDimensions?: number[] }): string {
        if (filter.type === 'mesh' && filter.meshDimensions) {
            return `Mesh (${filter.meshDimensions.join('×')})`;
        }
        return `${filter.type} (${filter.bins} bins)`;
    }

    /**
     * Get a human-readable tally description.
     */
    getTallyDescription(tally: OpenMCTallyInfo): string {
        const parts: string[] = [];
        
        if (tally.scores.length > 0) {
            parts.push(tally.scores.join(', '));
        }
        
        if (tally.nuclides.length > 0 && !tally.nuclides.includes('total')) {
            parts.push(tally.nuclides.join(', '));
        }
        
        const filterDesc = tally.filters.map(f => this.getFilterDescription(f)).join(', ');
        if (filterDesc) {
            parts.push(filterDesc);
        }
        
        return parts.join(' | ') || 'Tally';
    }

    // === Cross-Section (XS) Plotting ===

    /**
     * Check if OpenMC Python module is available for XS plotting.
     */
    async checkOpenMCPythonAvailable(): Promise<boolean> {
        try {
            const result = await this.openmcBackend.checkOpenMCPythonAvailable();
            if (result.warning) {
                this.messageService.warn(result.warning);
            }
            if (!result.available) {
                this.messageService.warn(`OpenMC Python: ${result.message}`);
                return false;
            }
            return true;
        } catch (error) {
            console.error('[OpenMC] Error checking Python availability:', error);
            return false;
        }
    }

    /**
     * Get cross-section data for nuclides and reactions.
     */
    async getXSData(request: XSPlotRequest): Promise<XSPlotData | null> {
        const available = await this.checkOpenMCPythonAvailable();
        if (!available) {
            return { curves: [], error: 'OpenMC Python module not available' };
        }

        const progress = await this.messageService.showProgress({
            text: 'Loading cross-section data...',
            options: { cancelable: false }
        });

        try {
            // Add cross-section path from preferences if not already set
            if (!request.crossSectionsPath) {
                const prefPath = this.preferences['nukeVisualizer.openmcCrossSectionsPath'];
                if (prefPath) {
                    request.crossSectionsPath = prefPath;
                }
            }

            const data = await this.openmcBackend.getXSData(request);
            return data;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            return { curves: [], error: msg };
        } finally {
            progress.cancel();
        }
    }

    /**
     * Get available nuclides from cross_sections.xml.
     */
    async getAvailableNuclides(crossSectionsPath?: string): Promise<string[]> {
        try {
            return await this.openmcBackend.getAvailableNuclides(crossSectionsPath);
        } catch (error) {
            console.error('[OpenMC] Error getting nuclides:', error);
            return [];
        }
    }

    /**
     * Get available thermal scattering materials from cross_sections.xml.
     */
    async getAvailableThermalMaterials(crossSectionsPath?: string): Promise<string[]> {
        try {
            return await this.openmcBackend.getAvailableThermalMaterials(crossSectionsPath);
        } catch (error) {
            console.error('[OpenMC] Error getting thermal materials:', error);
            return [];
        }
    }

    /**
     * Get available energy group structures for multigroup XS.
     */
    async getGroupStructures(): Promise<XSGroupStructuresResponse> {
        try {
            return await this.openmcBackend.getGroupStructures();
        } catch (error) {
            console.error('[OpenMC] Error getting group structures:', error);
            return { structures: [], metadata: { openmc_available: false, sources: [] } };
        }
    }

    /**
     * Get cross-section data with temperature comparison (Doppler broadening visualization).
     */
    async getXSTemperatureComparison(
        nuclide: string,
        reaction: number | string,
        temperatures: number[],
        crossSectionsPath?: string,
        energyRegion?: string
    ): Promise<XSPlotData | null> {
        return this.getXSData({
            nuclides: [nuclide],
            reactions: [reaction],
            temperatureComparison: {
                nuclide,
                reaction,
                temperatures
            },
            crossSectionsPath,
            energyRegion: energyRegion as any
        });
    }

    /**
     * Get cross-section data for mixed materials.
     */
    async getXSMaterialData(
        materials: { name: string; components: { nuclide: string; fraction: number }[]; density?: number }[],
        reactions: (number | string)[],
        temperature: number = 294,
        crossSectionsPath?: string,
        fluxSpectrum?: { energy: number[]; values: number[]; name?: string }
    ): Promise<XSPlotData | null> {
        return this.getXSData({
            nuclides: [],
            reactions,
            temperature,
            materials: materials.map(m => ({
                name: m.name,
                components: m.components,
                density: m.density
            })),
            crossSectionsPath,
            fluxSpectrum
        });
    }

}
