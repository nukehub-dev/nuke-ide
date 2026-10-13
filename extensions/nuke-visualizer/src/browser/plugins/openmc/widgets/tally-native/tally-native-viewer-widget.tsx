// *****************************************************************************
// Copyright (C) 2026 NukeHub and others.
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

import * as React from 'react';
import * as THREE from 'three';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { codicon } from '@theia/core/lib/browser/widgets/widget';
import { ThemeService } from '@theia/core/lib/browser/theming';
import { getThemeMode } from '@theia/core/lib/common/theme';
import { Emitter, Event } from '@theia/core/lib/common/event';
import { Disposable } from '@theia/core/lib/common/disposable';
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components';
import { boundingBoxFromPositions } from '../../../../viewer-core/clip-plane';
import { VolumeGrid } from '../../../../viewer-core/volume-raycast';
import { ViewerContextMenuItem } from '../../../../viewer-core/viewer-context-menu';
import { CsgOutlineHost, CsgOutlinePatch, CsgOutlineSnapshot } from '../../../../csg-outline/csg-outline-model';
import { NativeVtkViewerWidget } from '../native-vtk-viewer-widget';
import { OpenMCBackendService, OpenMCVtkArrayInfo } from '../../../../../common/openmc-protocol';
import type { OpenMCTallyLineProbeResult } from '../../../../../common/openmc-protocol';
import { CONTOUR_MAX_ISO_VALUES, describeContourRequest, formatContourIsoValues, parseContourIsoValues } from './tally-contour';
import {
    LINE_PROBE_DEFAULT_NPOINTS,
    LINE_PROBE_TABLE_ROW_CAP,
    clampProbeNpoints,
    defaultProbeEndpoints,
    describeLineProbeSeries,
    formatProbePoint,
    lineProbeToCsv,
    parseProbePoint
} from './tally-probe';
import type { LineProbeContext, ProbePoint3D } from './tally-probe';
import {
    SliceAxis,
    TallyOverlayKind,
    TALLY_UNDERLAY_MENU_ID,
    buildTallyUnderlayMenuItem,
    classifyTallyOverlayDataset,
    csgUnderlayCells,
    defaultOverlayColorBy,
    describeTallyOverlayDataset,
    isTallyOverlayKind,
    pointSizeForKind,
    smoothableGridDims,
    underlayGhostStrength
} from './tally-overlay-model';
import {
    GeometryNativeCell,
    cellDisplayName,
    cellEdgeColor,
    colorForCellOnTheme,
    isGeometryCellVisible,
    isVoidMaterial,
    materialNamesInOrder
} from '../geometry-native/geometry-native-model';

/**
 * Native tally mesh/overlay/source viewer widget (P3-D2): renders the three
 * `tally_viz.py` dataset kinds (`openmc.visualize-mesh` full-3D grids,
 * `openmc.visualize-overlay` slice or full-3D tally-on-geometry,
 * `openmc.visualize-source` / statepoint-source point clouds) plus the
 * static `slice_viz.py` slice files (F9) on the P1 three.js viewer — VTK
 * bytes arrive through `FileService`, parsing and instant color-by are
 * inherited, and this subclass only adds kind-aware defaults (dataset
 * classification, per-kind point-size preset, kind-preferred color-by).
 * No server, no restart.
 *
 * This widget is intentionally NOT wired into any contribution yet: the
 * parent phase registers the opener, feeds it the converted VTK paths, and
 * calls `setTallyText` (or `setVtkFile` + `setTallyKind`) per dataset.
 */
@injectable()
export class TallyNativeViewerWidget extends NativeVtkViewerWidget implements CsgOutlineHost {
    static override readonly ID: string = 'tally-native-viewer-widget';
    static override readonly LABEL: string = 'Native Tally Viewer';

    protected tallyKind: TallyOverlayKind = 'mesh';
    protected sliceAxis: SliceAxis | undefined;
    /** Cached smooth-volume grid (true 3D datasets only); recached per dataset. */
    protected smoothVolumeGrid: VolumeGrid | undefined;
    /** Ghosted CSG cells drawn under the tally dataset (overlay mode); empty disables the underlay. */
    protected underlayCells: GeometryNativeCell[] = [];
    /** Canvas-menu visibility switch for the underlay (independent of the loaded cells). */
    protected underlayVisible = true;
    /** Ghost strength follows the smooth raycast (dimmed while it draws); rebuilt only on change. */
    protected underlayDimmed = false;
    /** Per-cell hidden set for the underlay (outline eye buttons). */
    protected hiddenUnderlayCells: number[] = [];
    /** Per-material hidden set for the underlay (outline material rows). */
    protected hiddenUnderlayMaterials: string[] = [];
    /** Void edge-shells stay drawn by default (they are modeled parts, geometry-viewer parity). */
    protected showUnderlayVoid = true;
    /** Outline-side highlight for an underlay cell (panel→canvas; the canvas has no CSG picking). */
    protected selectedUnderlayCellId: number | null = null;
    private readonly outlineChanged = new Emitter<void>();
    readonly onDidChangeCsgOutline: Event<void> = this.outlineChanged.event;

