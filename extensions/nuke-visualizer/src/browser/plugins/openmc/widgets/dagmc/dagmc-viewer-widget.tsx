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
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { Message, Widget } from '@theia/core/lib/browser';
import { Emitter, Event } from '@theia/core/lib/common/event';
import { codicon } from '@theia/core/lib/browser/widgets/widget';
import URI from '@theia/core/lib/common/uri';
import { MessageService } from '@theia/core/lib/common';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { NukeLoadingOverlay, Tooltip, ViewBadge, ViewerNavBar, ViewCube } from 'nuke-essentials/lib/theme/browser/components';
import type { ViewerNavAction, ViewCubeHandle } from 'nuke-essentials/lib/theme/browser/components';
import {
    ClassifiedNativeVtkArrays,
    classifyNativeVtkArrays,
    colorByValue,
    defaultNativeColorBy,
    NativeVtkDataArray,
    readVtkText
} from '../native-vtk/native-vtk-data';
import { COLORMAP_NAMES, ColormapName, getColormap, isColormapName } from '../../../../viewer-core/colormaps';
import {
    ColorRangeMode,
    componentOptions,
    formatRangeValue,
    logScaleAvailable,
    MAGNITUDE_COMPONENT,
    mapScalar,
    mappingToCssGradient,
    resolveEffectiveRange,
    ScalarMapping,
    tupleScalar
} from '../../../../viewer-core/scalar-mapping';
import {
    DEFAULT_VIEWER_TOOLBAR_STATE,
    LINE_WIDTH_SPEC,
    OPACITY_SPEC,
    parseColorBy,
    POINT_SIZE_SPEC,
    SOLID_COLOR
} from '../../../../viewer-core/viewer-toolbar-model';
import { OpenMCVtkArrayInfo } from '../../../../../common/openmc-protocol';
import {
    anyClipEnabled,
    ClipAxis,
    ClipPlanesState,
    createClipPlanesState,
    setAllClipEnabled,
    toThreePlaneParamsArray,
    updateAxisClip,
    type AxisClipState
} from '../../../../viewer-core/clip-plane';
import {
    createOrbitControls,
    standardViewDirection,
    type BoundsCorner,
    type OrbitControlsHandle
} from '../../../../viewer-core/orbit-controls';
import {
    addMeasurePoint,
    cancelMeasureStep,
    formatMeasureDistance,
    projectMeasurePoint,
    resetMeasureState,
    setMeasureActive,
    type MeasurePoint3D,
    type MeasureState
} from '../../../../viewer-core/measure-model';
import { buildViewerContextMenuItems, isViewerContextMenuClick, openViewerContextMenu } from '../../../../viewer-core/viewer-context-menu';
import {
    DEFAULT_VIEWER_SHADING_MODE,
    ViewerShadingMode,
    isViewerShadingMode,
    resolveViewerShadingFlags
} from '../../../../viewer-core/shading-mode';
import { nextNavPopover, type ViewerNavPopoverKind } from '../../../../viewer-core/viewer-nav-popover';
import {
    ViewerSettingsHost,
    ViewerSettingsPatch,
    ViewerSettingsSnapshot,
    viewerSnapDirection
} from '../../../../viewer-settings/viewer-settings-model';
import {
    DagmcOutlineHost,
    DagmcOutlinePatch,
    DagmcOutlineSnapshot,
    formatDagmcOutlineVolumeLabel
} from '../../../../dagmc-outline/dagmc-outline-model';
import { DagmcBlockModel, mergeDagmcBounds, parseBlockDataset, parseVtmManifest } from './dagmc-multiblock';
import {
    DagmcModelInfo,
    DagmcVisibility,
    createDefaultDagmcVisibility,
    groupsOfVolume,
    isDagmcVolumeVisible,
    isGraveyardMaterial,
    isolateDagmcVolume,
    parseDagmcModelInfo,
    setDagmcShowGraveyard,
    showAllDagmc,
    toggleDagmcGroup,
    toggleDagmcMaterial,
    toggleDagmcVolume
} from './dagmc-toggle-model';
import { ViewerMeasureLabel, type ViewerMeasureHandle } from '../viewer-measure';
import {
    DagmcIsolateActions,
    ViewerClipPopover,
    ViewerClipTrigger,
    ViewerFileActions,
    ViewerNavPopoverShell,
    ViewerShadingPopover,
    ViewerShadingTrigger
} from '../viewer-nav-extras';
import '../output-viewer.css';

/** Scratch view-projection matrix for the measure-label projection (module scope so the camera loop never allocates). */
const scratchViewProjection = new THREE.Matrix4();

/**
 * Props driving the native DAGMC viewer. Every field applies instantly to
 * the already-loaded blocks — toggling volumes, switching color-by, or
 * moving the clip planes never restarts anything (there is no trame server;
 * this is the P2-C2 replacement for the `dagmc_viz.py` ExtractBlock UI).
 */
export interface DagmcViewerProps {
    /** `'Solid Color'`, `'Point: <name>'`, or `'Cell: <name>'` (base.serve format). */
    colorBy?: string;
    /** One of the shared viewer-core colormaps. */
    colormap?: ColormapName;
    /** CSS color used in Solid Color mode. */
    solidColor?: string;
    /** Scalar bar (color legend) visibility. */
    scalarBarVisible?: boolean;
    /** Canvas background color. */
    background?: string;
    /** Color range source: the data range or a user range. */
    rangeMode?: ColorRangeMode;
    /** User range applied in `custom` mode. */
    customRange?: readonly [number, number];
    /** Sample the colormap in reverse. */
    invert?: boolean;
    /** Log-scaled scalar mapping. */
    logScale?: boolean;
    /** Multi-component array component index (-1 = L2 magnitude). */
    component?: number;
    /** Point sprite size in pixels. */
    pointSize?: number;
    /** Line width in pixels. */
    lineWidth?: number;
    /** Material opacity in [0, 1]. */
    opacity?: number;
    /** Shading mode (`shaded` | `wireframe` | `points` | `xray`). */
    shading?: ViewerShadingMode;
    /** Per-axis clip state; each enabled axis plane applies (box-section view). */
    clip?: ClipPlanesState;
    /** Volume/material/group visibility (toggle model). */
    visibility?: DagmcVisibility;
    /** Highlighted volume id (outline↔canvas sync key); null clears the highlight. */
    selectedVolumeId?: number | null;
}

/** Render-vertex kind used to map vertices back to data tuples. */
type DagmcRenderKind = 'mesh' | 'edges' | 'lines' | 'points';

const VOLUME_BLOCK_RE = /^Volume_(\d+)$/;

/** Canvas backdrop of `output-viewer.css` (`--theia-editor-background` in the shipped themes). */
const DEFAULT_VIEWER_BACKGROUND = '#1e1e1e';

/**
 * Native DAGMC viewer widget (P2-C2): renders multiblock `.vtm` volume sets
 * (as written by `convert_h5m_to_multiblock_vtk`) directly in the IDE with
 * three.js — no trame server, no reverse proxy, no iframe. The manifest is
 * read through Theia's `FileService`, each block file is resolved against
 * the manifest URI and parsed client-side, model metadata arrives via
 * `setModelInfo` (the `dagmc.info` JSON channel), and volume / material /
 * group toggles plus the per-axis clip planes apply instantly.
 *
 * This widget is intentionally NOT wired into any contribution yet: the
 * parent phase registers the opener, feeds it the converter output paths,
 * and calls `setModelInfo` with the `dagmc.info` payload.
 */
@injectable()
export class DagmcViewerWidget extends ReactWidget implements ViewerSettingsHost, DagmcOutlineHost {
    static readonly ID: string = 'dagmc-viewer-widget';
    static readonly LABEL: string = 'Native DAGMC Viewer';

    @inject(FileService)
    protected readonly fileService!: FileService;

    @inject(MessageService)
    protected readonly messageService!: MessageService;

    protected vtmUri: URI | undefined;
    protected blocks: DagmcBlockModel[] = [];
    protected modelInfo: DagmcModelInfo | undefined;
    protected classified: ClassifiedNativeVtkArrays | undefined;
    protected visibility: DagmcVisibility = createDefaultDagmcVisibility();
    protected colorBy: string = SOLID_COLOR;
    protected colormap: ColormapName = 'Cool to Warm';
    protected scalarBarVisible = true;
    protected background = DEFAULT_VIEWER_BACKGROUND;
    protected rangeMode: ColorRangeMode = 'auto';
    protected customRange: readonly [number, number] | undefined;
    protected invert = false;
    protected logScale = false;
    protected component = MAGNITUDE_COMPONENT;
    protected solidColor = '#d4d4d4';
    protected pointSize = DEFAULT_VIEWER_TOOLBAR_STATE.pointSize;
    protected lineWidth = DEFAULT_VIEWER_TOOLBAR_STATE.lineWidth;
    protected opacity = DEFAULT_VIEWER_TOOLBAR_STATE.opacity;
    protected shading: ViewerShadingMode = DEFAULT_VIEWER_SHADING_MODE;
    protected clip: ClipPlanesState = createClipPlanesState();
    /** Active X/Y/Z tab of the header clip control (per-axis settings persist). */
    protected clipTab: ClipAxis = 'X';
    /**
     * Open bottom-bar popover (single slot, CAD `openPopover` parity — never
     * both cards). The widget owns the slot; every card control routes onto
     * the existing setters, so the sidebar stays authoritative.
     */
    protected openNavPopover: ViewerNavPopoverKind | undefined;
    /** Bar + card elements behind the outside-click dismissal (trigger clicks are inside the bar). */
    protected navBarElement: HTMLDivElement | null = null;
    protected navPopoverElement: HTMLDivElement | null = null;
    protected isLoading = false;
    protected error: string | undefined;
    protected statusMessage = '';
    protected note = '';
    /** Source label shown under the loading overlay before a manifest exists (instant `.h5m` open). */
    protected pendingLabel: string | undefined;
    /** Source `.h5m` path for converted opens (lets the opener reuse the live tab on re-open). */
    h5mSourcePath: string | undefined;
    /** Outline↔canvas selection: the widget owns it, the panel mirrors it. */
    protected selectedVolumeId: number | null = null;
    /** One-shot generic-viewer fallback offered by the opener on conversion failure (cleared on load). */
    protected genericFallback: (() => void) | undefined;
    /**
     * Outline-panel refresh signal: the panel binds once to the active
     * viewer and re-reads the snapshot on fire (canvas picks, visibility
     * edits, load completion), so selection sync needs no polling.
     */
    private readonly outlineChanged = new Emitter<void>();
    readonly onDidChangeDagmcOutline: Event<void> = this.outlineChanged.event;
    private loadToken = 0;

