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

import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { MessageService } from '@theia/core/lib/common/message-service';
import { Emitter, Event } from '@theia/core/lib/common';
import URI from '@theia/core/lib/common/uri';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import {
    OpenMCBackendService,
    OpenMCStatepointInfo,
    OpenMCTallyInfo,
    OpenMCTallySeries,
    OpenMCTallySeriesOptions,
    XSPlotRequest,
    XSPlotData,
    XSGroupStructuresResponse,
    OpenMCHeatmapData,
    OpenMCHeatmapPlane,
    OpenMCSliceOptions,
    OpenMCKineticsResult,
    OPENMC_REQUIREMENTS
} from '../../../common/openmc-protocol';
import { VisualizerWidget } from '../../visualizer-widget';
import { WidgetManager, ApplicationShell, QuickInputService } from '@theia/core/lib/browser';
import { OpenMCMultiScoreData } from '../../plotly/plotly-utils';
import { VisualizerPreferences } from '../../visualizer-preferences';
import { NukeCoreService } from 'nuke-core/lib/common';
import { EnvironmentActionsHelper } from 'nuke-core/lib/browser/services';
import { HealthCheckFramework } from '../../services/health-check-framework';
import { OpenMCFileDiscoveryService } from './services/openmc-file-discovery';
import { GeometryNativeViewerWidget } from './widgets/geometry-native/geometry-native-viewer-widget';
import { TallyNativeViewerWidget } from './widgets/tally-native/tally-native-viewer-widget';
import { TallyOverlayKind, csgUnderlayCells } from './widgets/tally-native/tally-overlay-model';
import { DagmcViewerWidget } from './widgets/dagmc/dagmc-viewer-widget';
import { DagmcOutlineWidget } from '../../dagmc-outline/dagmc-outline-widget';
import { VisualizerBackendService } from '../../../common/base-visualizer-protocol';
import { parseNativeVtkXml, readVtkText } from './widgets/native-vtk/native-vtk-data';
import { parseGeometryNativeModel } from './widgets/geometry-native/geometry-native-model';

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
    /** Exclude the graveyard block from conversion when true (default false: always converted, toggled post-load in the DAGMC Outline) */
    filterGraveyard?: boolean;
    /** Whether to use pixelated (blocky) rendering (default: true) */
    pixelated?: boolean;
    /** Shared color range for a series step (applied as a custom range after the tally loads) */
    range?: readonly [number, number];
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

    @inject(VisualizerBackendService)
    protected readonly visualizerBackend: VisualizerBackendService;

    @inject(VisualizerPreferences)
    protected readonly preferences: VisualizerPreferences;

    @inject(NukeCoreService)
    protected readonly nukeCoreService: NukeCoreService;

    @inject(OpenMCFileDiscoveryService)
    protected readonly fileDiscovery: OpenMCFileDiscoveryService;

    @inject(EnvironmentActionsHelper)
    protected readonly envActions: EnvironmentActionsHelper;

    @inject(HealthCheckFramework)
    protected readonly healthFramework: HealthCheckFramework;

    @inject(QuickInputService)
    protected readonly quickInput: QuickInputService;

    private readonly _onStatepointLoaded = new Emitter<OpenMCStatepointInfo>();
    readonly onStatepointLoaded: Event<OpenMCStatepointInfo> = this._onStatepointLoaded.event;

    private readonly _onTallyVisualized = new Emitter<OpenMCTallyInfo>();
    readonly onTallyVisualized: Event<OpenMCTallyInfo> = this._onTallyVisualized.event;

    private currentStatepoint: OpenMCStatepointInfo | null = null;
    private currentTallies: OpenMCTallyInfo[] = [];

    @postConstruct()
    protected init(): void {
        // Register OpenMC health requirements
        this.healthFramework.registerHealthRequirements({
            id: 'openmc',
            name: 'OpenMC',
            packages: OPENMC_REQUIREMENTS
        });

        // Listen for environment changes from nuke-core
        this.nukeCoreService.onEnvironmentChanged((event) => {
            const envName = event.currentEnv?.name || 'unknown';
            console.log(`[OpenMC] Environment changed to ${envName}, clearing cached state`);

            // Only notify if there was actually a statepoint loaded
            if (this.currentStatepoint) {
                this.clearStatepoint();
                this.messageService.info(
                    `Environment changed to ${envName}. OpenMC state cleared — reload your statepoint to use the new environment.`
                );
            } else {
                this.clearStatepoint();
            }
        });

        this.nukeCoreService.onEnvironmentFallback((event) => {
            this.messageService.warn(
                `Using fallback environment ${event.fallbackEnv.name} for OpenMC operations. ` +
                    `Configured environment lacks required packages: ${event.requiredPackages.join(', ')}.`
            );
        });
    }

    /**
     * Ensure required OpenMC packages are installed in the configured environment.
     * Prompts the user with an Install action if packages are missing.
     * Uses the health check framework's registered requirements.
     */
    async ensureOpenMCPackages(): Promise<boolean> {
        const req = this.healthFramework.getRequirements('openmc');
        if (!req) {
            return true;
        }
        const result = await this.envActions.ensurePackages({
            requiredPackages: req.packages,
            title: `Install ${req.name} dependencies`
        });
        return result.success;
    }

    /**
     * Check if OpenMC integration is available.
     * If packages are missing, prompts the user to install them.
     */
    async checkAvailability(): Promise<boolean> {
        try {
            // First try the lightweight backend check
            const result = await this.openmcBackend.checkOpenMCAvailable();
            if (result.warning) {
                this.messageService.warn(result.warning);
            }
            if (result.available) {
                return true;
            }

            // If not available due to missing packages, offer to install
            if (result.message.includes('Missing packages') || result.message.includes('not installed')) {
                return await this.ensureOpenMCPackages();
            }

            this.messageService.warn(`OpenMC integration: ${result.message}`);
            return false;
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
                        tallyIds: tallies.map((t) => t.id)
                    };
                    console.log(`[OpenMC Service] Created minimal statepoint info with ${tallies.length} tallies`);
                }
            }

            console.log(`[OpenMC Service] Loaded ${tallies.length} tallies: ${tallies.map((t) => t.id).join(', ')}`);
            return tallies;
        } catch (error) {
            console.error('[OpenMC] Error loading tally list:', error);
            this.currentTallies = [];
            return [];
        }
    }

    /**
     * Read one tally/score across multiple statepoints (`openmc.tally-series`).
     */
    async getTallySeries(files: string[], options: OpenMCTallySeriesOptions): Promise<OpenMCTallySeries> {
        return this.openmcBackend.getTallySeries(files, options);
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
     * Create a tally tab instantly with a loading status, before any
     * conversion or file read runs, so the tab appears immediately instead
     * of popping in only once the backend finishes. Mirrors the DAGMC
     * instant-open (`beginPendingLoad`) pattern.
     */
    protected async createPendingTallyWidget(label: string, statusMessage: string): Promise<TallyNativeViewerWidget> {
        const widget = await this.widgetManager.getOrCreateWidget<TallyNativeViewerWidget>(TallyNativeViewerWidget.ID, {
            id: `${TallyNativeViewerWidget.ID}:${Date.now()}`
        } as any);
        widget.beginPendingLoad(label, statusMessage);
        if (!widget.isAttached) {
            this.shell.addWidget(widget, { area: 'main' });
        }
        await this.shell.activateWidget(widget.id);
        return widget;
    }

    /**
     * Load a converted tally/source/overlay VTK file into an already-opened
     * pending tally tab: `FileService.read` → native XML probe →
     * `setTallyText(kind)`. Conversion failure lands in the tab's error
     * panel instead of a toast-only dead end. The tab's probe/contour source
     * fields are seeded from the known context (never overwriting typing).
     */
    protected async loadTallyIntoWidget(
        widget: TallyNativeViewerWidget,
        vtkPath: string,
        kind: TallyOverlayKind,
        label: string,
        linkKey?: string,
        toolContext?: { statepointPath?: string; tallyId?: number; score?: string; nuclide?: string }
    ): Promise<TallyNativeViewerWidget> {
        try {
            const text = await readVtkText(this.fileService, new URI(vtkPath));
            // Probe the native XML reader first: non-XML datasets throw here and
            // take the trame fallback in the caller — the parser stays XML-only.
            await parseNativeVtkXml(text);
            await widget.setTallyText(text, kind);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            widget.failPendingLoad(message);
            throw error;
        }
        widget.title.label = label;
        widget.title.caption = label;
        if (toolContext) {
            widget.seedToolContext(toolContext);
        }
        // Camera-link identity: converted text loads carry no file, so key
        // every tally tab by its source file — mesh/contour/probe tabs of one
        // statepoint link, other files never do.
        if (linkKey !== undefined) {
            widget.setCameraLinkKey(linkKey);
        }
        // Every tally tab can spawn contour siblings: the callback routes
        // through this same funnel, so contour tabs inherit the native-base
        // warp/threshold funnels with no extra wiring.
        widget.setContourOpener(async (contourPath: string, contourLabel: string) => {
            await this.openTallyNativeWidget(contourPath, 'overlay', contourLabel);
        });
        return widget;
    }

    /**
     * Open a converted tally/source/overlay VTK file in the native tally
     * viewer. The tab opens instantly with a loading status; the converted
     * file is read and parsed afterwards. Throws on any failure (already
     * surfaced in-tab); callers surface the error instead of starting
     * a server.
     */
    protected async openTallyNativeWidget(
        vtkPath: string,
        kind: TallyOverlayKind,
        label: string,
        linkKey?: string,
        toolContext?: { statepointPath?: string; tallyId?: number; score?: string; nuclide?: string }
    ): Promise<TallyNativeViewerWidget> {
        const widget = await this.createPendingTallyWidget(label, 'Loading tally dataset…');
        return this.loadTallyIntoWidget(widget, vtkPath, kind, label, linkKey, toolContext);
    }

    /**
     * Stop all running OpenMC Python servers.
     */
    async stopAllServers(): Promise<void> {
        // Get all OpenMC widgets in the main area and stop their servers
        const widgets = this.shell.getWidgets('main');
        for (const widget of widgets) {
            if (widget instanceof VisualizerWidget) {
                // Widgets track their own server ports; we can't directly stop them from here
                // without port tracking. For now, the backend service handles process lifecycle.
                // Future: track active ports in this service.
            }
        }
    }

    /**
     * Visualize a mesh tally from a statepoint file.
     */
    async visualizeMeshTally(
        statepointUri: URI,
        options: TallyVisualizationOptions
    ): Promise<VisualizerWidget | TallyNativeViewerWidget | null> {
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

            // Native-only: convert to .vti and render without a server; the
            // tab opens instantly with a loading status while the
            // conversion runs. Any conversion/parse failure lands in the
            // tab's error panel instead of starting a server.
            const statepointPath = statepointUri.path.toString();
            const pendingWidget = await this.createPendingTallyWidget(label, 'Converting tally mesh…');
            try {
                const conversion = await this.openmcBackend.convertTallyMeshToVtk(statepointPath, {
                    tallyId: options.tallyId,
                    score: options.score,
                    nuclide: options.nuclide
                });
                if (!conversion.success || !conversion.vtkPath) {
                    throw new Error(conversion.error || 'Tally conversion failed');
                }
                const nativeWidget = await this.loadTallyIntoWidget(pendingWidget, conversion.vtkPath, 'mesh', label, statepointPath, {
                    statepointPath,
                    tallyId: options.tallyId,
                    score: options.score,
                    nuclide: options.nuclide
                });
                if (options.range) {
                    nativeWidget.applyProps({ rangeMode: 'custom', customRange: [options.range[0], options.range[1]] });
                }
                const tallyInfo = this.currentTallies.find((t) => t.id === options.tallyId);
                if (tallyInfo) {
                    this._onTallyVisualized.fire(tallyInfo);
                }
                this.messageService.info(`Loaded mesh tally ${options.tallyId} natively`);
                return nativeWidget;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                pendingWidget.failPendingLoad(message);
                this.messageService.error(`Failed to visualize mesh tally: ${message}`);
                return pendingWidget;
            }
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
    async visualizeSource(sourceUri: URI): Promise<VisualizerWidget | TallyNativeViewerWidget | null> {
        const available = await this.checkAvailability();
        if (!available) {
            return null;
        }

        try {
            // Native-only: convert to .vtp points and render without a
            // server; the tab opens instantly with a loading status while
            // the conversion runs. Any conversion/parse failure lands in
            // the tab's error panel instead of starting a server.
            const pendingWidget = await this.createPendingTallyWidget('OpenMC Source Distribution', 'Converting source…');
            try {
                const conversion = await this.openmcBackend.convertSourceToVtk(sourceUri.path.toString(), {});
                if (!conversion.success || !conversion.vtkPath) {
                    throw new Error(conversion.error || 'Source conversion failed');
                }
                const nativeWidget = await this.loadTallyIntoWidget(
                    pendingWidget,
                    conversion.vtkPath,
                    'source',
                    'OpenMC Source Distribution',
                    sourceUri.path.toString()
                );
                this.messageService.info('Loaded source distribution natively');
                return nativeWidget;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                pendingWidget.failPendingLoad(message);
                this.messageService.error(`Failed to visualize source: ${message}`);
                return pendingWidget;
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.messageService.error(`Failed to visualize source: ${msg}`);
            return null;
        }
    }

    /**
     * Overlay tally results on geometry: with a DAGMC `.h5m` geometry the
     * tally mesh is draped onto the geometry volumes (multiblock `.vtm`
     * painted per-triangle) and opened in the native DAGMC viewer with
     * volume isolation and instant color-by on the tally array; any other
     * geometry opens the full tally mesh itself (.vti voxel blocks,
     * clip-explorable) with the ghosted CSG cells underlaid for context.
     */
    async visualizeTallyOnGeometry(
        geometryUri: URI,
        statepointUri: URI,
        options: TallyVisualizationOptions
    ): Promise<VisualizerWidget | TallyNativeViewerWidget | DagmcViewerWidget | null> {
        const available = await this.checkAvailability();
        if (!available) {
            return null;
        }

        try {
            let label = `Tally ${options.tallyId}`;
            if (options.score) {
                label += ` (${options.score})`;
            }
            label += ' on Geometry';

            if (geometryUri.path.toString().toLowerCase().endsWith('.h5m')) {
                return await this.visualizeTallyDrapedOnDagmc(geometryUri, statepointUri, options, label);
            }

            // Without a DAGMC geometry there is nothing to drape onto: open
            // the full mesh itself (.vti voxel blocks, clip-explorable)
            // instead of a cell-center cloud. The tab opens instantly with
            // a loading status while the conversion runs; conversion/parse
            // failure lands in the tab's error panel instead of starting a
            // server.
            const pendingWidget = await this.createPendingTallyWidget(label, 'Converting tally overlay…');
            try {
                const conversion = await this.openmcBackend.convertTallyMeshToVtk(statepointUri.path.toString(), {
                    tallyId: options.tallyId,
                    score: options.score,
                    nuclide: options.nuclide
                });
                if (!conversion.success || !conversion.vtkPath) {
                    throw new Error(conversion.error || 'Overlay conversion failed');
                }
                const nativeWidget = await this.loadTallyIntoWidget(
                    pendingWidget,
                    conversion.vtkPath,
                    'mesh',
                    label,
                    statepointUri.path.toString(),
                    {
                        statepointPath: statepointUri.path.toString(),
                        tallyId: options.tallyId,
                        score: options.score,
                        nuclide: options.nuclide
                    }
                );
                await this.attachCsgUnderlay(nativeWidget, geometryUri);
                return nativeWidget;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                pendingWidget.failPendingLoad(message);
                this.messageService.error(`Failed to overlay tally: ${message}`);
                return pendingWidget;
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.messageService.error(`Failed to overlay tally: ${msg}`);
            return null;
        }
    }

    /**
     * Ghost the CSG cells under an overlay tally (non-DAGMC path): extract
     * the geometry mesh and hand the cells to the tally widget's underlay.
     * Best-effort — extraction failure leaves the tally up with a message
     * naming the cause instead of failing the overlay.
     */
    protected async attachCsgUnderlay(widget: TallyNativeViewerWidget, geometryUri: URI): Promise<void> {
        try {
            const mesh = await this.openmcBackend.extractGeometryMesh(geometryUri.path.toString());
            if (!mesh.success || !mesh.meshPath) {
                throw new Error(mesh.error || 'Mesh extraction failed');
            }
            const text = await readVtkText(this.fileService, new URI(mesh.meshPath));
            const model = parseGeometryNativeModel(JSON.parse(text));
            const underlaid = csgUnderlayCells(model.cells);
            widget.setGeometryUnderlayCells(underlaid);
            this.messageService.info(`Loaded tally mesh on geometry natively (${underlaid.length} CSG cells underlaid)`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn('[OpenMCService] CSG underlay unavailable:', message);
            this.messageService.info(`Loaded tally mesh on geometry natively (geometry underlay unavailable: ${message})`);
        }
    }

    /**
     * True 3D tally-on-DAGMC drape: convert the mesh tally onto the `.h5m`
     * volumes and open the painted manifest in the native DAGMC viewer
     * (volume/material/group toggles via `dagmc.info`, tally color-by by
     * default). The outline sidebar reveals without stealing focus.
     */
    protected async visualizeTallyDrapedOnDagmc(
        geometryUri: URI,
        statepointUri: URI,
        options: TallyVisualizationOptions,
        label: string
    ): Promise<DagmcViewerWidget | null> {
        let widget: DagmcViewerWidget | undefined;
        try {
            const h5mPath = geometryUri.path.toString();
            const smooth = options.pixelated === false;
            // The drape tab opens instantly with a loading status while the
            // overlay conversion runs (same instant-open as `.h5m` file opens).
            widget = await this.widgetManager.getOrCreateWidget<DagmcViewerWidget>(DagmcViewerWidget.ID, {
                id: `${DagmcViewerWidget.ID}:drape:${Date.now()}`
            });
            widget.beginPendingLoad(label, `Converting tally overlay…`, h5mPath);
            if (!widget.isAttached) {
                this.shell.addWidget(widget, { area: 'main' });
            }
            await this.shell.activateWidget(widget.id);
            const conversion = await this.openmcBackend.convertOverlayGeometryToVtk(statepointUri.path.toString(), h5mPath, {
                tallyId: options.tallyId,
                score: options.score,
                nuclide: options.nuclide,
                // Graveyard always converts (Outline toggles it post-load);
                // only an explicit filter opt-out excludes it.
                includeGraveyard: options.filterGraveyard !== true,
                smooth
            });
            if (!conversion.success || !conversion.vtkPath) {
                throw new Error(conversion.error || 'Overlay conversion failed');
            }
            widget.h5mSourcePath = h5mPath;
            await widget.setVtmFile(new URI(conversion.vtkPath));
            try {
                widget.setModelInfo(await this.visualizerBackend.getDagmcInfo(h5mPath));
            } catch (error) {
                console.warn(
                    `[openmc-service] dagmc.info failed for ${h5mPath} — volume toggles unavailable:`,
                    error instanceof Error ? error.message : error
                );
            }
            // Tally mesh interior (hollow shells clip to empty space without
            // it); a mesh failure only drops the volume, never the drape.
            try {
                const meshConversion = await this.openmcBackend.convertTallyMeshToVtk(statepointUri.path.toString(), {
                    tallyId: options.tallyId,
                    score: options.score,
                    nuclide: options.nuclide
                });
                if (meshConversion.success && meshConversion.vtkPath) {
                    await widget.setTallyVolumeFile(new URI(meshConversion.vtkPath));
                }
            } catch (error) {
                console.warn(
                    '[openmc-service] tally mesh volume failed — drape surfaces only:',
                    error instanceof Error ? error.message : error
                );
            }
            if (conversion.arrayName) {
                // Smooth drapes store the tally as point data (GPU-blended
                // vertices); pixelated drapes store it as cell data (flat
                // per-triangle). Prefer the backend-reported association,
                // falling back to the requested rendering style.
                const association = conversion.arrayAssociation ?? (options.pixelated === false ? 'point' : 'cell');
                const candidates =
                    association === 'point'
                        ? [`Point: ${conversion.arrayName}`, `Cell: ${conversion.arrayName}`]
                        : [`Cell: ${conversion.arrayName}`, `Point: ${conversion.arrayName}`];
                const available = widget.colorByOptions().map((option) => option.value);
                const colorBy = candidates.find((candidate) => available.some((option) => option === candidate));
                if (colorBy) {
                    widget.applyProps({ colorBy });
                } else {
                    // Never silent: a missing option means the backend sent
                    // an array the viewer cannot see (stale backend build is
                    // the usual cause — it lacks the hoisted arrayName).
                    console.warn(
                        `[openmc-service] drape array '${conversion.arrayName}' not in color-by options ` +
                            `(${widget
                                .colorByOptions()
                                .map((option) => option.value)
                                .join(', ')})`
                    );
                }
            } else {
                console.warn('[openmc-service] drape conversion returned no arrayName — check the backend build');
            }
            widget.title.label = label;
            const outline = await this.widgetManager.getOrCreateWidget(DagmcOutlineWidget.ID);
            if (!outline.isAttached) {
                await this.shell.addWidget(outline, { area: 'right' });
            }
            await this.shell.revealWidget(outline.id);
            await this.shell.activateWidget(widget.id);
            this.messageService.info('Loaded tally overlay on DAGMC geometry natively');
            return widget;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            widget?.failPendingLoad(`Overlay conversion failed: ${message}`);
            this.messageService.error(`Failed to overlay tally: ${message}`);
            return widget ?? null;
        }
    }

    /**
     * Overlay tally results on geometry using slice-based visualization.
     */
    async visualizeTallySlice(
        geometryUri: URI,
        statepointUri: URI,
        options: TallyVisualizationOptions,
        sliceOptions: OpenMCSliceOptions
    ): Promise<VisualizerWidget | TallyNativeViewerWidget | null> {
        const available = await this.checkAvailability();
        if (!available) {
            return null;
        }

        try {
            let label = `Tally ${options.tallyId}`;
            if (options.score) {
                label += ` (${options.score})`;
            }
            label += ` Slice (${sliceOptions.plane.toUpperCase()})`;

            // Native-only: static slice cloud without a server; the tab
            // opens instantly with a loading status while the conversion
            // runs. Any conversion/parse failure lands in the tab's error
            // panel instead of starting a server.
            const pendingWidget = await this.createPendingTallyWidget(label, 'Converting tally slice…');
            try {
                const conversion = await this.openmcBackend.convertOverlayToVtk(statepointUri.path.toString(), {
                    tallyId: options.tallyId,
                    score: options.score,
                    nuclide: options.nuclide,
                    mode: 'slice',
                    plane: sliceOptions.plane,
                    position: sliceOptions.position,
                    resolution: sliceOptions.resolution,
                    pixelated: sliceOptions.pixelated
                });
                if (!conversion.success || !conversion.vtkPath) {
                    throw new Error(conversion.error || 'Slice conversion failed');
                }
                const nativeWidget = await this.loadTallyIntoWidget(
                    pendingWidget,
                    conversion.vtkPath,
                    'slice',
                    label,
                    statepointUri.path.toString(),
                    {
                        statepointPath: statepointUri.path.toString(),
                        tallyId: options.tallyId,
                        score: options.score,
                        nuclide: options.nuclide
                    }
                );
                this.messageService.info(`Loaded tally slice on ${sliceOptions.plane.toUpperCase()} plane natively`);
                return nativeWidget;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                pendingWidget.failPendingLoad(message);
                this.messageService.error(`Failed to overlay tally slice: ${message}`);
                return pendingWidget;
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.messageService.error(`Failed to overlay tally slice: ${msg}`);
            return null;
        }
    }

    /**
     * Extract iso-surfaces from a mesh tally and open them as a sibling tab
     * next to the tally mesh: convert through `openmc.tally-contour`, then
     * route through the shared `openTallyNativeWidget` funnel (kind
     * `overlay`), so warp/threshold keep working on the contour through the
     * inherited native-base funnels. Conversion/parse failure surfaces an
     * error naming the cause instead of starting a server.
     */
    async visualizeTallyContour(
        statepointPath: string,
        options: { tallyId: number; score?: string; nuclide?: string; isoValues: number[]; smooth?: boolean }
    ): Promise<TallyNativeViewerWidget | null> {
        const label = `Tally ${options.tallyId} contour (${options.isoValues.join(', ')})`;
        const pendingWidget = await this.createPendingTallyWidget(label, 'Extracting contour surfaces…');
        try {
            const conversion = await this.openmcBackend.convertTallyContourToVtk(statepointPath, {
                tallyId: options.tallyId,
                score: options.score,
                nuclide: options.nuclide,
                isoValues: options.isoValues,
                smooth: options.smooth
            });
            if (!conversion.success || !conversion.vtkPath) {
                throw new Error(conversion.error || 'Contour conversion failed');
            }
            const nativeWidget = await this.loadTallyIntoWidget(pendingWidget, conversion.vtkPath, 'overlay', label, statepointPath);
            nativeWidget.setProbeContext({
                statepointPath,
                tallyId: options.tallyId,
                score: options.score,
                nuclide: options.nuclide
            });
            this.messageService.info(`Loaded tally contour (${options.isoValues.length} iso values) natively`);
            return nativeWidget;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            pendingWidget.failPendingLoad(message);
            this.messageService.error(`Failed to extract tally contour: ${message}`);
            return pendingWidget;
        }
    }

    /**
     * Get geometry bounds from DAGMC file.
     */
    async getGeometryBounds(geometryUri: URI): Promise<{ x: [number, number]; y: [number, number]; z: [number, number] } | undefined> {
        try {
            const geometryPath = geometryUri.path.toString();
            const result = await this.openmcBackend.getGeometryBounds(geometryPath);
            return result || undefined;
        } catch (e) {
            console.warn('[OpenMC] Could not get geometry bounds:', e);
            return undefined;
        }
    }

    /**
     * Prompt user for overlay visualization options (mode, slice options, pixelated).
     * The graveyard block is always converted and toggled post-load in the
     * DAGMC Outline (hidden by default), so no graveyard prompt is needed.
     * Returns the selected options or undefined if cancelled.
     */
    async promptOverlayOptions(
        geometryUri: URI,
        allowSlice: boolean = true
    ): Promise<
        | {
              mode: 'slice' | 'full';
              options: Pick<TallyVisualizationOptions, 'pixelated'>;
              sliceOptions?: OpenMCSliceOptions;
          }
        | undefined
    > {
        // 1. Mode selection
        let mode: 'slice' | 'full' = 'full';
        if (allowSlice) {
            const modeChoice = await this.quickInput.showQuickPick(
                [
                    { value: 'slice', label: '$(layers) Slice View', description: '2D slice with interpolated tally values' },
                    { value: 'full', label: '$(globe) Full 3D Overlay', description: 'Map tally values onto 3D geometry cells' }
                ],
                {
                    title: 'Visualization Mode',
                    placeholder: 'Choose visualization mode'
                }
            );
            if (!modeChoice) return undefined;
            mode = modeChoice.value as 'slice' | 'full';
        }

        // 2. Slice mode
        if (mode === 'slice') {
            const planeChoice = await this.quickInput.showQuickPick(
                [
                    { value: 'x', label: 'X Plane', description: 'YZ cross-section' },
                    { value: 'y', label: 'Y Plane', description: 'XZ cross-section' },
                    { value: 'z', label: 'Z Plane', description: 'XY cross-section' }
                ],
                {
                    title: 'Slice Plane',
                    placeholder: 'Select slice plane orientation'
                }
            );
            if (!planeChoice) return undefined;
            const plane = planeChoice.value as 'x' | 'y' | 'z';

            // Get geometry bounds for the selected plane
            const bounds = await this.getGeometryBounds(geometryUri);
            const axisBounds = bounds ? bounds[plane] : undefined;
            const boundsText = axisBounds
                ? `Geometry range: ${axisBounds[0].toFixed(2)} to ${axisBounds[1].toFixed(2)} cm`
                : 'Enter position in cm (leave empty for center)';
            const defaultPos = axisBounds ? ((axisBounds[0] + axisBounds[1]) / 2).toFixed(2) : '0';

            // Ask for slice position
            const positionInput = await this.quickInput.input({
                title: `Slice Position (${plane.toUpperCase()} axis)`,
                prompt: boundsText,
                placeHolder: `Default: ${defaultPos} (center)`
            });
            // Parse position, undefined means center
            let position: number | undefined;
            if (positionInput && positionInput.trim()) {
                const parsed = parseFloat(positionInput.trim());
                if (!isNaN(parsed)) {
                    position = parsed;
                }
            }

            const resChoice = await this.quickInput.showQuickPick(
                [
                    { value: '100', label: 'Low (100x100)', description: 'Fast, lower quality' },
                    { value: '200', label: 'Medium (200x200)', description: 'Balanced' },
                    { value: '400', label: 'High (400x400)', description: 'Good quality' },
                    { value: '800', label: 'Ultra (800x800)', description: 'Best quality, slower' }
                ],
                {
                    title: 'Slice Resolution',
                    placeholder: 'Select plane resolution'
                }
            );
            if (!resChoice) return undefined;

            const pixelChoice = await this.quickInput.showQuickPick(
                [
                    { value: 'smooth', label: '$(color-mode) Smooth Interpolation', description: 'Interpolated values between mesh cells' },
                    { value: 'pixelated', label: '$(symbol-array) Pixelated (Blocky)', description: 'Show actual mesh cell values' }
                ],
                {
                    title: 'Rendering Style',
                    placeholder: 'Select rendering style'
                }
            );
            if (!pixelChoice) return undefined;

            return {
                mode,
                options: { pixelated: pixelChoice.value === 'pixelated' } as TallyVisualizationOptions,
                sliceOptions: {
                    plane,
                    position,
                    resolution: parseInt(resChoice.value),
                    pixelated: pixelChoice.value === 'pixelated',
                    showGeometry: true
                }
            };
        }

        // 3. Full 3D mode: the graveyard block always converts (Outline
        // toggles it post-load), so only the rendering style is asked here.
        const pixelChoice = await this.quickInput.showQuickPick(
            [
                { value: 'smooth', label: '$(color-mode) Smooth Interpolation', description: 'Interpolated values between mesh cells' },
                { value: 'pixelated', label: '$(symbol-array) Pixelated (Blocky)', description: 'Show actual mesh cell values' }
            ],
            {
                title: 'Rendering Style',
                placeholder: 'Select rendering style'
            }
        );
        if (!pixelChoice) return undefined;

        return {
            mode,
            options: {
                pixelated: pixelChoice.value === 'pixelated'
            } as TallyVisualizationOptions
        };
    }

    /**
     * Overlay tally results on geometry with source particles.
     */
    async visualizeTallyAndSourceOnGeometry(
        geometryUri: URI,
        statepointUri: URI,
        options: TallyVisualizationOptions
    ): Promise<VisualizerWidget | TallyNativeViewerWidget | DagmcViewerWidget | null> {
        const available = await this.checkAvailability();
        if (!available) {
            return null;
        }

        try {
            // Route through the standard overlay (DAGMC drape for `.h5m`
            // geometries, mesh voxels otherwise), then layer the statepoint
            // source bank over it. Without a source bank the overlay alone
            // opens, matching the documented fallback.
            const widget = await this.visualizeTallyOnGeometry(geometryUri, statepointUri, options);
            if (!widget) {
                return null;
            }
            if (widget instanceof DagmcViewerWidget || widget instanceof TallyNativeViewerWidget) {
                try {
                    const conversion = await this.openmcBackend.convertSourceToVtk(statepointUri.path.toString(), {});
                    if (!conversion.success || !conversion.vtkPath) {
                        throw new Error(conversion.error || 'Source conversion failed');
                    }
                    await widget.setSourceFile(new URI(conversion.vtkPath));
                    this.messageService.info('Loaded tally overlay with source particles natively');
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    console.warn(`[openmc-service] source overlay skipped: ${message}`);
                    this.messageService.info('Loaded tally overlay natively (no source bank found)');
                }
                widget.title.label += ' + Source';
            }
            return widget;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.messageService.error(`Failed to overlay tally with source: ${msg}`);
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
    async getMultiScoreSpectrum(
        statepointUri: URI,
        tallyId: number,
        scores: string[],
        nuclide: string = 'total'
    ): Promise<OpenMCMultiScoreData> {
        const tally = this.currentTallies.find((t) => t.id === tallyId);
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
    async getMultiScoreSpatialPlot(
        statepointUri: URI,
        tallyId: number,
        axis: 'x' | 'y' | 'z',
        scores: string[],
        nuclide: string = 'total'
    ): Promise<OpenMCMultiScoreData> {
        const tally = this.currentTallies.find((t) => t.id === tallyId);
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
        return this.openmcBackend.getHeatmapSlice(statepointUri.path.toString(), tallyId, plane, sliceIndex, scoreIndex, nuclideIndex);
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
        return this.openmcBackend.getAllHeatmapSlices(statepointUri.path.toString(), tallyId, plane, scoreIndex, nuclideIndex);
    }

    /**
     * Discover OpenMC-related files in a directory.
     */
    async discoverFilesInDirectory(directoryUri: URI): Promise<OpenMCFileSet> {
        return this.fileDiscovery.discoverFilesInDirectory(directoryUri);
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

    // Widget creation delegated to OpenMCWidgetFactory

    /**
     * Get filter description for display.
     */
    getFilterDescription(filter: { type: string; bins: number; meshDimensions?: number[] }): string {
        return this.fileDiscovery.getFilterDescription(filter);
    }

    /**
     * Get a human-readable tally description.
     */
    getTallyDescription(tally: OpenMCTallyInfo): string {
        return this.fileDiscovery.getTallyDescription(tally);
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
            materials: materials.map((m) => ({
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
    async getDepletionData(fileUri: URI, materialIndex: number, nuclides?: string[]): Promise<any> {
        try {
            return await this.openmcBackend.getDepletionData(
                fileUri.path.toString(),
                materialIndex,
                nuclides,
                false // includeActivity - can be added later
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
     * Open geometry in the native geometry viewer (no server): extract the
     * CSG mesh headlessly, then load it into `GeometryNativeViewerWidget`.
     * The first highlighted cell (if any) is selected; overlap spheres have
     * no native equivalent — the marker list stays in the overlap widget
     * that opened this view.
     */
    async openGeometryViewer(fileUri: URI, highlightCellIds?: number[], overlaps?: any[]): Promise<GeometryNativeViewerWidget | null> {
        const available = await this.checkAvailability();
        if (!available) {
            return null;
        }

        try {
            const hasOverlaps = overlaps && overlaps.length > 0;
            const hasHighlights = highlightCellIds && highlightCellIds.length > 0;

            let label = 'OpenMC Geometry';
            if (hasOverlaps) {
                label = 'OpenMC Geometry Overlaps';
            } else if (hasHighlights) {
                label =
                    highlightCellIds.length === 1
                        ? `OpenMC Geometry (Cell ${highlightCellIds[0]})`
                        : `OpenMC Geometry (${highlightCellIds.length} cells)`;
            }

            const mesh = await this.openmcBackend.extractGeometryMesh(fileUri.path.toString());
            if (!mesh.success || !mesh.meshPath) {
                throw new Error(mesh.error || 'Mesh extraction failed');
            }

            const widget = await this.widgetManager.getOrCreateWidget<GeometryNativeViewerWidget>(GeometryNativeViewerWidget.ID, {
                id: `${GeometryNativeViewerWidget.ID}:${fileUri.toString()}`
            } as any);
            if (!widget.isAttached) {
                await this.shell.addWidget(widget, { area: 'main' });
            }
            await this.shell.activateWidget(widget.id);
            await widget.setModelFile(new URI(mesh.meshPath));
            if (hasHighlights) {
                widget.selectCell(highlightCellIds[0]);
            }
            widget.title.label = label;

            this.messageService.info(
                hasOverlaps
                    ? 'Loaded geometry natively (markers stay in the overlap list; first overlapping cell selected)'
                    : hasHighlights
                      ? `Loaded geometry with cell ${highlightCellIds![0]} highlighted`
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
     * Get IFP kinetics parameters (β_eff, Λ_eff) from a statepoint.
     * Returns `{ data }` on success, `{ error }` on failure — callers render
     * the error inline (no messageService popup).
     */
    async getKineticsParameters(statepointUri: URI): Promise<{ data?: OpenMCKineticsResult; error?: string }> {
        try {
            const data = await this.openmcBackend.getKineticsParameters(statepointUri.path.toString());
            return { data };
        } catch (error) {
            console.error('[OpenMC] Error getting kinetics parameters:', error);
            return { error: error instanceof Error ? error.message : String(error) };
        }
    }

    /**
     * Get source particle data for visualization.
     */
    async getSourceData(statepointUri: URI, maxParticles?: number): Promise<any> {
        try {
            return await this.openmcBackend.getSourceData(statepointUri.path.toString(), maxParticles);
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
            return await this.openmcBackend.getEnergyDistribution(statepointUri.path.toString(), nBins);
        } catch (error) {
            console.error('[OpenMC] Error getting energy distribution:', error);
            return null;
        }
    }

    /**
     * Visualize source distribution from statepoint file.
     */
    async visualizeStatepointSource(statepointUri: URI): Promise<VisualizerWidget | TallyNativeViewerWidget | null> {
        const available = await this.checkAvailability();
        if (!available) {
            return null;
        }

        try {
            // Native-only: convert the statepoint source bank to .vtp points
            // and render without a server; the tab opens instantly with a
            // loading status while the conversion runs. Any
            // conversion/parse failure lands in the tab's error panel
            // instead of starting a server.
            const pendingWidget = await this.createPendingTallyWidget('OpenMC Source (from Statepoint)', 'Converting source…');
            try {
                const conversion = await this.openmcBackend.convertSourceToVtk(statepointUri.path.toString(), {});
                if (!conversion.success || !conversion.vtkPath) {
                    throw new Error(conversion.error || 'Source conversion failed');
                }
                const nativeWidget = await this.loadTallyIntoWidget(
                    pendingWidget,
                    conversion.vtkPath,
                    'source',
                    'OpenMC Source (from Statepoint)',
                    statepointUri.path.toString()
                );
                this.messageService.info('Loaded source distribution from statepoint natively');
                return nativeWidget;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                pendingWidget.failPendingLoad(message);
                this.messageService.error(`Failed to visualize source: ${message}`);
                return pendingWidget;
            }
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
            const result = await this.openmcBackend.getMaterialCellLinkage(materialsUri.path.toString(), geometryUri.path.toString());
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
            return await this.openmcBackend.getOverlapVisualization(geometryUri.path.toString(), overlaps);
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