    @inject(ThemeService)
    protected readonly themeService!: ThemeService;

    @inject(OpenMCBackendService)
    protected readonly openmcBackend!: OpenMCBackendService;

    /** Probe source context for this tab (set by the opener when known; manual entry otherwise). */
    protected probeContext: LineProbeContext | undefined;
    /** Bottom data-half panel visibility (toggled from the header). */
    protected probeOpen = false;
    protected probeStatepointPath = '';
    protected probeTallyId = '';
    protected probeScore = '';
    protected probeNuclide = '';
    protected probeP0 = '';
    protected probeP1 = '';
    protected probeNpoints = String(LINE_PROBE_DEFAULT_NPOINTS);
    /** True = trilinear smooth (overlay slice default); false = nearest-cell pixelated. */
    protected probeSmooth = true;
    protected probeLoading = false;
    protected probeError: string | undefined;
    protected probeResult: OpenMCTallyLineProbeResult | undefined;
    private probeToken = 0;

    /**
     * Sibling-tab opener for contour surfaces: set by the frontend service
     * when it opens this tab (calling back into `openTallyNativeWidget`,
     * never duplicating its routing). Storing a callback — not injecting
     * the frontend service — keeps the service→widget import one-way.
     */
    protected contourOpener: ((vtkPath: string, label: string) => Promise<unknown>) | undefined;
    /** Bottom data-half contour panel visibility (toggled from the header). */
    protected contourOpen = false;
    protected contourStatepointPath = '';
    protected contourTallyId = '';
    protected contourScore = '';
    protected contourNuclide = '';
    protected contourIso = '';
    /** True = interpolated edge crossings; false = midpoint-snapped pixelated cells. */
    protected contourSmooth = true;
    protected contourLoading = false;
    protected contourError: string | undefined;
    protected contourStatus: string | undefined;
    private contourToken = 0;

    @postConstruct()
    protected override init(): void {
        this.id = TallyNativeViewerWidget.ID;
        this.title.label = TallyNativeViewerWidget.LABEL;
        this.title.iconClass = codicon('graph-scatter');
        this.title.closable = true;
        this.node.tabIndex = 0;
        this.toDispose.push(
            this.themeService.onDidColorThemeChange(() => {
                if (!this.isDisposed && this.underlayCells.length > 0) {
                    this.rebuildUnderlay();
                    this.update();
                }
            })
        );
        this.toDispose.push(Disposable.create(() => this.outlineChanged.dispose()));
    }

    /** Notify the bound outline panel to re-read the snapshot. */
    protected fireCsgOutlineChanged(): void {
        this.outlineChanged.fire(undefined);
    }

    /** Dark treatment unless the active theme is explicitly light (geometry-viewer parity). */
    protected isDarkTheme(): boolean {
        try {
            return getThemeMode(this.themeService.getCurrentTheme().type) !== 'light';
        } catch {
            return true;
        }
    }

    /** Current dataset kind driving defaults and the header badge. */
    getTallyKind(): TallyOverlayKind {
        return this.tallyKind;
    }

    /**
     * Switch the dataset kind: applies the per-kind point-size preset and,
     * when a dataset is already loaded, re-picks the kind-preferred default
     * color-by. Instant — no reload, no server restart.
     */
    setTallyKind(kind: TallyOverlayKind): void {
        if (!isTallyOverlayKind(kind)) {
            return;
        }
        this.tallyKind = kind;
        this.sliceAxis = undefined;
        const pointSize = pointSizeForKind(kind);
        if (this.model) {
            const result = classifyTallyOverlayDataset(this.currentArrayInfos(), this.model.family, this.model.gridDimensions);
            this.sliceAxis = result.sliceAxis;
            this.applyProps({ colorBy: result.colorBy, pointSize });
        } else {
            this.applyProps({ pointSize });
        }
        this.update();
    }

    /**
     * Load already-read VTK XML text as a known dataset kind: parses through
     * the P1 path, then applies the kind default color-by and point size.
     */
    async setTallyText(text: string, kind: TallyOverlayKind): Promise<void> {
        this.tallyKind = isTallyOverlayKind(kind) ? kind : 'overlay';
        // Drop the cached grid first: the rebuild inside still sees the
        // previous dataset, and a stale grid would trip the fallback and
        // clobber a sticky smooth mode.
        this.smoothVolumeGrid = undefined;
        await super.setVtkText(text);
        this.smoothVolumeGrid = this.describeSmoothGrid();
        if (this.model) {
            const result = classifyTallyOverlayDataset(this.currentArrayInfos(), this.model.family, this.model.gridDimensions);
            // Keep the caller's kind (the file may predate the heuristic);
            // only the slice axis comes from the grid shape.
            this.sliceAxis = this.tallyKind === 'slice' && this.model.gridDimensions ? result.sliceAxis : undefined;
            this.applyProps({
                colorBy: defaultOverlayColorBy(this.tallyKind, result.classified, this.model.family),
                pointSize: pointSizeForKind(this.tallyKind)
            });
        }
        this.update();
    }