    private host: HTMLElement | undefined;
    private renderer: THREE.WebGLRenderer | undefined;
    private scene: THREE.Scene | undefined;
    private camera: THREE.PerspectiveCamera | undefined;
    private dataGroup: THREE.Group | undefined;
    private orbitControls: OrbitControlsHandle | undefined;
    private resizeObserver: ResizeObserver | undefined;
    private contextMenuClose: (() => void) | undefined;
    private gizmo: ViewCubeHandle | null = null;
    /** Viewport-only distance-measure session (never document state; cleared on rebuild). */
    private measure: MeasureState = { active: false, pending: undefined, segment: undefined };
    private measureGroup: THREE.Group | undefined;
    private measureLabel: ViewerMeasureHandle | null = null;
    /** World-size endpoint marker radius, derived from the visible bounds at build time. */
    private measureMarkerSize = 0.01;
    private measureKeysAttached = false;

    @postConstruct()
    protected init(): void {
        this.id = DagmcViewerWidget.ID;
        this.title.label = DagmcViewerWidget.LABEL;
        this.title.iconClass = codicon('layers');
        this.title.closable = true;
        this.node.tabIndex = 0;
    }

    // ------------------------------------------------------------------
    // Public props API (instant, no restart)
    // ------------------------------------------------------------------

    getProps(): DagmcViewerProps {
        return {
            colorBy: this.colorBy,
            colormap: this.colormap,
            solidColor: this.solidColor,
            scalarBarVisible: this.scalarBarVisible,
            background: this.background,
            rangeMode: this.rangeMode,
            customRange: this.customRange,
            invert: this.invert,
            logScale: this.logScale,
            component: this.component,
            pointSize: this.pointSize,
            lineWidth: this.lineWidth,
            opacity: this.opacity,
            shading: this.shading,
            clip: {
                X: { ...this.clip.X },
                Y: { ...this.clip.Y },
                Z: { ...this.clip.Z }
            },
            visibility: { ...this.visibility },
            selectedVolumeId: this.selectedVolumeId
        };
    }

    /** Apply viewer props; visibility/color/clip changes take effect immediately. */
    applyProps(props: DagmcViewerProps): void {
        let structureChanged = false;
        let styleChanged = false;
        if (props.colorBy !== undefined && props.colorBy !== this.colorBy) {
            this.colorBy = props.colorBy;
            this.resetColorMapping();
            styleChanged = true;
        }
        if (props.colormap !== undefined && isColormapName(props.colormap) && props.colormap !== this.colormap) {
            this.colormap = props.colormap;
            styleChanged = true;
        }
        if (props.solidColor !== undefined && props.solidColor !== this.solidColor) {
            this.solidColor = props.solidColor;
            styleChanged = true;
        }
        if (props.scalarBarVisible !== undefined && props.scalarBarVisible !== this.scalarBarVisible) {
            this.scalarBarVisible = props.scalarBarVisible;
        }
        if (props.background !== undefined && props.background !== this.background) {
            this.background = props.background;
            this.applyBackground();
        }
        if (props.rangeMode !== undefined && props.rangeMode !== this.rangeMode) {
            this.rangeMode = props.rangeMode;
            styleChanged = true;
        }
        if (props.customRange !== undefined) {
            const next: readonly [number, number] = [props.customRange[0], props.customRange[1]];
            if (next[0] !== this.customRange?.[0] || next[1] !== this.customRange?.[1]) {
                this.customRange = next;
                styleChanged = true;
            }
        }
        if (props.invert !== undefined && props.invert !== this.invert) {
            this.invert = props.invert;
            styleChanged = true;
        }
        if (props.logScale !== undefined && props.logScale !== this.logScale) {
            this.logScale = props.logScale;
            styleChanged = true;
        }
        if (
            props.component !== undefined &&
            Number.isInteger(props.component) &&
            props.component >= MAGNITUDE_COMPONENT &&
            props.component !== this.component
        ) {
            this.component = props.component;
            styleChanged = true;
        }
        if (props.pointSize !== undefined && props.pointSize > 0 && props.pointSize !== this.pointSize) {
            this.pointSize = props.pointSize;
            styleChanged = true;
        }
        if (props.lineWidth !== undefined && props.lineWidth > 0 && props.lineWidth !== this.lineWidth) {
            this.lineWidth = props.lineWidth;
            styleChanged = true;
        }
        if (props.opacity !== undefined) {
            const opacity = Math.min(1, Math.max(0, props.opacity));
            if (opacity !== this.opacity) {
                this.opacity = opacity;
                styleChanged = true;
            }
        }
        if (props.shading !== undefined && isViewerShadingMode(props.shading) && props.shading !== this.shading) {
            this.shading = props.shading;
            styleChanged = true;
        }
        if (props.clip !== undefined) {
            this.clip = props.clip;
            styleChanged = true;
        }
        if (props.visibility !== undefined) {
            this.visibility = props.visibility;
            structureChanged = true;
        }
        if (props.selectedVolumeId !== undefined && props.selectedVolumeId !== this.selectedVolumeId) {
            this.selectedVolumeId = props.selectedVolumeId;
            this.applyHighlight();
            this.renderScene();
            this.fireOutlineChanged();
        }
        if (structureChanged) {
            this.buildScene();
        } else if (styleChanged) {
            this.recolor();
            this.applyClip();
            this.applyShadingVisibility();
            this.syncMaterialProps();
            this.renderScene();
        }
        this.update();
    }

    // ------------------------------------------------------------------
    // Viewer Settings sidebar API (single-direction sync: the panel reads
    // the snapshot and applies edits through these setters — the same calls
    // the header used to make, never duplicated state)
    // ------------------------------------------------------------------

    /** Color-by entries for the sidebar select (same options the header offered). */
    colorByOptions(): { value: string; label: string }[] {
        if (this.blocks.length === 0 || !this.classified) {
            return [{ value: SOLID_COLOR, label: SOLID_COLOR }];
        }
        const options: { value: string; label: string }[] = [{ value: SOLID_COLOR, label: SOLID_COLOR }];
        const push = (arrays: OpenMCVtkArrayInfo[]): void => {
            for (const array of arrays) {
                const value = colorByValue(array);
                if (!options.some((option) => option.value === value)) {
                    options.push({ value, label: `${array.association === 'point' ? 'Point' : 'Cell'}: ${array.name}` });
                }
            }
        };
        push(this.classified.energies);
        push(this.classified.fluxGroups);
        push(this.classified.scalars);
        push(this.classified.sources);
        push(this.classified.ids);
        push(this.classified.other);
        return options;
    }

    /** Whether the distance-measure tool is armed (sidebar toggle state). */
    isMeasureActive(): boolean {
        return this.measure.active;
    }

    /** Arm or disarm the distance-measure tool (sidebar toggle). */
    setMeasureActive(active: boolean): void {
        const next = setMeasureActive(this.measure, active);
        if (next !== this.measure) {
            this.measure = next;
            this.update();
        }
    }

    /** Snap the camera to an orbit-handle direction (sidebar snap group). */
    snapViewerTo(direction: BoundsCorner): void {
        this.orbitControls?.setViewDirection(direction);
    }

    /** Read the current settings for the sidebar panel. */
    getViewerSettingsSnapshot(): ViewerSettingsSnapshot {
        const solid = this.colorBy === SOLID_COLOR;
        const active = this.activeColorArray();
        const range = this.effectiveArrayRange();
        const dataRange = active ? (this.mergedArrayRange(active.kind, active.name) ?? active.array.range) : undefined;
        return {
            widgetId: this.id,
            title: this.title.label,
            hasDataset: this.blocks.length > 0,
            colorBy: { value: this.colorBy, options: this.colorByOptions() },
            colormap: {
                value: this.colormap,
                options: [...COLORMAP_NAMES],
                disabled: solid,
                invert: this.invert,
                logScale: { value: this.logScale, disabled: !logScaleAvailable(range ?? [0, 0]) }
            },
            component:
                !solid && active && active.array.components > 1
                    ? { value: this.component, options: componentOptions(active.array.components) }
                    : undefined,
            range:
                !solid && active && range && dataRange
                    ? { mode: this.rangeMode, min: range[0], max: range[1], dataMin: dataRange[0], dataMax: dataRange[1] }
                    : undefined,
            scalarBar: { visible: this.scalarBarVisible },
            solidColor: solid ? { value: this.solidColor } : undefined,
            background: { value: this.background },
            shading: { value: this.shading },
            clip: { state: this.clip, tab: this.clipTab },
            measure: { active: this.measure.active },
            opacity: { value: this.opacity, ...OPACITY_SPEC },
            pointSize: { value: this.pointSize, ...POINT_SIZE_SPEC },
            lineWidth: { value: this.lineWidth, ...LINE_WIDTH_SPEC }
        };
    }

