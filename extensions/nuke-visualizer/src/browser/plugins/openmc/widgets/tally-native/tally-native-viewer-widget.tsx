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
import { OpenMCVtkArrayInfo } from '../../../../../common/openmc-protocol';
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
    smoothableGridDims
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

/** Ghost fill strength for CSG underlay boxes (the tally opacity slider stays authoritative over tally data only). */
const CSG_UNDERLAY_FILL_OPACITY = 0.1;

/** Edge strength for CSG underlay boxes. */
const CSG_UNDERLAY_EDGE_OPACITY = 0.35;

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
        const position: [number, number, number] = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
        if (!isVoidMaterial(cell.material)) {
            const color = new THREE.Color(colorForCellOnTheme(cell, this.isDarkTheme()));
            const mesh = new THREE.Mesh(
                geometry,
                new THREE.MeshLambertMaterial({
                    color,
                    transparent: true,
                    opacity: CSG_UNDERLAY_FILL_OPACITY,
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
                opacity: selected ? 1 : CSG_UNDERLAY_EDGE_OPACITY,
                depthWrite: false
            })
        );
        edges.position.set(...position);
        edges.renderOrder = -1;
        edges.raycast = () => undefined;
        group.add(edges);
        return group;
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