    protected override volumeSmoothGrid(): VolumeGrid | undefined {
        return this.smoothVolumeGrid;
    }

    /**
     * Probe source context for this tab: pre-fills the probe builder so a
     * run needs no typing. The panel keeps manual entry working when no
     * opener passes a context (statepoint path + tally id + score).
     */
    setProbeContext(context: LineProbeContext): void {
        this.probeContext = context;
        this.probeStatepointPath = context.statepointPath;
        // Contour tabs arrive through the generic opener funnel without a
        // link key: the context carries the statepoint path, so key the tab
        // for camera linking here (mesh tabs are keyed at open time).
        const linkKey = context.statepointPath.trim();
        if (linkKey !== '') {
            this.setCameraLinkKey(linkKey);
        }
        this.probeTallyId = String(context.tallyId);
        if (context.score !== undefined) {
            this.probeScore = context.score;
        }
        if (context.nuclide !== undefined) {
            this.probeNuclide = context.nuclide;
        }
        this.update();
    }

    /** Toggle the bottom probe panel, seeding endpoints from the dataset bounds on first open. */
    protected toggleProbePanel(): void {
        this.probeOpen = !this.probeOpen;
        if (this.probeOpen && (this.probeP0 === '' || this.probeP1 === '') && this.model) {
            const bounds = boundingBoxFromPositions(this.model.positions);
            const { p0, p1 } = defaultProbeEndpoints(
                bounds
                    ? {
                          min: [bounds.min[0], bounds.min[1], bounds.min[2]] as ProbePoint3D,
                          max: [bounds.max[0], bounds.max[1], bounds.max[2]] as ProbePoint3D
                      }
                    : undefined
            );
            if (this.probeP0 === '') {
                this.probeP0 = formatProbePoint(p0);
            }
            if (this.probeP1 === '') {
                this.probeP1 = formatProbePoint(p1);
            }
        }
        this.update();
    }

    /** Run `openmc.tally-line-probe` for the builder inputs; validation errors stay inline, never thrown. */
    protected async runLineProbe(): Promise<void> {
        const token = ++this.probeToken;
        const statepointPath = this.probeStatepointPath.trim();
        const tallyId = Number(this.probeTallyId);
        const p0 = parseProbePoint(this.probeP0);
        const p1 = parseProbePoint(this.probeP1);
        const npoints = clampProbeNpoints(Number(this.probeNpoints));
        this.probeNpoints = String(npoints);
        const score = this.probeScore.trim() || undefined;
        const nuclide = this.probeNuclide.trim() || undefined;
        if (!statepointPath) {
            this.probeError = 'Enter a statepoint file path.';
            this.update();
            return;
        }
        if (!Number.isInteger(tallyId) || tallyId <= 0) {
            this.probeError = 'Enter a positive tally id.';
            this.update();
            return;
        }
        if (!p0 || !p1) {
            this.probeError = 'Enter endpoints as "x, y, z" in cm.';
            this.update();
            return;
        }
        if (p0[0] === p1[0] && p0[1] === p1[1] && p0[2] === p1[2]) {
            this.probeError = 'Probe endpoints must differ.';
            this.update();
            return;
        }
        this.probeLoading = true;
        this.probeError = undefined;
        this.update();
        try {
            const result = await this.openmcBackend.getTallyLineProbe(statepointPath, {
                tallyId,
                score,
                nuclide,
                p0,
                p1,
                npoints,
                smooth: this.probeSmooth
            });
            if (token !== this.probeToken) {
                return;
            }
            if (result && typeof (result as OpenMCTallyLineProbeResult).error === 'string') {
                throw new Error((result as OpenMCTallyLineProbeResult).error);
            }
            this.probeResult = result;
        } catch (error) {
            if (token !== this.probeToken) {
                return;
            }
            this.probeError = error instanceof Error ? error.message : String(error);
        } finally {
            if (token === this.probeToken) {
                this.probeLoading = false;
                this.update();
            }
        }
    }

    /** Export the loaded probe series as a CSV download (kinetics-tab precedent). */
    protected exportProbeCsv(): void {
        if (!this.probeResult || (this.probeResult.series?.length ?? 0) === 0) {
            return;
        }
        const csv = lineProbeToCsv(this.probeResult);
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `tally-${this.probeResult.tallyId ?? 'probe'}-line-probe.csv`;
        anchor.click();
        URL.revokeObjectURL(url);
    }