    /** Apply a sidebar edit through the existing prop setters. */
    applyViewerSettings(patch: ViewerSettingsPatch): void {
        if (patch.clipTab !== undefined && patch.clipTab !== this.clipTab) {
            this.clipTab = patch.clipTab;
            this.update();
        }
        if (patch.measureActive !== undefined) {
            this.setMeasureActive(patch.measureActive);
        }
        if (patch.snap !== undefined) {
            this.snapViewerTo(viewerSnapDirection(patch.snap));
        }
        this.applyProps({
            colorBy: patch.colorBy,
            colormap: patch.colormap as ColormapName | undefined,
            solidColor: patch.solidColor,
            scalarBarVisible: patch.scalarBarVisible,
            background: patch.background,
            rangeMode: patch.range === undefined ? undefined : patch.range === 'auto' ? 'auto' : 'custom',
            customRange: typeof patch.range === 'object' ? [patch.range[0], patch.range[1]] : undefined,
            invert: patch.invert,
            logScale: patch.logScale,
            component: patch.component,
            opacity: patch.opacity,
            pointSize: patch.pointSize,
            lineWidth: patch.lineWidth,
            shading: patch.shading,
            clip: patch.clip
        });
    }

    /**
     * Color-by change resets the mapping state (component, range mode, log
     * scaling) so a new array starts from the data range, native-viewer parity.
     */
    private resetColorMapping(): void {
        this.component = MAGNITUDE_COMPONENT;
        this.rangeMode = 'auto';
        this.customRange = undefined;
        this.logScale = false;
    }

    /** Active color-by array (first block that carries it) plus its selector; undefined in Solid Color mode. */
    private activeColorArray(): { kind: 'point' | 'cell'; name: string; array: NativeVtkDataArray } | undefined {
        const selection = parseColorBy(this.colorBy);
        if (selection.kind === 'solid' || selection.arrayName === null) {
            return undefined;
        }
        const array = this.findArray(selection.kind, selection.arrayName);
        return array ? { kind: selection.kind, name: selection.arrayName, array } : undefined;
    }

    /** Data range of a color-by array merged across every block that carries it. */
    private mergedArrayRange(kind: 'point' | 'cell', name: string): [number, number] | undefined {
        let min = Infinity;
        let max = -Infinity;
        let found = false;
        for (const block of this.blocks) {
            const array = this.findArrayInBlock(block, kind, name);
            if (array) {
                found = true;
                min = Math.min(min, array.range[0]);
                max = Math.max(max, array.range[1]);
            }
        }
        return found ? [min, max] : undefined;
    }

    /** Effective mapping range for the active array (`auto` = merged data range). */
    private effectiveArrayRange(): [number, number] | undefined {
        const active = this.activeColorArray();
        if (!active) {
            return undefined;
        }
        const dataRange = this.mergedArrayRange(active.kind, active.name) ?? active.array.range;
        return resolveEffectiveRange(this.rangeMode, dataRange, this.customRange);
    }

    /** Scalar mapping for the current color state; undefined in Solid Color mode. */
    private scalarMapping(): ScalarMapping | undefined {
        const range = this.effectiveArrayRange();
        const definition = getColormap(this.colormap);
        if (!range || !definition) {
            return undefined;
        }
        return { definition, range, logScale: this.logScale, invert: this.invert, component: this.component };
    }

    /** Apply the background state to the live scene (no-op until the renderer exists). */
    private applyBackground(): void {
        if (this.scene) {
            this.scene.background = new THREE.Color(this.background);
        }
        this.renderScene();
    }

    // ------------------------------------------------------------------
    // DAGMC Outline sidebar API (single-direction sync: the panel reads
    // the snapshot and applies edits through these setters — the same
    // toggle-model calls the footer used to make, plus the widget-owned
    // canvas selection, never duplicated state)
    // ------------------------------------------------------------------

    /** Read the current visibility + selection for the outline panel. */
    getDagmcOutlineSnapshot(): DagmcOutlineSnapshot {
        const info = this.modelInfo;
        const volumes = this.blocks
            .map((block) => ({ block, volumeId: this.blockVolumeId(block) }))
            .filter((entry): entry is { block: DagmcBlockModel; volumeId: number } => entry.volumeId !== undefined)
            .sort((a, b) => a.volumeId - b.volumeId)
            .map(({ block, volumeId }) => {
                const meta = info?.volumes.find((volume) => volume.id === volumeId);
                const material = meta?.material;
                const groups = info ? groupsOfVolume(info, volumeId) : [];
                return {
                    id: volumeId,
                    label: formatDagmcOutlineVolumeLabel(volumeId),
                    material,
                    groups,
                    visible: this.isBlockVisible(block),
                    selected: this.selectedVolumeId === volumeId
                };
            });
        const materials = info
            ? Object.entries(info.materials)
                  .map(([name, meta]) => ({
                      name,
                      volumeCount: meta.volumeCount,
                      // The graveyard switch is an extra override on top of the
                      // material hidden-set: while it is off, the Graveyard
                      // material reads hidden even though it is not in the set.
                      visible:
                          !this.visibility.hiddenMaterials.includes(name) && (!isGraveyardMaterial(name) || this.visibility.showGraveyard)
                  }))
                  .sort((a, b) => a.name.localeCompare(b.name))
            : [];
        const groups = info
            ? Object.entries(info.groups)
                  .map(([name, meta]) => {
                      const memberMaterials = new Set(
                          meta.volumeIds.map((id) => info.volumes.find((volume) => volume.id === id)?.material)
                      );
                      const graveyardOnly =
                          meta.volumeIds.length > 0 &&
                          [...memberMaterials].every((material) => typeof material === 'string' && isGraveyardMaterial(material));
                      return {
                          name,
                          volumeCount: meta.volumeCount,
                          visible: !this.visibility.hiddenGroups.includes(name) && (!graveyardOnly || this.visibility.showGraveyard)
                      };
                  })
                  .sort((a, b) => a.name.localeCompare(b.name))
            : [];
        return {
            widgetId: this.id,
            title: this.title.label,
            hasDataset: this.blocks.length > 0,
            hasModelInfo: info !== undefined,
            volumes,
            materials,
            groups,
            showGraveyard: this.visibility.showGraveyard,
            visibleCount: this.visibleBlocks().length,
            totalCount: this.blocks.length,
            selectedVolumeId: this.selectedVolumeId
        };
    }

    /** Apply an outline edit through the existing visibility setters. */
    applyDagmcOutline(patch: DagmcOutlinePatch): void {
        if (patch.toggleVolume !== undefined) {
            this.setVisibility(toggleDagmcVolume(this.visibility, patch.toggleVolume));
        }
        if (patch.toggleMaterial !== undefined) {
            this.setVisibility(toggleDagmcMaterial(this.visibility, patch.toggleMaterial));
        }
        if (patch.toggleGroup !== undefined) {
            this.setVisibility(toggleDagmcGroup(this.visibility, patch.toggleGroup));
        }
        if (patch.showGraveyard !== undefined) {
            this.setVisibility(setDagmcShowGraveyard(this.visibility, patch.showGraveyard));
        }
        if (patch.showAll === true) {
            this.setVisibility(showAllDagmc(this.visibility));
        }
        if (patch.selectVolume !== undefined) {
            this.selectVolume(patch.selectVolume);
        }
    }

    /**
     * Outline/canvas selection entry point: highlight the volume's meshes
     * for a volume id (null clears). The widget owns the value; the outline
     * panel mirrors it from the snapshot.
     */
    selectVolume(id: number | null): void {
        if (id === this.selectedVolumeId) {
            return;
        }
        this.selectedVolumeId = id;
        this.applyHighlight();
        this.renderScene();
        this.fireOutlineChanged();
        this.update();
    }

    /** Notify the bound outline panel to re-read the snapshot. */
    protected fireOutlineChanged(): void {
        this.outlineChanged.fire(undefined);
    }

    /**
     * Instant-open entry: show the viewer tab with a loading overlay while
     * the `.h5m`→`.vtm` conversion runs, so the tab appears immediately
     * instead of waiting on `base.convert-dagmc-multiblock`.
     */
    beginPendingLoad(label: string, statusMessage: string, sourcePath?: string): void {
        this.vtmUri = undefined;
        this.blocks = [];
        this.modelInfo = undefined;
        this.classified = undefined;
        this.selectedVolumeId = null;
        this.genericFallback = undefined;
        this.pendingLabel = label;
        this.h5mSourcePath = sourcePath;
        this.title.label = `${DagmcViewerWidget.LABEL}: ${label}`;
        this.title.caption = `${DagmcViewerWidget.LABEL}: ${label}`;
        this.isLoading = true;
        this.error = undefined;
        this.statusMessage = statusMessage;
        this.fireOutlineChanged();
        this.update();
    }

