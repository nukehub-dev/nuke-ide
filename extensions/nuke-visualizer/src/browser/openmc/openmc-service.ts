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

import { injectable, inject } from '@theia/core/shared/inversify';
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
    OpenMCHeatmapData,
    OpenMCHeatmapPlane
} from '../../common/visualizer-protocol';
import { VisualizerWidget } from '../visualizer-widget';
import { WidgetManager, ApplicationShell } from '@theia/core/lib/browser';
import { OpenMCMultiScoreData } from '../plotly/plotly-utils';
import { VisualizerPreferences } from '../visualizer-preferences';
import { NukeCoreService } from 'nuke-core/lib/common';

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
    /** Whether to filter out graveyard surfaces (default: true) */
    filterGraveyard?: boolean;
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

    @inject(NukeCoreService)
    protected readonly nukeCoreService: NukeCoreService;

    private readonly _onStatepointLoaded = new Emitter<OpenMCStatepointInfo>();
    readonly onStatepointLoaded: Event<OpenMCStatepointInfo> = this._onStatepointLoaded.event;

    private readonly _onTallyVisualized = new Emitter<OpenMCTallyInfo>();
    readonly onTallyVisualized: Event<OpenMCTallyInfo> = this._onTallyVisualized.event;

    private currentStatepoint: OpenMCStatepointInfo | null = null;
    private currentTallies: OpenMCTallyInfo[] = [];

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
            console.log(`[OpenMC Service] Loading tallies from: ${statepointPath}`);
            
            // Clear old state first to prevent stale data
            this.currentTallies = [];
            
            const tallies = await this.openmcBackend.listTallies(statepointPath);
            this.currentTallies = tallies;
            
            // Also update currentStatepoint to reflect the new file
            // Create a minimal statepoint info if we don't have one
            if (!this.currentStatepoint || this.currentStatepoint.file !== statepointPath) {
                // Try to load full statepoint info, or create minimal one
                try {
                    const info = await this.openmcBackend.loadStatepoint(statepointPath);
                    this.currentStatepoint = info;
                    console.log(`[OpenMC Service] Updated statepoint info: ${info.nTallies} tallies`);
                } catch (e) {
                    // Create minimal statepoint info
                    this.currentStatepoint = {
                        file: statepointPath,
                        batches: 0,
                        generationsPerBatch: 0,
                        nTallies: tallies.length,
                        tallyIds: tallies.map(t => t.id)
                    };
                    console.log(`[OpenMC Service] Created minimal statepoint info with ${tallies.length} tallies`);
                }
            }
            
            console.log(`[OpenMC Service] Loaded ${tallies.length} tallies: ${tallies.map(t => t.id).join(', ')}`);
            return tallies;
        } catch (error) {
            console.error('[OpenMC] Error loading tally list:', error);
            this.currentTallies = [];
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
     * Clear the currently loaded statepoint.
     */
    clearStatepoint(): void {
        this.currentStatepoint = null;
        this.currentTallies = [];
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

            // Build label with tally name (we'll update it after getting tally info)
            let label = `OpenMC Tally ${options.tallyId}`;
            if (options.score) {
                label += ` (${options.score})`;
            }
            
            // Create widget immediately with loading state
            const { widget, completeLoading } = await this.createVisualizerWidgetLoading(
                statepointUri,
                label,
                deterministicId,
                'Starting mesh tally visualization...'
            );

            const statepointPath = statepointUri.path.toString();
            const result = await this.openmcBackend.visualizeMeshTally(
                statepointPath,
                options.tallyId,
                options.score,
                options.nuclide
            );

            if (!result.success || !result.port || !result.url) {
                throw new Error(result.error || 'Unknown error loading visualization');
            }
            
            // Update label with tally name if available
            const tallyName = result.tallyInfo?.name;
            const defaultName = `Tally ${options.tallyId}`;
            if (tallyName && tallyName !== defaultName && !tallyName.match(/^Tally\s+\d+$/i)) {
                widget.title.label = `OpenMC Tally ${options.tallyId}: ${tallyName}`;
                if (options.score) {
                    widget.title.label += ` (${options.score})`;
                }
            }

            // Complete loading by setting server URL
            completeLoading(result.port, result.url);

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
            // Create unique suffix for source visualization
            const uniqueSuffix = `source:${Date.now()}`;
            
            // Create widget immediately with loading state
            const { widget, completeLoading } = await this.createVisualizerWidgetLoading(
                sourceUri,
                'OpenMC Source Distribution',
                uniqueSuffix,
                'Loading source distribution...'
            );

            const sourcePath = sourceUri.path.toString();
            const result = await this.openmcBackend.visualizeSource(sourcePath);

            if (!result.success || !result.port || !result.url) {
                throw new Error(result.error || 'Unknown error loading source');
            }

            // Complete loading by setting server URL
            completeLoading(result.port, result.url);

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
            // Create unique suffix for overlay visualization
            const uniqueSuffix = `overlay:${options.tallyId}:${options.score || 'default'}:${Date.now()}`;
            
            let label = `Tally ${options.tallyId}`;
            if (options.score) {
                label += ` (${options.score})`;
            }
            label += ' on Geometry';
            
            // Create widget immediately with loading state - use geometry as the main file
            const { widget, completeLoading } = await this.createVisualizerWidgetLoading(
                geometryUri,  // Use geometry as main file for the widget
                label,
                uniqueSuffix,
                `Loading tally ${options.tallyId} on geometry...`
            );

            const geometryPath = geometryUri.path.toString();
            const statepointPath = statepointUri.path.toString();

            const result = await this.openmcBackend.visualizeTallyOnGeometry(
                geometryPath,
                statepointPath,
                options.tallyId,
                options.score,
                options.filterGraveyard !== false  // default to true
            );

            if (!result.success || !result.port || !result.url) {
                throw new Error(result.error || 'Unknown error loading overlay');
            }

            // Update label with tally name if available
            const tallyName = result.tallyInfo?.name;
            const defaultName = `Tally ${options.tallyId}`;
            if (tallyName && tallyName !== defaultName && !tallyName.match(/^Tally\s+\d+$/i)) {
                widget.title.label = `Tally ${options.tallyId}: ${tallyName}`;
                if (options.score) {
                    widget.title.label += ` (${options.score})`;
                }
                widget.title.label += ' on Geometry';
            }

            // Complete loading by setting server URL
            completeLoading(result.port, result.url);

            if (result.tallyInfo) {
                this._onTallyVisualized.fire(result.tallyInfo);
            }

            // Note: Spatial warning (if any) was already shown immediately via RPC
            // The warning appears as soon as Python outputs it, not at the end
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
     * Get 2D heatmap slice data for a mesh tally.
     */
    async getHeatmapSlice(
        statepointUri: URI,
        tallyId: number,
        plane: OpenMCHeatmapPlane,
        sliceIndex: number,
        scoreIndex?: number,
        nuclideIndex?: number
    ): Promise<OpenMCHeatmapData> {
        return this.openmcBackend.getHeatmapSlice(
            statepointUri.path.toString(),
            tallyId,
            plane,
            sliceIndex,
            scoreIndex,
            nuclideIndex
        );
    }

    /**
     * Get all 2D heatmap slices for a mesh tally (for animation).
     */
    async getAllHeatmapSlices(
        statepointUri: URI,
        tallyId: number,
        plane: OpenMCHeatmapPlane,
        scoreIndex?: number,
        nuclideIndex?: number
    ): Promise<OpenMCHeatmapData[]> {
        return this.openmcBackend.getAllHeatmapSlices(
            statepointUri.path.toString(),
            tallyId,
            plane,
            scoreIndex,
            nuclideIndex
        );
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
     * Can be called with loading state first, then server URL set later.
     */
    private async createVisualizerWidget(
        fileUri: URI,
        label: string,
        widgetId?: string,
        serverInfo?: { port: number; url: string },
        loadingMessage?: string
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
        
        // If loading message provided and no server URL yet, show loading state
        if (loadingMessage && !serverInfo) {
            (widget as any).statusMessage = loadingMessage;
            widget.update();
        }
        
        // Set server URL if provided (marks end of loading)
        if (serverInfo) {
            widget.setServerUrl(serverInfo.url, serverInfo.port);
        }
        
        // Add widget to main area and activate it
        await this.shell.addWidget(widget, { area: 'main' });
        await this.shell.activateWidget(widget.id);
        
        return widget;
    }
    
    /**
     * Create a visualizer widget in loading state.
     * Returns the widget and a function to complete loading once server is ready.
     */
    private async createVisualizerWidgetLoading(
        fileUri: URI,
        label: string,
        widgetId: string,
        loadingMessage: string
    ): Promise<{ widget: VisualizerWidget; completeLoading: (port: number, url: string) => void }> {
        const widget = await this.createVisualizerWidget(
            fileUri,
            label,
            widgetId,
            undefined,  // no server info yet (loading state)
            loadingMessage
        );
        
        const completeLoading = (port: number, url: string) => {
            widget.setServerUrl(url, port);
        };
        
        return { widget, completeLoading };
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
            // Add cross-section path from nuke-core if not already set
            if (!request.crossSectionsPath) {
                const corePath = this.nukeCoreService.getCrossSectionsPath();
                if (corePath) {
                    request.crossSectionsPath = corePath;
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

    // =========================================================================
    // Depletion/Burnup Methods
    // =========================================================================

    /**
     * Get summary information from depletion results file.
     */
    async getDepletionSummary(fileUri: URI): Promise<any> {
        try {
            return await this.openmcBackend.getDepletionSummary(fileUri.path.toString());
        } catch (error) {
            this.messageService.error(`Failed to load depletion summary: ${error}`);
            throw error;
        }
    }

    /**
     * Get list of materials from depletion results.
     */
    async getDepletionMaterials(fileUri: URI): Promise<any[]> {
        try {
            return await this.openmcBackend.getDepletionMaterials(fileUri.path.toString());
        } catch (error) {
            this.messageService.error(`Failed to load depletion materials: ${error}`);
            throw error;
        }
    }

    /**
     * Get depletion data for a specific material.
     */
    async getDepletionData(
        fileUri: URI,
        materialIndex: number,
        nuclides?: string[]
    ): Promise<any> {
        try {
            return await this.openmcBackend.getDepletionData(
                fileUri.path.toString(),
                materialIndex,
                nuclides,
                false  // includeActivity - can be added later
            );
        } catch (error) {
            this.messageService.error(`Failed to load depletion data: ${error}`);
            throw error;
        }
    }

    /**
     * Check if a file is a depletion results file.
     */
    isDepletionFile(fileName: string): boolean {
        return fileName.includes('depletion') && fileName.endsWith('.h5');
    }

    // === Geometry Hierarchy Viewer ===

    /**
     * Get geometry hierarchy from OpenMC geometry file.
     */
    async getGeometryHierarchy(fileUri: URI): Promise<any> {
        try {
            const result = await this.openmcBackend.getGeometryHierarchy(fileUri.path.toString());
            return result;
        } catch (error) {
            this.messageService.error(`Failed to load geometry hierarchy: ${error}`);
            throw error;
        }
    }

    /**
     * Visualize geometry in 3D.
     */
    async visualizeGeometry(fileUri: URI, highlightCellIds?: number[], overlaps?: any[]): Promise<{ success: boolean; port?: number; url?: string; error?: string }> {
        try {
            return await this.openmcBackend.visualizeGeometry(fileUri.path.toString(), highlightCellIds, overlaps);
        } catch (error) {
            this.messageService.error(`Failed to visualize geometry: ${error}`);
            return { success: false, error: String(error) };
        }
    }

    /**
     * Open geometry in a new Visualizer widget (for Material Explorer cell linkage).
     */
    async openGeometryViewer(fileUri: URI, highlightCellIds?: number[], overlaps?: any[]): Promise<VisualizerWidget | null> {
        const available = await this.checkAvailability();
        if (!available) {
            return null;
        }

        try {
            const hasOverlaps = overlaps && overlaps.length > 0;
            const hasHighlights = highlightCellIds && highlightCellIds.length > 0;
            
            // Overlaps are limited to 1000 for performance on backend
            const MAX_OVERLAPS = 1000;
            const overlapDisplayCount = hasOverlaps ? Math.min(overlaps.length, MAX_OVERLAPS) : 0;

            // Create unique suffix for geometry visualization
            let uniqueSuffix = `geometry:${Date.now()}`;
            if (hasOverlaps) {
                uniqueSuffix = `geometry:overlaps:${Date.now()}`;
            } else if (hasHighlights) {
                uniqueSuffix = `geometry:highlight:${highlightCellIds.join('_')}:${Date.now()}`;
            }
            
            let label = 'OpenMC Geometry';
            if (hasOverlaps) {
                label = 'OpenMC Geometry Overlaps';
            } else if (hasHighlights) {
                label = highlightCellIds.length === 1 
                    ? `OpenMC Geometry (Cell ${highlightCellIds[0]})`
                    : `OpenMC Geometry (${highlightCellIds.length} cells)`;
            }
            
            const loadingMessage = hasOverlaps
                ? (overlaps.length > MAX_OVERLAPS 
                    ? `Loading geometry with ${overlapDisplayCount} of ${overlaps.length} overlap markers...`
                    : `Loading geometry with ${overlaps.length} overlap markers...`)
                : (hasHighlights ? `Loading geometry and highlighting ${highlightCellIds.length} cell(s)...` : 'Loading geometry...');
            
            // Create widget immediately with loading state
            const { widget, completeLoading } = await this.createVisualizerWidgetLoading(
                fileUri,
                label,
                uniqueSuffix,
                loadingMessage
            );

            const result = await this.openmcBackend.visualizeGeometry(fileUri.path.toString(), highlightCellIds, overlaps);

            if (!result.success || !result.port || !result.url) {
                throw new Error(result.error || 'Unknown error loading geometry');
            }

            // Complete loading by setting server URL
            completeLoading(result.port, result.url);

            this.messageService.info(hasHighlights 
                ? `Loaded geometry with ${highlightCellIds!.length} cell(s) highlighted`
                : 'Loaded geometry visualization'
            );
            return widget;

        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.messageService.error(`Failed to visualize geometry: ${msg}`);
            return null;
        }
    }

    // === Statepoint Viewer ===

    private currentStatepointFull: any = null;

    /**
     * Load full statepoint information for the Statepoint Viewer.
     */
    async loadStatepointFull(statepointUri: URI): Promise<any> {
        const available = await this.checkAvailability();
        if (!available) {
            return null;
        }

        try {
            const statepointPath = statepointUri.path.toString();
            const info = await this.openmcBackend.getStatepointFullInfo(statepointPath);
            
            this.currentStatepointFull = info;
            this.currentStatepoint = {
                file: statepointPath,
                batches: info.nBatches,
                generationsPerBatch: info.generationsPerBatch,
                kEff: info.kCombined?.[0],
                kEffStd: info.kCombined?.[1],
                nTallies: info.tallies.length,
                tallyIds: info.tallies.map((t: any) => t.id)
            };
            this.currentTallies = info.tallies;
            
            this._onStatepointLoaded.fire(this.currentStatepoint);
            
            return info;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.messageService.error(`Failed to load statepoint info: ${msg}`);
            return null;
        }
    }

    /**
     * Get the currently loaded full statepoint info.
     */
    getCurrentStatepointFull(): any {
        return this.currentStatepointFull;
    }

    /**
     * Get k-generation data for convergence plot.
     */
    async getKGenerationData(statepointUri: URI): Promise<any> {
        try {
            return await this.openmcBackend.getKGenerationData(statepointUri.path.toString());
        } catch (error) {
            console.error('[OpenMC] Error getting k-generation data:', error);
            return null;
        }
    }

    /**
     * Get source particle data for visualization.
     */
    async getSourceData(statepointUri: URI, maxParticles?: number): Promise<any> {
        try {
            return await this.openmcBackend.getSourceData(
                statepointUri.path.toString(),
                maxParticles
            );
        } catch (error) {
            console.error('[OpenMC] Error getting source data:', error);
            return null;
        }
    }

    /**
     * Get energy distribution histogram.
     */
    async getEnergyDistribution(statepointUri: URI, nBins?: number): Promise<any> {
        try {
            return await this.openmcBackend.getEnergyDistribution(
                statepointUri.path.toString(),
                nBins
            );
        } catch (error) {
            console.error('[OpenMC] Error getting energy distribution:', error);
            return null;
        }
    }

    /**
     * Visualize source distribution from statepoint file.
     */
    async visualizeStatepointSource(statepointUri: URI): Promise<VisualizerWidget | null> {
        const available = await this.checkAvailability();
        if (!available) {
            return null;
        }

        try {
            // Create unique suffix for source visualization
            const uniqueSuffix = `statepoint-source:${Date.now()}`;
            
            // Create widget immediately with loading state
            const { widget, completeLoading } = await this.createVisualizerWidgetLoading(
                statepointUri,
                'OpenMC Source (from Statepoint)',
                uniqueSuffix,
                'Loading source distribution from statepoint...'
            );

            const result = await this.openmcBackend.visualizeStatepointSource(
                statepointUri.path.toString()
            );

            if (!result.success || !result.port || !result.url) {
                throw new Error(result.error || 'Unknown error loading source');
            }

            // Complete loading by setting server URL
            completeLoading(result.port, result.url);

            this.messageService.info('Loaded source distribution from statepoint');
            return widget;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.messageService.error(`Failed to visualize source: ${msg}`);
            return null;
        }
    }

    // === Material Explorer ===

    /**
     * Get materials from materials.xml file.
     */
    async getMaterials(fileUri: URI): Promise<any> {
        try {
            const result = await this.openmcBackend.getMaterials(fileUri.path.toString());
            return result;
        } catch (error) {
            this.messageService.error(`Failed to load materials: ${error}`);
            throw error;
        }
    }
    
    /**
     * Get mapping of materials to cells that use them.
     */
    async getMaterialCellLinkage(materialsUri: URI, geometryUri: URI): Promise<any> {
        try {
            const result = await this.openmcBackend.getMaterialCellLinkage(
                materialsUri.path.toString(),
                geometryUri.path.toString()
            );
            return result;
        } catch (error) {
            this.messageService.error(`Failed to load material-cell linkage: ${error}`);
            throw error;
        }
    }

    /**
     * Mix multiple materials into a new material.
     */
    async mixMaterials(request: {
        filePath: string;
        materialIds: number[];
        fractions: number[];
        percentType: 'ao' | 'wo' | 'vo';
        name?: string;
        id?: number;
    }): Promise<any> {
        try {
            const result = await this.openmcBackend.mixMaterials(request);
            return result;
        } catch (error) {
            this.messageService.error(`Failed to mix materials: ${error}`);
            throw error;
        }
    }

    /**
     * Add a material XML snippet to an existing materials.xml file.
     */
    async addMaterialToFile(filePath: string, materialXml: string): Promise<void> {
        try {
            await this.openmcBackend.addMaterial(filePath, materialXml);
            this.messageService.info(`Material added to ${new URI(filePath).path.base}`);
        } catch (error) {
            this.messageService.error(`Failed to add material: ${error}`);
            throw error;
        }
    }
    
    // === Geometry Overlap Checker ===

    /**
     * Check for geometry overlaps.
     */
    async checkOverlaps(
        geometryUri: URI,
        options: {
            samplePoints?: number;
            tolerance?: number;
            bounds?: { min: [number, number, number]; max: [number, number, number] };
            parallel?: boolean;
        } = {}
    ): Promise<{ overlaps: any[]; totalOverlaps: number; error?: string }> {
        const available = await this.checkOpenMCPythonAvailable();
        if (!available) {
            return { overlaps: [], totalOverlaps: 0, error: 'OpenMC Python module not available' };
        }

        try {
            const progress = await this.messageService.showProgress({
                text: 'Checking for geometry overlaps...',
                options: { cancelable: false }
            });

            const request = {
                geometryPath: geometryUri.path.toString(),
                samplePoints: options.samplePoints || 100000,
                tolerance: options.tolerance || 1e-6,
                bounds: options.bounds,
                parallel: options.parallel || false
            };

            const result = await this.openmcBackend.checkOverlaps(request);
            progress.cancel();

            if (result.error) {
                this.messageService.error(`Overlap check failed: ${result.error}`);
                return { overlaps: [], totalOverlaps: 0, error: result.error };
            }

            const overlapCount = result.totalOverlaps || result.overlaps?.length || 0;
            if (overlapCount > 0) {
                this.messageService.warn(`Found ${overlapCount} geometry overlap(s)`);
            } else {
                this.messageService.info('No geometry overlaps found');
            }

            return {
                overlaps: result.overlaps || [],
                totalOverlaps: overlapCount
            };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.messageService.error(`Failed to check overlaps: ${msg}`);
            return { overlaps: [], totalOverlaps: 0, error: msg };
        }
    }

    /**
     * Get visualization data for overlaps.
     */
    async getOverlapVisualization(geometryUri: URI, overlaps: any[]): Promise<any> {
        try {
            return await this.openmcBackend.getOverlapVisualization(
                geometryUri.path.toString(),
                overlaps
            );
        } catch (error) {
            this.messageService.error(`Failed to get overlap visualization: ${error}`);
            throw error;
        }
    }
    
    /**
     * Stop a running visualization server.
     */
    async stopServer(port: number | null): Promise<void> {
        if (port) {
            try {
                await this.openmcBackend.stopServer(port);
            } catch (error) {
                console.error(`[OpenMC] Error stopping server on port ${port}:`, error);
            }
        }
    }

    /**
     * Check if a file exists.
     */
    async checkFileExists(uri: URI): Promise<boolean> {
        try {
            const stat = await this.fileService.resolve(uri);
            return stat.isFile;
        } catch {
            return false;
        }
    }
}