    /**
     * Sibling-tab opener for contour surfaces (set by the frontend service
     * that opened this tab; the callback routes through the shared
     * `openTallyNativeWidget` funnel).
     */
    setContourOpener(opener: (vtkPath: string, label: string) => Promise<unknown>): void {
        this.contourOpener = opener;
    }

    /** Toggle the bottom contour panel, prefilling the source from the probe builder on first open. */
    protected toggleContourPanel(): void {
        this.contourOpen = !this.contourOpen;
        if (this.contourOpen) {
            if (this.contourStatepointPath === '' && this.probeStatepointPath !== '') {
                this.contourStatepointPath = this.probeStatepointPath;
            }
            if (this.contourTallyId === '' && this.probeTallyId !== '') {
                this.contourTallyId = this.probeTallyId;
            }
            if (this.contourScore === '' && this.probeScore !== '') {
                this.contourScore = this.probeScore;
            }
            if (this.contourNuclide === '' && this.probeNuclide !== '') {
                this.contourNuclide = this.probeNuclide;
            }
        }
        this.update();
    }

    /** Run `openmc.tally-contour` and open the surface as a sibling tab; errors stay inline, never thrown. */
    protected async runContour(): Promise<void> {
        const token = ++this.contourToken;
        const statepointPath = this.contourStatepointPath.trim();
        const tallyId = Number(this.contourTallyId);
        const isoValues = parseContourIsoValues(this.contourIso);
        const score = this.contourScore.trim() || undefined;
        const nuclide = this.contourNuclide.trim() || undefined;
        if (!statepointPath) {
            this.contourError = 'Enter a statepoint file path.';
            this.update();
            return;
        }
        if (!Number.isInteger(tallyId) || tallyId <= 0) {
            this.contourError = 'Enter a positive tally id.';
            this.update();
            return;
        }
        if (!isoValues) {
            this.contourError = 'Enter iso values as numbers separated by spaces or commas.';
            this.update();
            return;
        }
        if (isoValues.length > CONTOUR_MAX_ISO_VALUES) {
            this.contourError = `At most ${CONTOUR_MAX_ISO_VALUES} iso values per call.`;
            this.update();
            return;
        }
        if (!this.contourOpener) {
            this.contourError = 'Contour tabs are unavailable from this viewer.';
            this.update();
            return;
        }
        this.contourLoading = true;
        this.contourError = undefined;
        this.contourStatus = undefined;
        this.update();
        try {
            const conversion = await this.openmcBackend.convertTallyContourToVtk(statepointPath, {
                tallyId,
                score,
                nuclide,
                isoValues,
                smooth: this.contourSmooth
            });
            if (token !== this.contourToken) {
                return;
            }
            if (!conversion.success || !conversion.vtkPath) {
                throw new Error(conversion.error || 'Contour conversion failed');
            }
            const label = `Tally ${tallyId} contour (${formatContourIsoValues(isoValues)})`;
            await this.contourOpener(conversion.vtkPath, label);
            if (token !== this.contourToken) {
                return;
            }
            const triangles = (conversion.stats as { nTriangles?: unknown } | undefined)?.nTriangles;
            const count = typeof triangles === 'number' ? ` · ${triangles.toLocaleString()} triangles` : '';
            this.contourStatus = `Opened ${describeContourRequest(isoValues, this.contourSmooth, String(tallyId))}${count}`;
        } catch (error) {
            if (token !== this.contourToken) {
                return;
            }
            this.contourError = error instanceof Error ? error.message : String(error);
        } finally {
            if (token === this.contourToken) {
                this.contourLoading = false;
                this.update();
            }
        }
    }

    /** World-space grid backing the smooth volume (true 3D datasets only; slices and clouds stay boxed). */
    private describeSmoothGrid(): VolumeGrid | undefined {
        const dims = this.model?.gridDimensions;
        if (!smoothableGridDims(dims) || !this.model) {
            return undefined;
        }
        const bounds = boundingBoxFromPositions(this.model.positions);
        if (!bounds) {
            return undefined;
        }
        return {
            dims: [...dims] as [number, number, number],
            min: [bounds.min[0], bounds.min[1], bounds.min[2]],
            max: [bounds.max[0], bounds.max[1], bounds.max[2]]
        };
    }

    private currentArrayInfos(): OpenMCVtkArrayInfo[] {
        if (!this.model) {
            return [];
        }
        return [...this.model.pointArrays, ...this.model.cellArrays].map((entry) => ({
            name: entry.name,
            association: entry.association,
            components: entry.components,
            range: entry.range as [number, number]
        }));
    }