    /** Fail the pending load in-tab (conversion failure shows the error panel, not a toast-only dead end). */
    failPendingLoad(message: string): void {
        this.isLoading = false;
        this.error = message;
        this.pendingLabel = undefined;
        this.fireOutlineChanged();
        this.update();
    }

    /** One-shot generic-viewer fallback the opener offers on the error panel (cleared on load). */
    setGenericFallback(handler: (() => void) | undefined): void {
        this.genericFallback = handler;
        this.update();
    }

    /** Load a `.vtm` manifest through Theia's FileService (no HTTP fetch). */
    async setVtmFile(uri: URI): Promise<void> {
        this.vtmUri = uri;
        this.id = `${DagmcViewerWidget.ID}:${uri.path.toString()}`;
        this.title.label = `${DagmcViewerWidget.LABEL}: ${uri.path.base}`;
        this.title.caption = `${DagmcViewerWidget.LABEL}: ${uri.path.toString()}`;
        const token = ++this.loadToken;
        this.isLoading = true;
        this.error = undefined;
        this.pendingLabel = uri.path.base;
        this.statusMessage = 'Reading multiblock manifest…';
        this.fireOutlineChanged();
        this.update();
        try {
            const text = await readVtkText(this.fileService, uri);
            if (token !== this.loadToken) {
                return;
            }
            await this.setVtmText(text, token);
        } catch (error) {
            if (token !== this.loadToken) {
                return;
            }
            this.isLoading = false;
            this.error = error instanceof Error ? error.message : String(error);
            this.pendingLabel = undefined;
            this.messageService.error(`Failed to load DAGMC manifest: ${this.error}`);
            this.fireOutlineChanged();
            this.update();
        }
    }

    /** Load an already-read `.vtm` manifest, expanding blocks via FileService. */
    async setVtmText(text: string, token = ++this.loadToken): Promise<void> {
        this.isLoading = true;
        this.error = undefined;
        this.statusMessage = 'Expanding multiblock volumes…';
        this.update();
        try {
            const refs = parseVtmManifest(text);
            const models: DagmcBlockModel[] = [];
            for (const ref of refs) {
                const blockUri = this.vtmUri ? this.vtmUri.parent.resolve(ref.file) : undefined;
                if (!blockUri) {
                    throw new Error(`Cannot resolve block '${ref.name}': no manifest URI is set`);
                }
                this.statusMessage = `Reading ${ref.name}…`;
                this.update();
                const text = await readVtkText(this.fileService, blockUri);
                if (token !== this.loadToken) {
                    return;
                }
                models.push(await parseBlockDataset(ref.file, text, ref.name, ref.index));
            }
            if (token !== this.loadToken) {
                return;
            }
            this.blocks = models.sort((a, b) => a.blockIndex - b.blockIndex);
            this.classified = classifyNativeVtkArrays(this.blocks.flatMap((block) => [...block.pointArrays, ...block.cellArrays]));
            const fallback = this.blocks.length > 0 ? defaultNativeColorBy(this.classified, 'polydata') : undefined;
            if (!this.hasArray(this.colorBy)) {
                this.colorBy = fallback ?? SOLID_COLOR;
                this.resetColorMapping();
            }
            this.note = '';
            this.isLoading = false;
            this.statusMessage = '';
            this.pendingLabel = undefined;
            this.genericFallback = undefined;
            this.selectedVolumeId = null;
            this.buildScene();
            this.fireOutlineChanged();
            this.update();
        } catch (error) {
            if (token !== this.loadToken) {
                return;
            }
            this.isLoading = false;
            this.error = error instanceof Error ? error.message : String(error);
            this.pendingLabel = undefined;
            this.messageService.error(`Failed to expand DAGMC multiblock: ${this.error}`);
            this.fireOutlineChanged();
            this.update();
        }
    }

    /** Store validated `dagmc.info` model metadata driving the toggle panel. */
    setModelInfo(value: unknown): void {
        this.modelInfo = parseDagmcModelInfo(value);
        this.buildScene();
        this.fireOutlineChanged();
        this.update();
    }

    /** Download a PNG screenshot of the current canvas. */
    saveScreenshot(): void {
        if (!this.renderer || this.blocks.length === 0) {
            return;
        }
        this.renderScene();
        const url = this.renderer.domElement.toDataURL('image/png');
        const link = document.createElement('a');
        link.href = url;
        link.download = `${this.vtmUri?.path.base ?? 'dagmc'}.png`;
        link.click();
    }

    /** Frame all visible blocks through the orbit controls (target + distance). */
    fitView(): void {
        const bounds = mergeDagmcBounds(this.visibleBlocks());
        if (!bounds || !this.camera || !this.orbitControls) {
            return;
        }
        this.orbitControls.fitBounds(bounds.min, bounds.max);
    }

    // ------------------------------------------------------------------
    // Visibility helpers
    // ------------------------------------------------------------------

    /** Volume id for `Volume_<id>` block names; unknown schemes stay visible. */
    protected blockVolumeId(block: DagmcBlockModel): number | undefined {
        const match = VOLUME_BLOCK_RE.exec(block.blockName);
        return match ? parseInt(match[1], 10) : undefined;
    }

    protected isBlockVisible(block: DagmcBlockModel): boolean {
        const volumeId = this.blockVolumeId(block);
        // Direct volume toggles apply even without model info (block-name
        // rows in the outline); material/group/graveyard need the payload.
        if (volumeId !== undefined && this.visibility.hiddenVolumes.includes(volumeId)) {
            return false;
        }
        if (!this.modelInfo) {
            return true;
        }
        return volumeId === undefined || isDagmcVolumeVisible(this.visibility, this.modelInfo, volumeId);
    }

    protected visibleBlocks(): DagmcBlockModel[] {
        return this.blocks.filter((block) => this.isBlockVisible(block));
    }

    protected setVisibility(visibility: DagmcVisibility): void {
        this.visibility = visibility;
        this.buildScene();
        this.fireOutlineChanged();
        this.update();
    }

    // ------------------------------------------------------------------
    // React rendering
    // ------------------------------------------------------------------

    protected render(): React.ReactNode {
        return <div className="openmc-output-viewer-container">{this.error ? this.renderError() : this.renderContent()}</div>;
    }

    protected renderContent(): React.ReactNode {
        if (this.isLoading && this.blocks.length === 0) {
            return (
                <div className="openmc-output-viewer-status" style={{ position: 'relative' }}>
                    <NukeLoadingOverlay
                        message={this.statusMessage || 'Loading…'}
                        subMessage={this.pendingLabel ?? this.vtmUri?.path.base}
                    />
                </div>
            );
        }
        return (
            <>
                <div className="openmc-output-viewer-viewarea">
                    <div className="openmc-output-viewer-hint nuke-viewer-status-line">
                        {this.describeBlocks()}
                        {this.note ? ` — ${this.note}` : ''} Drag to orbit, wheel to zoom, right-drag to pan.
                        {this.measure.active ? ' Measure mode: click two surface points; Escape cancels.' : ''}
                    </div>
                    <div style={{ flex: '1', minHeight: '0', position: 'relative', display: 'flex' }}>
                        <div ref={this.attachHost} style={{ flex: '1', minHeight: '0', position: 'relative' }} />
                        {this.renderViewBadge()}
                        {this.renderNavCluster()}
                        {this.renderGizmo()}
                        {this.renderMeasureLabel()}
                        {this.renderLegend()}
                    </div>
                </div>
            </>
        );
    }

    /**
     * Shared viewer bottom bar over the 3D viewarea, driving the orbit
     * handle. Clip/shading quick-access popovers ride as `children` (the
     * same extension point CAD extras use): the triggers open anchored
     * cards whose controls call the existing prop and visibility setters —
     * stateless mirrors of the sidebars, never new state.
     *
     * The one-click X-plane section button is folded into the Clip card
     * (per-axis enable covers it); Exclude/Isolate stay direct buttons
     * (transient canvas selection, no CAD popover analog).
     */
    protected renderNavCluster(): React.ReactNode {
        const disabled = this.isLoading || this.blocks.length === 0;
        return (
            <>
                <ViewerNavBar
                    ref={(element) => {
                        this.navBarElement = element;
                    }}
                    disabled={disabled}
                    onAction={(action) => this.handleNavAction(action)}
                >
                    <ViewerClipTrigger
                        clipEnabled={anyClipEnabled(this.clip)}
                        open={this.openNavPopover === 'clip'}
                        disabled={disabled}
                        onToggle={() => this.toggleNavPopover('clip')}
                    />
                    <ViewerShadingTrigger
                        shading={this.shading}
                        open={this.openNavPopover === 'shading'}
                        disabled={disabled}
                        onToggle={() => this.toggleNavPopover('shading')}
                    />
                    <DagmcIsolateActions
                        selectedVolumeId={this.selectedVolumeId}
                        disabled={disabled}
                        onExclude={() => this.excludeSelectedVolume()}
                        onIsolate={() => this.isolateSelectedVolume()}
                    />
                    <ViewerFileActions
                        disabled={disabled}
                        onScreenshot={() => this.saveScreenshot()}
                        onReload={() => this.vtmUri && this.setVtmFile(this.vtmUri)}
                    />
                </ViewerNavBar>
                {this.openNavPopover === 'clip' && (
                    <ViewerNavPopoverShell
                        popoverRef={(element) => {
                            this.navPopoverElement = element;
                        }}
                    >
                        <ViewerClipPopover
                            clip={this.clip}
                            tab={this.clipTab}
                            disabled={disabled}
                            onTabChange={(axis) => this.setClipTab(axis)}
                            onAxisChange={(axis, patch) => this.updateClipAxis(axis, patch)}
                        />
                    </ViewerNavPopoverShell>
                )}
                {this.openNavPopover === 'shading' && (
                    <ViewerNavPopoverShell
                        popoverRef={(element) => {
                            this.navPopoverElement = element;
                        }}
                    >
                        <ViewerShadingPopover
                            shading={this.shading}
                            disabled={disabled}
                            onSelect={(mode) => this.selectShadingMode(mode)}
                        />
                    </ViewerNavPopoverShell>
                )}
            </>
        );
    }