    /**
     * Load ghosted CSG cell boxes under the tally dataset (overlay mode):
     * cached for rebuilds (new dataset, theme switch); pass `[]` to clear.
     * Degenerate bboxes are dropped by {@link csgUnderlayCells}. Outline
     * visibility state resets with the cells. Applies instantly when a
     * scene exists, otherwise on the next dataset load.
     */
    setGeometryUnderlayCells(cells: readonly GeometryNativeCell[]): void {
        this.underlayCells = csgUnderlayCells(cells);
        this.hiddenUnderlayCells = [];
        this.hiddenUnderlayMaterials = [];
        this.showUnderlayVoid = true;
        this.selectedUnderlayCellId = null;
        this.rebuildUnderlay();
        this.fireCsgOutlineChanged();
        this.update();
    }

    /** Whether a geometry underlay is currently shown. */
    hasGeometryUnderlay(): boolean {
        return this.underlayCells.length > 0;
    }

    /** Canvas-menu switch for the underlay (cells stay cached while hidden). */
    setUnderlayVisible(visible: boolean): void {
        if (visible !== this.underlayVisible) {
            this.underlayVisible = visible;
            this.rebuildUnderlay();
            this.fireCsgOutlineChanged();
            this.update();
        }
    }

    /** Outline-side highlight for an underlay cell (panel→canvas only; the canvas has no CSG picking). */
    selectUnderlayCell(id: number | null): void {
        if (id !== this.selectedUnderlayCellId) {
            this.selectedUnderlayCellId = id;
            this.rebuildUnderlay();
            this.fireCsgOutlineChanged();
            this.update();
        }
    }

    /** One shared visibility rule for outline rows and canvas ghosts (plus the menu master switch). */
    protected isUnderlayCellVisible(cell: GeometryNativeCell): boolean {
        return (
            this.underlayVisible &&
            isGeometryCellVisible(cell, this.hiddenUnderlayMaterials, this.hiddenUnderlayCells, this.showUnderlayVoid)
        );
    }

    /** Read the underlay outline for the CSG Outline panel (undefined while no cells are loaded). */
    getCsgOutlineSnapshot(): CsgOutlineSnapshot | undefined {
        if (this.underlayCells.length === 0) {
            return undefined;
        }
        const materials = materialNamesInOrder(this.underlayCells).map((name) => ({
            name,
            cellCount: this.underlayCells.filter((cell) => cell.material === name).length,
            visible:
                this.underlayVisible && !this.hiddenUnderlayMaterials.includes(name) && (this.showUnderlayVoid || !isVoidMaterial(name))
        }));
        return {
            widgetId: this.id,
            title: this.title.label,
            hasDataset: true,
            cells: this.underlayCells.map((cell) => ({
                id: cell.id,
                label: cellDisplayName(cell),
                material: cell.material,
                visible: this.isUnderlayCellVisible(cell),
                selected: this.selectedUnderlayCellId === cell.id
            })),
            materials,
            showVoid: this.showUnderlayVoid,
            visibleCount: this.underlayCells.filter((cell) => this.isUnderlayCellVisible(cell)).length,
            totalCount: this.underlayCells.length,
            selectedCellId: this.selectedUnderlayCellId
        };
    }

    /** Apply an outline edit through the underlay visibility setters. */
    applyCsgOutline(patch: CsgOutlinePatch): void {
        if (patch.toggleCell !== undefined) {
            this.hiddenUnderlayCells = this.hiddenUnderlayCells.includes(patch.toggleCell)
                ? this.hiddenUnderlayCells.filter((entry) => entry !== patch.toggleCell)
                : [...this.hiddenUnderlayCells, patch.toggleCell];
            this.rebuildUnderlay();
            this.fireCsgOutlineChanged();
            this.update();
        }
        if (patch.toggleMaterial !== undefined) {
            this.hiddenUnderlayMaterials = this.hiddenUnderlayMaterials.includes(patch.toggleMaterial)
                ? this.hiddenUnderlayMaterials.filter((entry) => entry !== patch.toggleMaterial)
                : [...this.hiddenUnderlayMaterials, patch.toggleMaterial];
            this.rebuildUnderlay();
            this.fireCsgOutlineChanged();
            this.update();
        }
        if (patch.showVoid !== undefined && patch.showVoid !== this.showUnderlayVoid) {
            this.showUnderlayVoid = patch.showVoid;
            this.rebuildUnderlay();
            this.fireCsgOutlineChanged();
            this.update();
        }
        if (patch.showAll === true) {
            this.hiddenUnderlayCells = [];
            this.hiddenUnderlayMaterials = [];
            this.rebuildUnderlay();
            this.fireCsgOutlineChanged();
            this.update();
        }
        if (patch.selectCell !== undefined) {
            this.selectUnderlayCell(patch.selectCell);
        }
    }

    protected override buildUnderlayObjects(): THREE.Object3D[] {
        if (!this.underlayVisible) {
            return [];
        }
        return this.underlayCells.filter((cell) => this.isUnderlayCellVisible(cell)).map((cell) => this.buildUnderlayCell(cell));
    }

    protected override buildContextMenuItems(): ViewerContextMenuItem[] {
        return [...super.buildContextMenuItems(), buildTallyUnderlayMenuItem(this.underlayCells.length > 0, this.underlayVisible)];
    }

    protected override handleExtraContextMenuAction(id: string): void {
        if (id === TALLY_UNDERLAY_MENU_ID && this.underlayCells.length > 0) {
            this.setUnderlayVisible(!this.underlayVisible);
        }
    }

    /**
     * Follow the smooth raycast: dim the ghosts while it draws so stacked
     * shells cannot veil the projection, back to full context otherwise.
     * Runs on every volume reconcile; rebuilds only on change.
     */
    protected override syncUnderlayDimming(): void {
        const dimmed = this.isVolumeSmoothActive();
        if (dimmed !== this.underlayDimmed) {
            this.underlayDimmed = dimmed;
            this.rebuildUnderlay();
        }
    }

    /**
     * One ghosted CSG box: theme-aware fill (geometry-viewer palette) at a
     * fixed ghost strength with no depth writes, so tally voxels inside stay
     * readable (DAGMC ghost precedent). Void cells render as edge-only
     * shells — fills on the big bounding void boxes stack translucency over
     * the tally until it washes out. FrontSide halves nested-shell
     * stacking; raycasts are disabled so measure picks hit tally data,
     * never the context boxes. The outline-selected cell glows (fill
     * emissive, full-strength void edges).
     */
    private buildUnderlayCell(cell: GeometryNativeCell): THREE.Group {
        const group = new THREE.Group();
        const selected = this.selectedUnderlayCellId === cell.id;
        const minX = Math.min(cell.bbox.min[0], cell.bbox.max[0]);
        const minY = Math.min(cell.bbox.min[1], cell.bbox.max[1]);
        const minZ = Math.min(cell.bbox.min[2], cell.bbox.max[2]);
        const maxX = Math.max(cell.bbox.min[0], cell.bbox.max[0]);
        const maxY = Math.max(cell.bbox.min[1], cell.bbox.max[1]);
        const maxZ = Math.max(cell.bbox.min[2], cell.bbox.max[2]);
        const geometry = new THREE.BoxGeometry(maxX - minX, maxY - minY, maxZ - minZ);
        const strength = underlayGhostStrength(this.underlayDimmed);
        const position: [number, number, number] = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
        if (!isVoidMaterial(cell.material)) {
            const color = new THREE.Color(colorForCellOnTheme(cell, this.isDarkTheme()));
            const mesh = new THREE.Mesh(
                geometry,
                new THREE.MeshLambertMaterial({
                    color,
                    transparent: true,
                    opacity: strength.fill,
                    depthWrite: false,
                    side: THREE.FrontSide,
                    emissive: new THREE.Color(selected ? 0x664400 : 0x000000)
                })
            );
            mesh.position.set(...position);
            mesh.renderOrder = -1;
            mesh.raycast = () => undefined;
            group.add(mesh);
        }
        const edges = new THREE.LineSegments(
            new THREE.EdgesGeometry(geometry),
            new THREE.LineBasicMaterial({
                color: cellEdgeColor(this.isDarkTheme()),
                transparent: true,
                opacity: selected ? 1 : strength.edge,
                depthWrite: false
            })
        );
        edges.position.set(...position);
        edges.renderOrder = -1;
        edges.raycast = () => undefined;
        group.add(edges);
        return group;
    }

    protected override render(): React.ReactNode {
        return (
            <div className="openmc-output-viewer-container">
                {this.renderHeader()}
                {this.error ? this.renderError() : this.renderContent()}
                {this.renderProbePanel()}
                {this.renderContourPanel()}
            </div>
        );
    }

    protected override renderHeader(): React.ReactNode {
        return (
            <div className="openmc-output-viewer-header">
                <Tooltip content={this.describeTallyKind()} position="bottom">
                    <span className="openmc-output-viewer-file" style={{ fontSize: '11px', opacity: 0.8 }}>
                        <i className={codicon('tag')}></i>
                        {this.tallyKind}
                        {this.sliceAxis ? ` ⟂ ${this.sliceAxis}` : ''}
                        {this.underlayVisible && this.underlayCells.length > 0 ? ` + ${this.underlayCells.length} CSG` : ''}
                    </span>
                </Tooltip>
                <Tooltip content="Sample the mesh tally along a line segment (flux profile)" position="bottom">
                    <button
                        className="theia-button tally-line-probe-toggle"
                        style={{ padding: '2px 8px', fontSize: '12px', minWidth: '0' }}
                        onClick={() => this.toggleProbePanel()}
                    >
                        <i className={codicon('graph-line')}></i> Line probe
                    </button>
                </Tooltip>
                <Tooltip content="Extract flux iso-surfaces into a sibling tab (contour)" position="bottom">
                    <button
                        className="theia-button tally-contour-toggle"
                        style={{ padding: '2px 8px', fontSize: '12px', minWidth: '0' }}
                        onClick={() => this.toggleContourPanel()}
                    >
                        <i className={codicon('layers')}></i> Contour
                    </button>
                </Tooltip>
            </div>
        );
    }