    /** Toggle the open popover slot (re-click closes, the other trigger switches). */
    private toggleNavPopover(kind: ViewerNavPopoverKind): void {
        this.openNavPopover = nextNavPopover(this.openNavPopover, kind);
        this.update();
    }

    /** Close the open popover card (Escape / outside-click dismissal). */
    private closeNavPopover(): void {
        if (this.openNavPopover !== undefined) {
            this.openNavPopover = undefined;
            this.update();
        }
    }

    /** Clip-card axis tab through the widget-owned tab (the sidebar shows the same tab). */
    private setClipTab(tab: ClipAxis): void {
        if (tab !== this.clipTab) {
            this.clipTab = tab;
            this.update();
        }
    }

    /** Clip-card axis edit through the existing clip prop (sidebar stays authoritative). */
    private updateClipAxis(axis: ClipAxis, patch: Partial<AxisClipState>): void {
        this.applyProps({ clip: updateAxisClip(this.clip, axis, patch) });
    }

    /** Shading-card pick through the existing shading prop (closes the card, CAD parity). */
    private selectShadingMode(mode: ViewerShadingMode): void {
        this.applyProps({ shading: mode });
        this.closeNavPopover();
    }

    /** Hide the selected volume through the existing visibility setter, then clear the canvas selection. */
    private excludeSelectedVolume(): void {
        const id = this.selectedVolumeId;
        if (id === null) {
            return;
        }
        this.setVisibility(toggleDagmcVolume(this.visibility, id));
        this.selectVolume(null);
    }

    /**
     * Hide every volume but the selected one through the existing visibility
     * setter. Isolating a graveyard volume also enables the Graveyard
     * switch, otherwise the canvas goes blank (the switch overrides every
     * volume flag while off).
     */
    private isolateSelectedVolume(): void {
        const id = this.selectedVolumeId;
        if (id === null) {
            return;
        }
        let visibility = this.visibility;
        const material = this.modelInfo?.volumes.find((volume) => volume.id === id)?.material;
        if (material !== undefined && isGraveyardMaterial(material) && !visibility.showGraveyard) {
            visibility = setDagmcShowGraveyard(visibility, true);
        }
        this.setVisibility(isolateDagmcVolume(visibility, id, this.knownVolumeIds()));
    }

    /** Volume ids behind the loaded blocks (block-name fallback included, so isolation works without model info). */
    private knownVolumeIds(): number[] {
        const ids: number[] = [];
        for (const block of this.blocks) {
            const volumeId = this.blockVolumeId(block);
            if (volumeId !== undefined && !ids.includes(volumeId)) {
                ids.push(volumeId);
            }
        }
        return ids;
    }

    /** Dataset badge over the 3D viewarea (hidden until volumes load). */
    protected renderViewBadge(): React.ReactNode {
        if (this.blocks.length === 0) {
            return undefined;
        }
        return <ViewBadge text={this.vtmUri?.path.base ?? 'DAGMC volumes'} />;
    }

    /** Shared orientation cube over the 3D viewarea (hidden until volumes load). */
    protected renderGizmo(): React.ReactNode {
        if (this.blocks.length === 0) {
            return undefined;
        }
        return (
            <ViewCube
                ref={(handle) => {
                    this.gizmo = handle;
                }}
                onSnap={(direction) => this.orbitControls?.setViewDirection(direction)}
            />
        );
    }

    /** Distance-measure label over the 3D viewarea (hidden until volumes load; positioned imperatively). */
    protected renderMeasureLabel(): React.ReactNode {
        if (this.blocks.length === 0) {
            return undefined;
        }
        return (
            <ViewerMeasureLabel
                ref={(handle) => {
                    this.measureLabel = handle;
                }}
            />
        );
    }