    /**
     * Bottom data-half panel: contour builder (statepoint/tally/score plus
     * iso values in tally units and the smooth switch — the same
     * smooth/pixelated convention as the overlay Rendering Style).
     * Running opens the surface as a sibling tab through the opener the
     * service set; the sibling inherits warp/threshold funnels untouched.
     * Collapsed unless toggled in the header.
     */
    protected renderContourPanel(): React.ReactNode {
        if (!this.contourOpen) {
            return undefined;
        }
        return (
            <div className="openmc-output-viewer-panel-host tally-contour-panel">
                <div className="openmc-output-viewer-panel">
                    <h4>Contour — iso-surfaces over the mesh tally</h4>
                    <div className="openmc-output-viewer-control" style={{ flexWrap: 'wrap', rowGap: '6px' }}>
                        <label>
                            Statepoint
                            <input
                                type="text"
                                style={{ width: '220px', marginLeft: '4px' }}
                                placeholder="/path/to/statepoint.10.h5"
                                value={this.contourStatepointPath}
                                onChange={(event) => {
                                    this.contourStatepointPath = event.target.value;
                                    this.update();
                                }}
                            />
                        </label>
                        <label>
                            Tally
                            <input
                                type="number"
                                style={{ marginLeft: '4px' }}
                                placeholder="4"
                                value={this.contourTallyId}
                                onChange={(event) => {
                                    this.contourTallyId = event.target.value;
                                    this.update();
                                }}
                            />
                        </label>
                        <label>
                            Score
                            <input
                                type="text"
                                style={{ width: '90px', marginLeft: '4px' }}
                                placeholder="flux"
                                value={this.contourScore}
                                onChange={(event) => {
                                    this.contourScore = event.target.value;
                                    this.update();
                                }}
                            />
                        </label>
                        <label>
                            Nuclides
                            <input
                                type="text"
                                style={{ width: '90px', marginLeft: '4px' }}
                                placeholder="total"
                                value={this.contourNuclide}
                                onChange={(event) => {
                                    this.contourNuclide = event.target.value;
                                    this.update();
                                }}
                            />
                        </label>
                    </div>
                    <div className="openmc-output-viewer-control" style={{ flexWrap: 'wrap', rowGap: '6px', marginTop: '6px' }}>
                        <label>
                            Iso values
                            <input
                                type="text"
                                className="tally-contour-iso"
                                style={{ width: '200px', marginLeft: '4px' }}
                                placeholder="1e12, 5e12"
                                value={this.contourIso}
                                onChange={(event) => {
                                    this.contourIso = event.target.value;
                                    this.update();
                                }}
                            />
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <input
                                type="checkbox"
                                checked={this.contourSmooth}
                                onChange={(event) => {
                                    this.contourSmooth = event.target.checked;
                                    this.update();
                                }}
                            />
                            Smooth (interpolated; off = pixelated cells)
                        </label>
                        <button
                            className="theia-button tally-contour-run"
                            style={{ padding: '2px 10px', fontSize: '12px', minWidth: '0' }}
                            disabled={this.contourLoading}
                            onClick={() => this.runContour()}
                        >
                            {this.contourLoading ? 'Contouring…' : 'Open contour'}
                        </button>
                    </div>
                    {this.contourError && (
                        <div className="tally-contour-error" style={{ color: 'var(--theia-errorForeground)', marginTop: '6px' }}>
                            {this.contourError}
                        </div>
                    )}
                    {this.contourStatus && !this.contourError && (
                        <div className="nuke-viewer-status-line" style={{ marginTop: '6px' }}>
                            {this.contourStatus}
                        </div>
                    )}
                </div>
            </div>
        );
    }

    /**
     * Bottom data-half panel: probe builder (numeric endpoints in cm — the
     * measure tool keeps owning canvas picking, its raycast handles are
     * private to the shared viewer base) plus the series table with CSV
     * export. Collapsed unless toggled in the header.
     */
    protected renderProbePanel(): React.ReactNode {
        if (!this.probeOpen) {
            return undefined;
        }
        const series = this.probeResult?.series ?? [];
        const visible = series.slice(0, LINE_PROBE_TABLE_ROW_CAP);
        return (
            <div className="openmc-output-viewer-panel-host tally-line-probe-panel">
                <div className="openmc-output-viewer-panel">
                    <h4>Line probe — flux profile along a segment</h4>
                    <div className="openmc-output-viewer-control" style={{ flexWrap: 'wrap', rowGap: '6px' }}>
                        <label>
                            Statepoint
                            <input
                                type="text"
                                style={{ width: '220px', marginLeft: '4px' }}
                                placeholder="/path/to/statepoint.10.h5"
                                value={this.probeStatepointPath}
                                onChange={(event) => {
                                    this.probeStatepointPath = event.target.value;
                                    this.update();
                                }}
                            />
                        </label>
                        <label>
                            Tally
                            <input
                                type="number"
                                style={{ marginLeft: '4px' }}
                                placeholder="4"
                                value={this.probeTallyId}
                                onChange={(event) => {
                                    this.probeTallyId = event.target.value;
                                    this.update();
                                }}
                            />
                        </label>
                        <label>
                            Score
                            <input
                                type="text"
                                style={{ width: '90px', marginLeft: '4px' }}
                                placeholder="flux"
                                value={this.probeScore}
                                onChange={(event) => {
                                    this.probeScore = event.target.value;
                                    this.update();
                                }}
                            />
                        </label>
                        <label>
                            Nuclides
                            <input
                                type="text"
                                style={{ width: '90px', marginLeft: '4px' }}
                                placeholder="total"
                                value={this.probeNuclide}
                                onChange={(event) => {
                                    this.probeNuclide = event.target.value;
                                    this.update();
                                }}
                            />
                        </label>
                    </div>
                    <div className="openmc-output-viewer-control" style={{ flexWrap: 'wrap', rowGap: '6px', marginTop: '6px' }}>
                        <label>
                            P0 (cm)
                            <input
                                type="text"
                                style={{ width: '150px', marginLeft: '4px' }}
                                placeholder="x, y, z"
                                value={this.probeP0}
                                onChange={(event) => {
                                    this.probeP0 = event.target.value;
                                    this.update();
                                }}
                            />
                        </label>
                        <label>
                            P1 (cm)
                            <input
                                type="text"
                                style={{ width: '150px', marginLeft: '4px' }}
                                placeholder="x, y, z"
                                value={this.probeP1}
                                onChange={(event) => {
                                    this.probeP1 = event.target.value;
                                    this.update();
                                }}
                            />
                        </label>
                        <label>
                            Points
                            <input
                                type="number"
                                style={{ marginLeft: '4px' }}
                                value={this.probeNpoints}
                                onChange={(event) => {
                                    this.probeNpoints = event.target.value;
                                    this.update();
                                }}
                            />
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <input
                                type="checkbox"
                                checked={this.probeSmooth}
                                onChange={(event) => {
                                    this.probeSmooth = event.target.checked;
                                    this.update();
                                }}
                            />
                            Smooth (trilinear; off = pixelated cells)
                        </label>
                        <button
                            className="theia-button tally-line-probe-run"
                            style={{ padding: '2px 10px', fontSize: '12px', minWidth: '0' }}
                            disabled={this.probeLoading}
                            onClick={() => this.runLineProbe()}
                        >
                            {this.probeLoading ? 'Probing…' : 'Run probe'}
                        </button>
                    </div>
                    {this.probeError && (
                        <div className="tally-line-probe-error" style={{ color: 'var(--theia-errorForeground)', marginTop: '6px' }}>
                            {this.probeError}
                        </div>
                    )}
                    {this.probeResult && !this.probeError && (
                        <div style={{ marginTop: '8px' }}>
                            <div className="openmc-output-viewer-control" style={{ marginBottom: '4px' }}>
                                <span className="nuke-viewer-status-line">{describeLineProbeSeries(this.probeResult)}</span>
                                <button
                                    className="theia-button tally-line-probe-export"
                                    style={{ padding: '2px 10px', fontSize: '12px', minWidth: '0', marginLeft: '8px' }}
                                    disabled={series.length === 0}
                                    onClick={() => this.exportProbeCsv()}
                                >
                                    Export CSV
                                </button>
                            </div>
                            <table className="openmc-output-viewer-table tally-line-probe-table">
                                <thead>
                                    <tr>
                                        <th>Distance (cm)</th>
                                        <th>X (cm)</th>
                                        <th>Y (cm)</th>
                                        <th>Z (cm)</th>
                                        <th>Value</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {visible.map((point, index) => (
                                        <tr key={index}>
                                            <td>{point.distance}</td>
                                            <td>{point.position[0]}</td>
                                            <td>{point.position[1]}</td>
                                            <td>{point.position[2]}</td>
                                            <td>{point.value}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            {series.length > visible.length && (
                                <div className="nuke-viewer-status-line" style={{ marginTop: '4px' }}>
                                    Showing {visible.length} of {series.length} rows — Export CSV downloads the full series.
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        );
    }

    private describeTallyKind(): string {
        if (!this.model) {
            return `Tally ${this.tallyKind} — no dataset loaded`;
        }
        return describeTallyOverlayDataset({
            kind: this.tallyKind,
            family: this.model.family,
            nPoints: this.model.nPoints,
            sliceAxis: this.sliceAxis,
            colorBy: this.colorBy
        });
    }
}