    /** Raycast-pick threshold from the visible bounds (points/lines need a world-size tolerance). */
    private measurePickTolerance(): number {
        const bounds = mergeDagmcBounds(this.visibleBlocks());
        if (!bounds) {
            return this.measureMarkerSize;
        }
        const dx = bounds.max[0] - bounds.min[0];
        const dy = bounds.max[1] - bounds.min[1];
        const dz = bounds.max[2] - bounds.min[2];
        return Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz) * 0.01, 1e-9);
    }

    /** Canvas click while the measure tool is active: raycast the block meshes and record the surface point. */
    private onMeasureClick = (event: MouseEvent): void => {
        if (!this.measure.active || event.button !== 0) {
            return;
        }
        const canvas = this.renderer?.domElement;
        const camera = this.camera;
        const dataGroup = this.dataGroup;
        if (!canvas || !camera || !dataGroup) {
            return;
        }
        const rect = canvas.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            return;
        }
        const ndc = new THREE.Vector2(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1
        );
        const raycaster = new THREE.Raycaster();
        raycaster.params.Points.threshold = this.measurePickTolerance();
        raycaster.params.Line.threshold = this.measurePickTolerance();
        raycaster.setFromCamera(ndc, camera);
        // Block meshes only (never the measure overlay itself): a miss leaves
        // the session untouched so stray clicks cannot commit bogus pairs.
        const hit = raycaster.intersectObjects(dataGroup.children, true)[0];
        if (!hit) {
            return;
        }
        const point: MeasurePoint3D = [hit.point.x, hit.point.y, hit.point.z];
        const next = addMeasurePoint(this.measure, point);
        if (next !== this.measure) {
            this.measure = next;
            this.syncMeasureScene();
            this.update();
        }
    };

    /**
     * Outside-click dismissal for the nav popover (CAD canvas-click parity,
     * generalized): a pointer-down outside both the bottom bar (triggers
     * live there, so re-clicks toggle instead of closing first) and the
     * open card closes it. Window capture phase so canvas drags dismiss
     * immediately; propagation continues so orbit/measure still work.
     */
    private onWindowPointerDown = (event: PointerEvent): void => {
        if (this.openNavPopover === undefined) {
            return;
        }
        if (!(event.target instanceof Node)) {
            return;
        }
        if (this.navBarElement?.contains(event.target) === true || this.navPopoverElement?.contains(event.target) === true) {
            return;
        }
        this.closeNavPopover();
    };

    /**
     * Escape while focus is inside this widget: close the open nav popover
     * first (CAD parity — the card never steals canvas shortcuts; focus is
     * never moved into it), else cancel the measure step. Window capture
     * phase (like nuke-cad's viewport keys) so Theia's own Escape bindings
     * do not swallow it; propagation stops only when something was actually
     * dismissed.
     */
    private onWindowKeyDown = (event: KeyboardEvent): void => {
        if (event.key !== 'Escape') {
            return;
        }
        if (!(event.target instanceof Node) || !this.node.contains(event.target)) {
            return;
        }
        if (this.openNavPopover !== undefined) {
            this.closeNavPopover();
            event.stopPropagation();
            event.preventDefault();
            return;
        }
        const next = cancelMeasureStep(this.measure);
        if (next !== this.measure) {
            this.measure = next;
            this.syncMeasureScene();
            this.update();
            event.stopPropagation();
            event.preventDefault();
        }
    };

    /** Lazily create the world-anchored measure overlay group (line + endpoint spheres live outside the data group). */
    private ensureMeasureGroup(): THREE.Group | undefined {
        if (!this.scene) {
            return undefined;
        }
        if (!this.measureGroup) {
            this.measureGroup = new THREE.Group();
            this.measureGroup.name = 'measure-overlay';
            this.scene.add(this.measureGroup);
        }
        return this.measureGroup;
    }

    /** Dispose every measure overlay object (geometries + materials). */
    private clearMeasureSceneObjects(): void {
        const group = this.measureGroup;
        if (!group) {
            return;
        }
        while (group.children.length > 0) {
            const child = group.children.pop();
            if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
                child.geometry.dispose();
                (child.material as THREE.Material).dispose();
            }
        }
    }

    /** Rebuild the 3D annotation from the session: pending sphere, or segment line + two spheres. */
    private syncMeasureScene(): void {
        const group = this.ensureMeasureGroup();
        if (!group) {
            return;
        }
        this.clearMeasureSceneObjects();
        const color = 0xe8a400;
        const addSphere = (point: MeasurePoint3D): void => {
            const geometry = new THREE.SphereGeometry(this.measureMarkerSize, 16, 12);
            const material = new THREE.MeshBasicMaterial({ color });
            const sphere = new THREE.Mesh(geometry, material);
            sphere.position.set(point[0], point[1], point[2]);
            group.add(sphere);
        };
        const segment = this.measure.segment;
        if (segment) {
            const geometry = new THREE.BufferGeometry().setFromPoints([
                new THREE.Vector3(segment.a[0], segment.a[1], segment.a[2]),
                new THREE.Vector3(segment.b[0], segment.b[1], segment.b[2])
            ]);
            group.add(new THREE.Line(geometry, new THREE.LineBasicMaterial({ color })));
            addSphere(segment.a);
            addSphere(segment.b);
        } else if (this.measure.pending) {
            addSphere(this.measure.pending);
        }
        this.renderScene();
    }

    /** Re-project the measure label for the current camera (direct DOM writes, never React state). */
    private updateMeasureLabel(): void {
        const label = this.measureLabel;
        const camera = this.camera;
        const host = this.host;
        if (!label || !camera || !host) {
            return;
        }
        const segment = this.measure.segment;
        if (!segment || this.blocks.length === 0) {
            label.setLabel(0, 0, '', false);
            return;
        }
        camera.updateMatrixWorld();
        // Scratch matrix (never allocated per frame): the camera loop must
        // not churn the GC on large-model orbits.
        scratchViewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        const projected = projectMeasurePoint(segment.midpoint, scratchViewProjection.elements, host.clientWidth, host.clientHeight);
        label.setLabel(projected.x, projected.y, formatMeasureDistance(segment.distance), projected.visible);
    }

    private handleNavAction(action: ViewerNavAction): void {
        if (action === 'fit') {
            this.fitView();
            return;
        }
        if (action === 'zoom-in') {
            this.orbitControls?.zoomBy(0.8);
            return;
        }
        if (action === 'zoom-out') {
            this.orbitControls?.zoomBy(1.25);
            return;
        }
        this.orbitControls?.setViewDirection(standardViewDirection(action));
    }

    protected renderLegend(): React.ReactNode {
        if (!this.scalarBarVisible) {
            return undefined;
        }
        const active = this.activeColorArray();
        const mapping = this.scalarMapping();
        if (!active || !mapping) {
            return undefined;
        }
        return (
            <div className="nuke-viewer-legend-anchor">
                <Tooltip
                    content={`${active.array.name}: ${formatRangeValue(mapping.range[0])} to ${formatRangeValue(mapping.range[1])}`}
                    position="top"
                    stretch
                >
                    <div className="nuke-viewer-legend">
                        <div className="nuke-viewer-legend-title">{active.array.name}</div>
                        <div className="nuke-viewer-legend-bar" style={{ background: mappingToCssGradient(mapping) }} />
                        <div className="nuke-viewer-legend-range">
                            <span>{formatRangeValue(mapping.range[0])}</span>
                            <span>{formatRangeValue(mapping.range[1])}</span>
                        </div>
                    </div>
                </Tooltip>
            </div>
        );
    }

    protected renderError(): React.ReactNode {
        return (
            <div className="openmc-output-viewer-status error">
                <i className={codicon('error')}></i>
                <span>{this.error}</span>
                {this.vtmUri && (
                    <button className="theia-button secondary" onClick={() => this.vtmUri && this.setVtmFile(this.vtmUri)}>
                        <i className={codicon('refresh')}></i>
                        Retry
                    </button>
                )}
                {this.genericFallback && (
                    <button className="theia-button secondary" onClick={() => this.genericFallback?.()}>
                        <i className={codicon('folder-opened')}></i>
                        Open in generic viewer
                    </button>
                )}
            </div>
        );
    }

    // ------------------------------------------------------------------
    // three.js scene (rebuilt on structure change; recolor rewrites colors)
    // ------------------------------------------------------------------

    protected onAfterAttach(msg: Message): void {
        super.onAfterAttach(msg);
        this.ensureRenderer();
        if (!this.measureKeysAttached) {
            window.addEventListener('keydown', this.onWindowKeyDown, true);
            window.addEventListener('pointerdown', this.onWindowPointerDown, true);
            this.measureKeysAttached = true;
        }
    }

    protected onBeforeDetach(msg: Message): void {
        if (this.measureKeysAttached) {
            window.removeEventListener('keydown', this.onWindowKeyDown, true);
            window.removeEventListener('pointerdown', this.onWindowPointerDown, true);
            this.measureKeysAttached = false;
        }
        this.teardownRenderer();
        super.onBeforeDetach(msg);
    }

    override dispose(): void {
        this.loadToken++;
        this.outlineChanged.dispose();
        this.teardownRenderer();
        super.dispose();
    }

    protected onResize(msg: Widget.ResizeMessage): void {
        super.onResize(msg);
        this.resizeRenderer();
    }

    private attachHost = (element: HTMLElement | null): void => {
        this.host = element ?? undefined;
        this.ensureRenderer();
    };

    private ensureRenderer(): void {
        if (this.renderer || !this.host || !this.isAttached) {
            return;
        }
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
        this.renderer.domElement.style.width = '100%';
        this.renderer.domElement.style.height = '100%';
        this.renderer.domElement.style.display = 'block';
        // Focusable canvas (same rationale as the native VTK viewer): a click
        // focuses it so the window-capture Escape handler sees key events
        // targeted inside this widget.
        this.renderer.domElement.tabIndex = 0;
        this.renderer.domElement.addEventListener('pointerdown', () => this.renderer?.domElement.focus());
        this.renderer.localClippingEnabled = true;
        this.host.appendChild(this.renderer.domElement);
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(this.background);
        this.scene.add(new THREE.AmbientLight(0xffffff, 0.9));
        const directional = new THREE.DirectionalLight(0xffffff, 1.2);
        directional.position.set(1, 2, 3);
        this.scene.add(directional);
        this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1e9);
        this.attachOrbitControls();
        this.attachContextMenu(this.renderer.domElement);
        this.attachPickHandlers(this.renderer.domElement);
        this.renderer.domElement.addEventListener('click', this.onMeasureClick);
        this.resizeObserver = new ResizeObserver(() => this.resizeRenderer());
        if (this.host) {
            this.resizeObserver.observe(this.host);
        }
        this.resizeRenderer();
        if (this.blocks.length > 0) {
            this.buildScene();
        } else {
            this.renderScene();
        }
    }

    private teardownRenderer(): void {
        this.contextMenuClose?.();
        this.contextMenuClose = undefined;
        this.resizeObserver?.disconnect();
        this.resizeObserver = undefined;
        this.orbitControls?.dispose();
        this.orbitControls = undefined;
        if (this.renderer) {
            this.renderer.dispose();
            this.renderer.domElement.remove();
            this.renderer = undefined;
        }
        this.scene = undefined;
        this.camera = undefined;
        this.dataGroup = undefined;
        this.measureGroup = undefined;
    }

    private resizeRenderer(): void {
        if (!this.renderer || !this.camera || !this.host) {
            return;
        }
        const width = Math.max(1, this.host.clientWidth);
        const height = Math.max(1, this.host.clientHeight);
        this.renderer.setSize(width, height, false);
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.renderScene();
    }

    private renderScene(): void {
        if (this.renderer && this.scene && this.camera) {
            this.renderer.render(this.scene, this.camera);
        }
        this.updateGizmo();
        this.updateMeasureLabel();
    }

    /** Re-project the cube axes for the current camera (direct DOM writes, never React state). */
    private updateGizmo(): void {
        const gizmo = this.gizmo;
        const camera = this.camera;
        if (!gizmo || !camera || this.blocks.length === 0) {
            return;
        }
        const quaternion = camera.quaternion;
        gizmo.update({ quaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w] });
    }

    private disposeGroup(group: THREE.Group): void {
        group.traverse((child) => {
            if (child instanceof THREE.Mesh || child instanceof THREE.Points || child instanceof THREE.LineSegments) {
                child.geometry.dispose();
                const material = child.material as THREE.Material;
                material.dispose();
            }
        });
    }

    /** Rebuild the data group from the visible blocks (new dataset or toggle change). */
    private buildScene(): void {
        if (!this.scene || !this.camera) {
            return;
        }
        if (this.dataGroup) {
            this.scene.remove(this.dataGroup);
            this.disposeGroup(this.dataGroup);
            this.dataGroup = undefined;
        }
        // Rebuild clears the measure session (viewport state, never document
        // state); the label hides on the next repaint via updateMeasureLabel.
        this.measure = resetMeasureState();
        this.clearMeasureSceneObjects();
        this.measureMarkerSize = this.measurePickTolerance();
        this.dataGroup = new THREE.Group();
        for (const block of this.visibleBlocks()) {
            const group = new THREE.Group();
            group.name = `block:${block.blockIndex}`;
            for (const object of this.buildBlockObjects(block)) {
                group.add(object);
            }
            this.dataGroup.add(group);
        }
        this.scene.add(this.dataGroup);
        this.fitView();
        this.recolor();
        this.applyClip();
        this.applyShadingVisibility();
        this.applyHighlight();
        this.syncMaterialProps();
        this.renderScene();
    }

    private buildBlockObjects(block: DagmcBlockModel): THREE.Object3D[] {
        if (block.triangles && block.triangles.length > 0) {
            // Mesh blocks also carry a point cloud over the same vertices
            // (shared position buffer, zero-copy) so `points` shading mode has
            // something to show; visibility picks the representation.
            const positions = this.blockMeshPositions(block);
            return [this.buildBlockMesh(block, positions), this.buildBlockEdges(block), this.buildBlockPointCloud(block, positions)];
        }
        if (block.segments && block.segments.length > 0) {
            return [this.buildBlockLines(block)];
        }
        return [this.buildBlockPoints(block)];
    }

    private makeColorAttribute(count: number): THREE.BufferAttribute {
        return new THREE.BufferAttribute(new Float32Array(count * 3), 3);
    }

    /** Expanded per-vertex positions for triangle-mesh blocks. */
    private blockMeshPositions(block: DagmcBlockModel): Float32Array {
        const triangles = block.triangles ?? new Uint32Array(0);
        const positions = new Float32Array(triangles.length * 3);
        for (let i = 0; i < triangles.length; i++) {
            const point = triangles[i] * 3;
            positions[i * 3] = block.positions[point];
            positions[i * 3 + 1] = block.positions[point + 1];
            positions[i * 3 + 2] = block.positions[point + 2];
        }
        return positions;
    }

    private buildBlockMesh(block: DagmcBlockModel, positions: Float32Array): THREE.Mesh {
        const triangles = block.triangles ?? new Uint32Array(0);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', this.makeColorAttribute(triangles.length));
        geometry.computeVertexNormals();
        geometry.userData = { blockIndex: block.blockIndex, kind: 'mesh' as DagmcRenderKind };
        const material = new THREE.MeshLambertMaterial({
            vertexColors: true,
            transparent: true,
            opacity: this.opacity,
            side: THREE.DoubleSide
        });
        return new THREE.Mesh(geometry, material);
    }

    /** Point cloud over mesh vertices (shares the mesh position buffer); shown in `points` mode. */
    private buildBlockPointCloud(block: DagmcBlockModel, positions: Float32Array): THREE.Points {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', this.makeColorAttribute(positions.length / 3));
        geometry.userData = { blockIndex: block.blockIndex, kind: 'mesh' as DagmcRenderKind, role: 'mesh-points' };
        const material = new THREE.PointsMaterial({
            size: this.pointSize,
            vertexColors: true,
            transparent: true,
            opacity: this.opacity,
            sizeAttenuation: false,
            depthWrite: false
        });
        return new THREE.Points(geometry, material);
    }

    private buildBlockEdges(block: DagmcBlockModel): THREE.LineSegments {
        const triangles = block.triangles ?? new Uint32Array(0);
        const pairs: number[] = [];
        for (let t = 0; t + 2 < triangles.length; t += 3) {
            pairs.push(triangles[t], triangles[t + 1], triangles[t + 1], triangles[t + 2], triangles[t + 2], triangles[t]);
        }
        const positions = new Float32Array(pairs.length * 3);
        for (let i = 0; i < pairs.length; i++) {
            const point = pairs[i] * 3;
            positions[i * 3] = block.positions[point];
            positions[i * 3 + 1] = block.positions[point + 1];
            positions[i * 3 + 2] = block.positions[point + 2];
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', this.makeColorAttribute(pairs.length));
        geometry.userData = { blockIndex: block.blockIndex, kind: 'edges' as DagmcRenderKind };
        const material = new THREE.LineBasicMaterial({
            vertexColors: true,
            transparent: true,
            opacity: Math.min(1, this.opacity + 0.2),
            linewidth: this.lineWidth
        });
        return new THREE.LineSegments(geometry, material);
    }

    private buildBlockLines(block: DagmcBlockModel): THREE.LineSegments {
        const segments = block.segments ?? new Uint32Array(0);
        const positions = new Float32Array(segments.length * 3);
        for (let i = 0; i < segments.length; i++) {
            const point = segments[i] * 3;
            positions[i * 3] = block.positions[point];
            positions[i * 3 + 1] = block.positions[point + 1];
            positions[i * 3 + 2] = block.positions[point + 2];
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', this.makeColorAttribute(segments.length));
        geometry.userData = { blockIndex: block.blockIndex, kind: 'lines' as DagmcRenderKind };
        const material = new THREE.LineBasicMaterial({
            vertexColors: true,
            transparent: true,
            opacity: this.opacity,
            linewidth: this.lineWidth
        });
        return new THREE.LineSegments(geometry, material);
    }

    private buildBlockPoints(block: DagmcBlockModel): THREE.Points {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(block.positions.slice(), 3));
        geometry.setAttribute('color', this.makeColorAttribute(block.positions.length / 3));
        geometry.userData = { blockIndex: block.blockIndex, kind: 'points' as DagmcRenderKind };
        const material = new THREE.PointsMaterial({
            size: this.pointSize,
            vertexColors: true,
            transparent: true,
            opacity: this.opacity,
            sizeAttenuation: false,
            depthWrite: false
        });
        return new THREE.Points(geometry, material);
    }

    /**
     * Data-tuple index per render vertex for one object kind (-1 = solid).
     * Mesh/edge vertices map through the triangle index; line vertices map
     * through segment endpoints/cells; point vertices map by position index.
     */
    private tupleMap(block: DagmcBlockModel, kind: DagmcRenderKind, association: 'point' | 'cell'): Int32Array {
        if (kind === 'mesh' || kind === 'edges') {
            const triangles = block.triangles ?? new Uint32Array(0);
            const perTri = kind === 'mesh' ? 3 : 6;
            const triCount = Math.floor(triangles.length / 3);
            const map = new Int32Array(triCount * perTri).fill(-1);
            const tupleCount = association === 'point' ? block.nPoints : this.cellTupleCount(block);
            for (let t = 0; t < triCount; t++) {
                for (let k = 0; k < perTri; k++) {
                    const point = kind === 'mesh' ? triangles[t * 3 + k] : triangles[t * 3 + [0, 1, 1, 2, 2, 0][k]];
                    const tuple = association === 'point' ? point : block.triangleCells ? block.triangleCells[t] : t;
                    map[t * perTri + k] = tuple >= 0 && tuple < tupleCount ? tuple : -1;
                }
            }
            return map;
        }
        if (kind === 'lines') {
            const segments = block.segments ?? new Uint32Array(0);
            const map = new Int32Array(segments.length).fill(-1);
            const tupleCount = association === 'point' ? block.nPoints : this.cellTupleCount(block);
            for (let v = 0; v < segments.length; v++) {
                const tuple =
                    association === 'point'
                        ? segments[v]
                        : block.segmentCells && block.segmentCells.length * 2 === segments.length
                          ? block.segmentCells[Math.floor(v / 2)]
                          : -1;
                map[v] = tuple >= 0 && tuple < tupleCount ? tuple : -1;
            }
            return map;
        }
        const count = Math.floor(block.positions.length / 3);
        const map = new Int32Array(count).fill(-1);
        const tupleCount = association === 'point' ? block.nPoints : this.cellTupleCount(block);
        for (let v = 0; v < count; v++) {
            map[v] = v < tupleCount ? v : -1;
        }
        return map;
    }

    private cellTupleCount(block: DagmcBlockModel): number {
        const first = block.cellArrays[0];
        return first ? Math.floor(first.values.length / Math.max(1, first.components)) : 0;
    }

    /**
     * Instant recolor: rewrite vertex colors from the current color-by array
     * and the shared scalar-mapping pipeline (component picker, effective
     * range, log/invert). No reload, no server restart.
     */
    private recolor(): void {
        if (!this.dataGroup) {
            return;
        }
        this.note = '';
        const selection = parseColorBy(this.colorBy);
        const solid = new THREE.Color(this.solidColor);
        const mapping = this.scalarMapping();
        this.dataGroup.children.forEach((group) => {
            const block = this.blocks.find((entry) => `block:${entry.blockIndex}` === group.name);
            if (!block) {
                return;
            }
            const array =
                selection.kind !== 'solid' && selection.arrayName !== null
                    ? this.findArrayInBlock(block, selection.kind, selection.arrayName)
                    : undefined;
            if (selection.kind !== 'solid' && !array) {
                this.note = `'${this.colorBy}' is not in every block — missing blocks show Solid Color`;
            }
            group.children.forEach((child) => {
                if (!(child instanceof THREE.Mesh || child instanceof THREE.Points || child instanceof THREE.LineSegments)) {
                    return;
                }
                const geometry = child.geometry as THREE.BufferGeometry;
                const colors = geometry.getAttribute('color') as THREE.BufferAttribute;
                const map = array ? this.tupleMap(block, geometry.userData['kind'] as DagmcRenderKind, array.association) : undefined;
                for (let i = 0; i < colors.count; i++) {
                    let r = solid.r;
                    let g = solid.g;
                    let b = solid.b;
                    if (array && map && map[i] >= 0 && mapping) {
                        const value = tupleScalar(array.values, array.components, map[i], this.component);
                        const mapped = mapScalar(value, mapping);
                        if (mapped) {
                            [r, g, b] = mapped;
                        }
                    }
                    colors.setXYZ(i, r, g, b);
                }
                colors.needsUpdate = true;
            });
        });
    }

    /**
     * Outline↔canvas highlight sync: recolor only. The selected volume's
     * meshes keep their base vertex colors but glow (emissive); every other
     * mesh returns to no emission. Runs after every rebuild like the
     * geometry-native `applyHighlight`.
     */
    private applyHighlight(): void {
        if (!this.dataGroup) {
            return;
        }
        const selected = this.selectedVolumeId;
        const volumeOf = new Map<number, number>();
        for (const block of this.blocks) {
            const volumeId = this.blockVolumeId(block);
            if (volumeId !== undefined) {
                volumeOf.set(block.blockIndex, volumeId);
            }
        }
        this.dataGroup.children.forEach((group) => {
            const match = /^block:(\d+)$/.exec(group.name);
            const volumeId = match ? volumeOf.get(parseInt(match[1], 10)) : undefined;
            group.children.forEach((child) => {
                if (child instanceof THREE.Mesh) {
                    const material = child.material as THREE.MeshLambertMaterial;
                    material.emissive = new THREE.Color(volumeId !== undefined && volumeId === selected ? 0x664400 : 0x000000);
                }
            });
        });
    }

    /** Apply the viewer-core per-axis clip state to every block material. */
    private applyClip(): void {
        if (!this.dataGroup) {
            return;
        }
        const planes = this.toThreePlanes();
        this.dataGroup.traverse((child) => {
            if (child instanceof THREE.Mesh || child instanceof THREE.Points || child instanceof THREE.LineSegments) {
                (child.material as THREE.Material).clippingPlanes = planes;
            }
        });
    }

    private toThreePlanes(): THREE.Plane[] {
        const bounds = mergeDagmcBounds(this.visibleBlocks());
        if (!bounds) {
            return [];
        }
        return toThreePlaneParamsArray(this.clip, bounds).map(
            (params) => new THREE.Plane(new THREE.Vector3(...params.normal), params.constant)
        );
    }

    private syncMaterialProps(): void {
        const flags = resolveViewerShadingFlags(this.shading, this.opacity);
        this.dataGroup?.traverse((child) => {
            if (child instanceof THREE.Points) {
                const material = child.material as THREE.PointsMaterial;
                material.size = this.pointSize;
                material.opacity = flags.opacity;
                material.transparent = flags.transparent;
            } else if (child instanceof THREE.LineSegments) {
                const material = child.material as THREE.LineBasicMaterial;
                material.opacity = flags.opacity;
                material.transparent = flags.transparent;
                material.depthWrite = flags.depthWrite;
                material.linewidth = this.lineWidth;
            } else if (child instanceof THREE.Mesh) {
                const material = child.material as THREE.MeshLambertMaterial;
                material.wireframe = flags.wireframe;
                material.opacity = flags.opacity;
                material.transparent = flags.transparent;
                material.depthWrite = flags.depthWrite;
            }
        });
    }

    /** Toggle mesh/edge/point visibility for `wireframe`/`points` modes. */
    private applyShadingVisibility(): void {
        if (!this.dataGroup) {
            return;
        }
        const flags = resolveViewerShadingFlags(this.shading, this.opacity);
        this.dataGroup.children.forEach((group) => {
            group.children.forEach((child) => {
                if (!(child instanceof THREE.Mesh || child instanceof THREE.Points || child instanceof THREE.LineSegments)) {
                    return;
                }
                const geometry = child.geometry as THREE.BufferGeometry;
                const role = geometry.userData?.['role'];
                const kind = geometry.userData?.['kind'] as DagmcRenderKind | undefined;
                if (child instanceof THREE.Mesh) {
                    child.visible = !flags.pointsOnly;
                } else if (role === 'mesh-points') {
                    child.visible = flags.pointsOnly;
                } else if (kind === 'edges') {
                    // Edge overlay backs only `edges` (ParaView's Surface With
                    // Edges, native-VTK parity): `shaded` faces render clean;
                    // wireframe and points modes have their own
                    // representation already.
                    child.visible = this.shading === 'edges' && !flags.pointsOnly && !flags.wireframe;
                } else {
                    child.visible = true;
                }
            });
        });
    }

    private findArrayInBlock(block: DagmcBlockModel, kind: 'point' | 'cell', name: string): NativeVtkDataArray | undefined {
        const list = kind === 'point' ? block.pointArrays : block.cellArrays;
        return list.find((array) => array.name === name);
    }

    private findArray(kind: 'point' | 'cell', name: string): NativeVtkDataArray | undefined {
        for (const block of this.blocks) {
            const array = this.findArrayInBlock(block, kind, name);
            if (array) {
                return array;
            }
        }
        return undefined;
    }

    private hasArray(colorBy: string): boolean {
        const selection = parseColorBy(colorBy);
        return (
            selection.kind === 'solid' ||
            (selection.arrayName !== null && this.findArray(selection.kind, selection.arrayName) !== undefined)
        );
    }

    private describeBlocks(): string {
        if (this.blocks.length === 0) {
            return this.isLoading ? this.statusMessage : 'No volumes loaded';
        }
        const visible = this.visibleBlocks().length;
        const groups = this.modelInfo ? `, ${Object.keys(this.modelInfo.groups).length} groups` : '';
        const hint = this.modelInfo
            ? `${visible} of ${this.blocks.length} volumes (${Object.keys(this.modelInfo.materials).length} materials${groups})`
            : `${visible} of ${this.blocks.length} volumes (no model info)`;
        return `Multiblock — ${hint}`;
    }

    // ------------------------------------------------------------------
    // Orbit navigation (three.js OrbitControls via the shared viewer-core
    // helper; gestures render on demand through `renderScene`)
    // ------------------------------------------------------------------

    /**
     * Right-click (no-drag) opens the view-action context menu. OrbitControls
     * owns right-drag pan on the same canvas, so the menu only opens when
     * the release lands within ~5px of the press.
     */
    private attachContextMenu(canvas: HTMLCanvasElement): void {
        let downX = 0;
        let downY = 0;
        let downButton = -1;
        canvas.addEventListener('pointerdown', (event) => {
            if (event.button === 2) {
                downX = event.clientX;
                downY = event.clientY;
                downButton = 2;
            }
        });
        canvas.addEventListener('pointerup', (event) => {
            if (event.button === 2 && downButton === 2) {
                downButton = -1;
                if (isViewerContextMenuClick(downX, downY, event.clientX, event.clientY)) {
                    this.openContextMenu(event.clientX, event.clientY);
                }
            }
        });
    }

    /** View-action menu: fit, screenshot, clip toggle, per-mode shading. */
    private openContextMenu(clientX: number, clientY: number): void {
        if (this.blocks.length === 0) {
            return;
        }
        this.contextMenuClose?.();
        this.contextMenuClose = openViewerContextMenu(
            { x: clientX, y: clientY },
            buildViewerContextMenuItems({ shading: this.shading, clipChecked: anyClipEnabled(this.clip) }),
            (id) => this.handleContextMenuAction(id)
        );
    }

    private handleContextMenuAction(id: string): void {
        if (id === 'fit') {
            this.fitView();
        } else if (id === 'screenshot') {
            this.saveScreenshot();
        } else if (id === 'clip') {
            this.applyProps({ clip: setAllClipEnabled(this.clip, !anyClipEnabled(this.clip)) });
        } else if (id.startsWith('shading:')) {
            const mode = id.slice('shading:'.length);
            if (isViewerShadingMode(mode)) {
                this.applyProps({ shading: mode });
            }
        }
        this.update();
    }

    /**
     * Click (not drag) raycasts block meshes and selects the volume — the
     * canvas→outline half of sync. Skipped while the measure tool is armed
     * (its own click handler owns the gesture then). OrbitControls owns drag
     * gestures on the same canvas, so a pointerup within 4px of its
     * pointerdown counts as a click (geometry-native parity).
     */
    private pickVolume(clientX: number, clientY: number): void {
        if (!this.renderer || !this.camera || !this.dataGroup || this.measure.active) {
            return;
        }
        const rect = this.renderer.domElement.getBoundingClientRect();
        const pointer = new THREE.Vector2(
            ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
            -((clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1
        );
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(pointer, this.camera);
        const hits = raycaster.intersectObjects(this.dataGroup.children, true);
        for (const hit of hits) {
            let node: THREE.Object3D | null = hit.object;
            while (node) {
                const match = /^block:(\d+)$/.exec(node.name);
                if (match) {
                    const block = this.blocks.find((entry) => entry.blockIndex === parseInt(match[1], 10));
                    const volumeId = block ? this.blockVolumeId(block) : undefined;
                    if (volumeId !== undefined) {
                        this.selectVolume(volumeId === this.selectedVolumeId ? null : volumeId);
                    }
                    return;
                }
                node = node.parent;
            }
        }
    }

    /** Click-vs-drag gate around {@link pickVolume} (same 4px rule as geometry-native). */
    private attachPickHandlers(canvas: HTMLCanvasElement): void {
        let downX = 0;
        let downY = 0;
        canvas.addEventListener('pointerdown', (event) => {
            downX = event.clientX;
            downY = event.clientY;
        });
        canvas.addEventListener('pointerup', (event) => {
            if (event.button === 0 && Math.abs(event.clientX - downX) + Math.abs(event.clientY - downY) <= 4) {
                this.pickVolume(event.clientX, event.clientY);
            }
        });
    }

    /**
     * Attach OrbitControls to the renderer canvas. The controls class loads
     * asynchronously (same dynamic import style as nuke-cad); a renderer
     * teardown before the import resolves disposes the stale handle. Once
     * attached, the visible blocks are framed through the controls.
     */
    private attachOrbitControls(): void {
        const renderer = this.renderer;
        const camera = this.camera;
        if (!renderer || !camera) {
            return;
        }
        createOrbitControls(camera, renderer.domElement, { onChange: () => this.renderScene() })
            .then((handle) => {
                if (this.renderer !== renderer) {
                    handle.dispose();
                    return;
                }
                this.orbitControls?.dispose();
                this.orbitControls = handle;
                this.fitView();
            })
            .catch((error) => {
                console.warn('[DagmcViewer] Failed to load orbit controls:', error);
            });
    }
}
