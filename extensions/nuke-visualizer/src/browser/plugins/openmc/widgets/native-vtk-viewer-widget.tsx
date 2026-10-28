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
import { codicon } from '@theia/core/lib/browser/widgets/widget';
import URI from '@theia/core/lib/common/uri';
import { CommandRegistry, MessageService } from '@theia/core/lib/common';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { Tooltip, ViewBadge, ViewerNavBar, ViewCube } from 'nuke-essentials/lib/theme/browser/components';
import type { ViewerNavAction, ViewCubeHandle } from 'nuke-essentials/lib/theme/browser/components';
import {
    ClassifiedNativeVtkArrays,
    classifyNativeVtkArrays,
    colorByValue,
    DEFAULT_COLORMAP,
    defaultNativeColorBy,
    NativeVtkDataArray,
    NativeVtkModel,
    parseColorBy,
    parseNativeVtk,
    parseNativeVtkXml,
    readVtkText,
    selectSourceColorArray,
    SOLID_COLOR,
    strideForBudget
} from './native-vtk/native-vtk-data';
import { COLORMAP_NAMES, getColormap, isColormapName, type ColormapName } from '../../../viewer-core/colormaps';
import {
    DEFAULT_BIVARIATE_OPTIONS,
    bivariateRgba,
    bivariateWeight,
    isUncertaintyChannel,
    normalizeMaxRelativeError,
    relativeError,
    type BivariateOptions
} from '../../../viewer-core/bivariate-mapping';
import { getPointSpriteTexture } from '../../../viewer-core/point-sprite';
import { buildVoxelMesh, updateVoxelInstances, voxelInstanceLayout } from '../../../viewer-core/voxel-blocks';
import type { VoxelInstanceLayout } from '../../../viewer-core/voxel-blocks';
import {
    componentOptions,
    formatRangeValue,
    logScaleAvailable,
    MAGNITUDE_COMPONENT,
    mapScalar,
    mappingToCssGradient,
    resolveEffectiveRange,
    tupleScalar,
    type ColorRangeMode,
    type ScalarMapping
} from '../../../viewer-core/scalar-mapping';
import { LINE_WIDTH_SPEC, OPACITY_SPEC, POINT_SIZE_SPEC } from '../../../viewer-core/viewer-toolbar-model';
import {
    createOrbitControls,
    standardViewDirection,
    type BoundsCorner,
    type OrbitControlsHandle
} from '../../../viewer-core/orbit-controls';
import {
    addMeasurePoint,
    cancelMeasureStep,
    formatMeasureDistance,
    projectMeasurePoint,
    resetMeasureState,
    setMeasureActive,
    type MeasurePoint3D,
    type MeasureState
} from '../../../viewer-core/measure-model';
import {
    ViewerContextMenuItem,
    buildViewerContextMenuItems,
    isViewerContextMenuClick,
    openViewerContextMenu
} from '../../../viewer-core/viewer-context-menu';
import {
    TallyVolumeMode,
    VOLUME_LUT_SIZE,
    VolumeGrid,
    VolumeRaycastHandle,
    clipVolumeBox,
    createVolumeRaycastMesh,
    packVolumeScalars
} from '../../../viewer-core/volume-raycast';
import { extractGridSlice, sliceToRgba, type GridSliceSource, type SliceAxis } from '../../../viewer-core/slice-view';
import { buildClipCap } from '../../../viewer-core/capped-clip';
import { buildAxesGrid, projectAxisLabels, type AxisGridModel, type ProjectedAxisLabel } from '../../../viewer-core/axes-grid';
import { AxesGridOverlay } from '../../../viewer-settings/axes-grid-overlay';
import {
    buildScreenshotFilename,
    captureRendererScreenshot,
    copyScreenshotDataUrl,
    downloadScreenshotDataUrl,
    type ScreenshotOptions
} from '../../../viewer-core/canvas-screenshot';
import { ViewerExportMenu } from './viewer-export-menu';
import { FindDataDialog, type FindDataAssociation } from './find-data-dialog';
import { ProbeDialog } from './probe-dialog';
import {
    PROBE_SAMPLE_ROW_CAP,
    probeLineToCsv,
    probeMarkerRadius,
    probeSamplesToCsv,
    resolveProbeTuple,
    sampleProbeValue,
    type ProbeArray,
    type ProbeAssociation,
    type ProbeHit,
    type ProbeLinePoint,
    type ProbeLineResult,
    type ProbeSample,
    type ProbeTopology
} from '../../../viewer-core/probe-model';
import { buildSelectionOverlay } from '../../../viewer-core/selection-overlay';
import { selectionToCsv } from '../../../viewer-core/selection-query';
import { viewerStateFromSnapshot, viewerStateToPatch, type ViewerState } from '../../../viewer-core/viewer-state';
import {
    statsForArray,
    summarizeNativeModel,
    tableForArray,
    type DatasetAssociation,
    type DatasetStats,
    type DatasetSummary,
    type DatasetTable
} from '../../../viewer-core/dataset-inspector';
import type { ViewerDatasetHost } from '../../../dataset-inspector/dataset-inspector-model';
import {
    DEFAULT_VOLUME_TRANSFER,
    buildVolumeTransferLut,
    normalizeOpacityStops,
    type VolumeTransferOptions
} from '../../../viewer-core/volume-transfer';
import {
    anyClipEnabled,
    boundingBoxFromPositions,
    ClipAxis,
    ClipPlanesState,
    createClipPlanesState,
    setAllClipEnabled,
    toThreePlaneParamsArray,
    updateAxisClip,
    type AxisClipState
} from '../../../viewer-core/clip-plane';
import {
    DEFAULT_VIEWER_SHADING_MODE,
    FEATURE_EDGE_ANGLE_DEGREES,
    ViewerShadingMode,
    isViewerShadingMode,
    resolveViewerShadingFlags
} from '../../../viewer-core/shading-mode';
import {
    DEFAULT_WARP_SCALE_MODE,
    WARP_EXAGGERATION_SPEC,
    applyWarp,
    autoWarpScale,
    isWarpScaleMode,
    resolveWarpScale,
    type WarpScaleMode
} from '../../../viewer-core/warp-vectors';
import {
    collapsePointSoup,
    collapseSegmentSoup,
    collapseTriangleSoup,
    countThresholdVisible,
    hiddenPoints,
    hiddenSegments,
    hiddenTriangles,
    normalizeThresholdRange,
    thresholdTupleVisible
} from '../../../viewer-core/threshold-filter';
import {
    autoGlyphSize,
    clampGlyphDensity,
    clampGlyphScale,
    DEFAULT_GLYPH_DENSITY,
    DEFAULT_GLYPH_SCALE,
    planGlyphs
} from '../../../viewer-core/glyph-layout';
import { nextNavPopover, type ViewerNavPopoverKind } from '../../../viewer-core/viewer-nav-popover';
import { cameraLinkBus, cameraPoseDirection, type CameraLinkEndpoint, type CameraLinkPose } from '../../../viewer-core/camera-link-bus';
import {
    comparisonCameraKey,
    comparisonRangeBus,
    type ComparisonRange,
    type ComparisonRangeEndpoint,
    type ComparisonViewOptions
} from '../../../viewer-core/comparison-session';
import { OpenMCVtkArrayInfo } from '../../../../common/openmc-protocol';
import { VisualizerBackendService } from '../../../../common/base-visualizer-protocol';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { ViewerQualityMenu, type MeshQualityMetric } from './viewer-quality-menu';
import { DATASET_INSPECTOR_COMMAND_ID, VIEWER_SETTINGS_COMMAND_ID } from '../../../commands/panel-commands';
import {
    ViewerSettingsHost,
    ViewerSettingsPatch,
    ViewerSettingsSnapshot,
    ViewerGlyphSettings,
    ViewerSlicePreview,
    ViewerSliceSettings,
    ViewerThresholdSettings,
    viewerSnapDirection
} from '../../../viewer-settings/viewer-settings-model';
import { ViewerMeasureLabel, type ViewerMeasureHandle } from './viewer-measure';
import {
    ViewerClipPopover,
    ViewerClipTrigger,
    ViewerFileActions,
    FindDataTrigger,
    LinkCamerasTrigger,
    ProbeTrigger,
    ViewerNavPopoverShell,
    ViewerPanelActions,
    ViewerShadingPopover,
    ViewerShadingTrigger
} from './viewer-nav-extras';
import './output-viewer.css';

/** Scratch view-projection matrix for the measure-label projection (module scope so the camera loop never allocates). */
const scratchViewProjection = new THREE.Matrix4();

interface AxesGridOverlayHandle {
    set(labels: readonly ProjectedAxisLabel[], width: number, height: number): void;
}

/**
 * Isolated overlay host: the native viewer updates labels through a ref on
 * every camera frame, so only this small subtree re-renders instead of the
 * whole widget.
 */
const AxesGridOverlayHost = React.forwardRef<AxesGridOverlayHandle, { visible: boolean }>(({ visible }, ref) => {
    const [payload, setPayload] = React.useState<{ labels: readonly ProjectedAxisLabel[]; width: number; height: number }>({
        labels: [],
        width: 0,
        height: 0
    });
    React.useImperativeHandle(
        ref,
        () => ({
            set: (labels, width, height) => setPayload({ labels, width, height })
        }),
        []
    );
    return <AxesGridOverlay labels={payload.labels} width={payload.width} height={payload.height} visible={visible} />;
});

/** Data-group child name of the scene underlay holder (subclass ghost content lives one level down). */
const UNDERLAY_GROUP_NAME = 'underlay';

/**
 * Probe-history marker styling: the newest sample is accented cyan, older
 * samples stay subdued. Geometry uses 12x8 spheres (up to 100 samples live
 * at once), and the history base radius is a fraction of the measure marker.
 */
const PROBE_MARKER_NEWEST_COLOR = 0x3fc6ff;
const PROBE_MARKER_HISTORY_COLOR = 0x8aa0ad;
const PROBE_MARKER_HISTORY_OPACITY = 0.55;
const PROBE_MARKER_HISTORY_SCALE = 0.6;

/** Dialog payload for one line-profile run: array, two endpoints, sample count. */
interface ProbeProfileRequest {
    readonly association: ProbeAssociation;
    readonly name: string;
    readonly start: string;
    readonly end: string;
    readonly samples: number;
}

/** Geometry role recorded by the scene builders (`mesh`, `mesh-points`, `edges`, `feature-edges`, overlays). */
function probeObjectRole(object: THREE.Mesh | THREE.Points | THREE.Line): string | undefined {
    return object.geometry?.userData?.['role'] as string | undefined;
}

/** Surface edge overlay roles: every triangle edge vs. the thresholded feature boundary. */
type ShadingEdgeRole = 'edges' | 'feature-edges';

/** True for both surface edge overlay roles (visibility, rebuild, probe exclusion). */
function isShadingEdgeRole(role: unknown): role is ShadingEdgeRole {
    return role === 'edges' || role === 'feature-edges';
}

/**
 * Props driving the native VTK viewer. Every field applies instantly to the
 * already-loaded dataset — changing color-by or the colormap never restarts
 * anything (there is no server to restart; this is the native replacement for
 * the trame `--color-by` restart hack in `OpenMCOutputViewerWidget`).
 */
export interface NativeVtkViewerProps {
    /** `'Solid Color'`, `'Point: <name>'`, or `'Cell: <name>'` (base.serve format). */
    colorBy?: string;
    /** One of the ParaView-style colormaps in `COLORMAP_NAMES`. */
    colormap?: ColormapName;
    /** CSS color used in Solid Color mode. */
    solidColor?: string;
    /** Point sprite size in pixels. */
    pointSize?: number;
    /** Material opacity in [0, 1]. */
    opacity?: number;
    /** Line width in pixels (line and edge datasets). */
    lineWidth?: number;
    /** Canvas background CSS color; undefined follows the theme editor background. */
    background?: string;
    /** Scalar-bar (color legend) visibility. */
    scalarBarVisible?: boolean;
    /** Sample the colormap in reverse. */
    invert?: boolean;
    /** Log-scaled scalar mapping (applies only when the effective range is positive). */
    logScale?: boolean;
    /** Vector component to color by ({@link MAGNITUDE_COMPONENT} = L2 norm). */
    component?: number;
    /** Color-range mode: the data range or a custom user range. */
    rangeMode?: ColorRangeMode;
    /** Custom color range (used in `custom` mode). */
    customRange?: readonly [number, number];
    /** Shading mode (`shaded` | `edges` | `feature-edges` | `wireframe` | `points` | `xray`). */
    shading?: ViewerShadingMode;
    /** Per-axis clip state; each enabled axis plane applies (box-section view). */
    clip?: ClipPlanesState;
    /** Warp-by-vector switch (FEM magnified deformation along a 3-component point array). */
    warpEnabled?: boolean;
    /** Warp vector array (`Point: <name>` with three components). */
    warpArray?: string;
    /** Warp scale mode (`true` | `auto` | `capped`). */
    warpScaleMode?: WarpScaleMode;
    /** User warp exaggeration (live in `capped` mode, capped at the slider maximum). */
    warpScale?: number;
    /** Threshold switch (hide cells whose active-array value falls outside the window). */
    thresholdEnabled?: boolean;
    /** Custom threshold window; `'data'` clears it back to the active array's data range. */
    thresholdRange?: 'data' | readonly [number, number];
    /** Direction-glyph switch (decimated cones along per-point vectors; no vectors, no glyphs). */
    glyphEnabled?: boolean;
    /** Fraction of candidate points carrying a cone (slider range). */
    glyphDensity?: number;
    /** Cone size multiplier over the auto height (slider range). */
    glyphScale?: number;
}

/**
 * Native VTK viewer widget: renders tracks `.vtp` polylines,
 * collision `.vtp` point clouds, weight-windows `.vtr` rectilinear grids, and
 * voxel `.vti` image grids directly in the IDE with three.js — no trame
 * server, no reverse proxy, no iframe. VTK bytes are read through Theia's
 * `FileService` (works for workspace files and backend-converted temp files
 * alike), parsed client-side by `native-vtk-data.ts`, and colored per-vertex
 * from the selected array, so color-by/colormap switches only rewrite a color
 * buffer. Axis-aligned grids render as instanced voxel blocks (uniformly
 * thinned past the voxel budget) with a cell-center point cloud kept for
 * `points` shading mode; curvilinear grids stay point clouds.
 *
 * This widget is intentionally NOT wired into any contribution yet: the
 * this viewer replaces the `output-viewer-widget.tsx` subclasses'
 * convert→serve→iframe lifecycle with convert→FileService→native rendering.
 */
@injectable()
export class NativeVtkViewerWidget extends ReactWidget implements ViewerSettingsHost, ViewerDatasetHost {
    static readonly ID: string = 'native-vtk-viewer-widget';
    static readonly LABEL: string = 'Native VTK Viewer';

    @inject(FileService)
    protected readonly fileService!: FileService;

    @inject(VisualizerBackendService)
    protected readonly visualizerBackend!: VisualizerBackendService;

    @inject(WorkspaceService)
    protected readonly workspaceService!: WorkspaceService;

    @inject(MessageService)
    protected readonly messageService!: MessageService;

    @inject(CommandRegistry)
    protected readonly commands!: CommandRegistry;

    protected fileUri: URI | undefined;
    protected model: NativeVtkModel | undefined;
    protected classified: ClassifiedNativeVtkArrays | undefined;
    /** Flat grid cells behind the rendered voxel instances (recolor mapping). */
    protected voxelLayout: VoxelInstanceLayout | undefined;
    protected colorBy: string = SOLID_COLOR;
    protected colormap: ColormapName = DEFAULT_COLORMAP;
    protected solidColor = '#d4d4d4';
    protected pointSize = 3;
    protected opacity = 1;
    protected lineWidth = 1;
    /** Canvas backdrop; undefined follows the theme editor background (the pre-scene.background look). */
    protected background: string | undefined;
    protected scalarBarVisible = true;
    /** Legend title override; undefined uses the active array name. */
    protected scalarBarTitle: string | undefined;
    protected scalarBarVertical = false;
    /** Bivariate (mean + relative error) master switch (Viewer Settings Uncertainty section). */
    protected bivariateEnabled = false;
    /** Bivariate channel/threshold/mask options; only used when a mean companion pair exists. */
    protected bivariateOptions: BivariateOptions = DEFAULT_BIVARIATE_OPTIONS;
    protected invert = false;
    protected logScale = false;
    protected component = MAGNITUDE_COMPONENT;
    protected rangeMode: ColorRangeMode = 'auto';
    protected customRange: [number, number] | undefined;
    protected shading: ViewerShadingMode = DEFAULT_VIEWER_SHADING_MODE;
    protected clip: ClipPlanesState = createClipPlanesState();
    /** Active X/Y/Z tab of the header clip control (per-axis settings persist). */
    protected clipTab: ClipAxis = 'X';
    /** Warp-by-vector switch (Viewer Settings row; needs a 3-component point array). */
    protected warpEnabled = false;
    /** Warp vector array value (`Point: <name>`); defaults to the first vector array on load. */
    protected warpArray = '';
    /** Warp scale mode (`true` displacement, `auto` 10%-of-size, `capped` user exaggeration). */
    protected warpScaleMode: WarpScaleMode = DEFAULT_WARP_SCALE_MODE;
    /** User warp exaggeration (slider value; live in `capped` mode). */
    protected warpScale = 1;
    /** Threshold switch (Viewer Settings row beside Range; hides cells outside the window). */
    protected thresholdEnabled = false;
    /** Custom threshold window (undefined follows the active array's data range, hiding nothing). */
    protected thresholdCustom: [number, number] | undefined;
    /** Direction-glyph switch (Viewer Settings Glyphs row; needs per-point vectors from the subclass hook). */
    protected glyphEnabled = false;
    /** Fraction of candidate points carrying a cone (Viewer Settings density slider). */
    protected glyphDensity = DEFAULT_GLYPH_DENSITY;
    /** Cone size multiplier over the auto height (Viewer Settings scale slider). */
    protected glyphScale = DEFAULT_GLYPH_SCALE;
    /** Live cone instances (owned here; disposed with the data group on rebuild). */
    private glyphMesh: THREE.InstancedMesh | undefined;
    /** Point-to-cell map for glyph threshold/color lookups on cell arrays (rebuilt per model + array). */
    private glyphCellCache: { model: NativeVtkModel; array: NativeVtkDataArray; map: Int32Array } | undefined;
    /**
     * Open bottom-bar popover (single slot, CAD `openPopover` parity — never
     * both cards). The widget owns the slot; every card control routes onto
     * the existing setters, so the sidebar stays authoritative.
     */
    protected openNavPopover: ViewerNavPopoverKind | undefined;
    /**
     * Opt-in camera link (nav-bar `Link cameras` toggle, per-widget state,
     * default off): when on, the orbit `change` hook publishes
     * `{position, target}` on the same-file bus and linked poses from other
     * views of the same file apply through the orbit handle. Camera-only
     * sync — warp, threshold, glyphs, color-by, clip, and shading stay
     * per-widget and are never published or applied.
     */
    protected cameraLinked = false;
    /**
     * Explicit link-identity override (tabs that load converted text instead
     * of a file, e.g. tally mesh/contour siblings, key by their source file
     * through this once their owner passes it down).
     */
    protected cameraLinkSource: string | undefined;
    private cameraLinkEndpoint: CameraLinkEndpoint | undefined;
    private cameraLinkSubscribedKey: string | undefined;
    /** True while a linked pose applies (the resulting orbit change must not rebroadcast — echo suppression). */
    private applyingLinkedPose = false;
    /** Mirrored orbit target for link publishes (fit keeps it exact; a local pan re-anchors on the next fit). */
    private linkTarget: [number, number, number] | undefined;
    /**
     * Active comparison-workspace state; undefined outside a
     * comparison. Comparison camera links apply direction only and the range
     * bus shares a union of the panes' active-array data ranges.
     */
    protected comparisonView: ComparisonViewOptions | undefined;
    /** Camera-link identity captured on join (restored when the comparison is left). */
    private comparisonRestoreLinkSource: string | undefined;
    /** Camera-link toggle captured on join. */
    private comparisonRestoreLinked = false;
    /** Color-range mode captured on join. */
    private comparisonRestoreRangeMode: ColorRangeMode = 'auto';
    /** Custom color range captured on join. */
    private comparisonRestoreCustomRange: [number, number] | undefined;
    /** Live comparison-range endpoint (dropped on detach/dispose — no leaked bus listeners). */
    private comparisonRangeEndpoint: ComparisonRangeEndpoint | undefined;
    /** Last union observed on the comparison bus (snapshot readout + shared-range cache). */
    private comparisonUnion: ComparisonRange | undefined;
    /** Bar + card elements behind the outside-click dismissal (trigger clicks are inside the bar). */
    protected navBarElement: HTMLDivElement | null = null;
    protected navPopoverElement: HTMLDivElement | null = null;
    protected isLoading = false;
    protected error: string | undefined;
    protected statusMessage = '';
    protected note = '';
    private loadToken = 0;

    private host: HTMLElement | undefined;
    private renderer: THREE.WebGLRenderer | undefined;
    private scene: THREE.Scene | undefined;
    private camera: THREE.PerspectiveCamera | undefined;
    private dataGroup: THREE.Group | undefined;
    /** Closed-cut cap meshes (rebuilt from the active clip state). */
    private clipCaps = true;
    private clipCapGroup: THREE.Group | undefined;
    private clipCapKey: string | undefined;
    /** Find Data dialog + transient query selection (viewport state, never document state). */
    private findDataOpen = false;
    private findDataSelection: { association: FindDataAssociation; name: string; indices: Uint32Array } | undefined;
    private findDataGroup: THREE.Group | undefined;
    /**
     * Generic probe viewport state: the floating dialog, canvas point
     * picking, the newest-first sample history, and the file-backed line
     * profile. Never document state — a dataset rebuild resets all of it.
     * (`probeDialogOpen`/`probeProfileToken` avoid the tally-native viewer's
     * pre-existing `probeOpen`/`probeToken` line-probe fields.)
     */
    private probeDialogOpen = false;
    private probePicking = false;
    private probeSamples: ProbeSample[] = [];
    /** World-anchored probe markers, kept outside the data group like the measure overlay. */
    private probeMarkerGroup: THREE.Group | undefined;
    private probeProfileRunning = false;
    private probeProfileError: string | undefined;
    private probeProfileResult: ProbeLineResult | undefined;
    /** Async guard for profile runs (bumped on rebuild and every new run). */
    private probeProfileToken = 0;
    /** Bounding-box axes grid + projected labels. */
    private axesGridVisible = false;
    private axesGridModel: AxisGridModel | undefined;
    private axesGridLines: THREE.LineSegments | undefined;
    private axesGridOverlayRef: AxesGridOverlayHandle | null = null;
    private orbitControls: OrbitControlsHandle | undefined;
    private resizeObserver: ResizeObserver | undefined;
    private contextMenuClose: (() => void) | undefined;
    private gizmo: ViewCubeHandle | null = null;
    /** Viewport-only distance-measure session (never document state; cleared on rebuild). */
    private measure: MeasureState = { active: false, pending: undefined, segment: undefined };
    private measureGroup: THREE.Group | undefined;
    private measureLabel: ViewerMeasureHandle | null = null;
    /** World-size endpoint marker radius, derived from the dataset bounds at build time. */
    private measureMarkerSize = 0.01;
    private measureKeysAttached = false;
    /** Smooth-raycast representation of the volume grid (Viewer Settings smooth toggle); boxes stay the default. */
    private volumeMode: TallyVolumeMode = 'boxes';
    /** Master visibility for the volume (boxes, smooth mesh, and grid points). */
    private volumeVisible = true;
    /** Editable color/opacity transfer function, blend mode, and gradient shading. */
    private volumeTransfer: VolumeTransferOptions = {
        opacityStops: DEFAULT_VOLUME_TRANSFER.opacityStops,
        blendMode: DEFAULT_VOLUME_TRANSFER.blendMode,
        shade: DEFAULT_VOLUME_TRANSFER.shade
    };
    /** Orthoslice preview state (Viewer Settings Slice section). */
    private orthoSliceAxis: SliceAxis = 'Z';
    private orthoSliceFraction = 0.5;
    private orthoSliceSmooth = false;
    /** Live smooth raycast handle (owned here; textures release on dispose). */
    private volumeSmooth: VolumeRaycastHandle | undefined;
    /** Packed-texture identity (array + mapping + range): repack only on change. */
    private volumePackedKey: string | undefined;
    /** Data range behind the packed texture (lookup refresh without re-upload). */
    private volumePackedRange: [number, number] | undefined;
    /** Layered source-bank point cloud ("+ Source" flow); independent color mapping from the dataset. */
    private tallySourcePoints: THREE.Points | undefined;
    /** Per-particle source values (energy, weight fallback) in point order. */
    private tallySourceValues: Float64Array | undefined;
    /** Data range behind the source colors (own domain, not the tally color-by range). */
    private tallySourceRange: [number, number] | undefined;

    @postConstruct()
    protected init(): void {
        this.id = NativeVtkViewerWidget.ID;
        this.title.label = NativeVtkViewerWidget.LABEL;
        this.title.iconClass = codicon('layers');
        this.title.closable = true;
        this.node.tabIndex = 0;
    }

    /**
     * Take DOM focus on activation (statepoint-viewer parity): the shell's
     * `activeWidget`/`currentWidget` only update on real focus events, and
     * the Viewer Settings binding keys off them — without this,
     * programmatic activation (auto-open on file open) never binds it.
     */
    protected onActivateRequest(msg: Message): void {
        super.onActivateRequest(msg);
        this.node.focus();
    }

    // ------------------------------------------------------------------
    // Public props API (instant, no restart)
    // ------------------------------------------------------------------

    getProps(): NativeVtkViewerProps {
        return {
            colorBy: this.colorBy,
            colormap: this.colormap,
            solidColor: this.solidColor,
            pointSize: this.pointSize,
            opacity: this.opacity,
            lineWidth: this.lineWidth,
            background: this.background,
            scalarBarVisible: this.scalarBarVisible,
            invert: this.invert,
            logScale: this.logScale,
            component: this.component,
            rangeMode: this.rangeMode,
            customRange: this.customRange ? [this.customRange[0], this.customRange[1]] : undefined,
            shading: this.shading,
            clip: {
                X: { ...this.clip.X },
                Y: { ...this.clip.Y },
                Z: { ...this.clip.Z }
            },
            warpEnabled: this.warpEnabled,
            warpArray: this.warpArray,
            warpScaleMode: this.warpScaleMode,
            warpScale: this.warpScale,
            thresholdEnabled: this.thresholdEnabled,
            thresholdRange: this.thresholdCustom ? [this.thresholdCustom[0], this.thresholdCustom[1]] : 'data',
            glyphEnabled: this.glyphEnabled,
            glyphDensity: this.glyphDensity,
            glyphScale: this.glyphScale
        };
    }

    /** Apply viewer props; color-by/mapping/display fields take effect immediately. */
    applyProps(props: NativeVtkViewerProps): void {
        let colorsChanged = false;
        let displayChanged = false;
        let clipChanged = false;
        let chromeChanged = false;
        if (props.colorBy !== undefined && props.colorBy !== this.colorBy) {
            this.setColorBy(props.colorBy);
            colorsChanged = true;
        }
        if (props.colormap !== undefined && isColormapName(props.colormap) && props.colormap !== this.colormap) {
            this.colormap = props.colormap;
            colorsChanged = true;
        }
        if (props.component !== undefined && props.component !== this.component) {
            this.component = props.component;
            colorsChanged = true;
        }
        if (props.rangeMode !== undefined && props.rangeMode !== this.rangeMode) {
            this.rangeMode = props.rangeMode;
            colorsChanged = true;
        }
        if (
            props.customRange !== undefined &&
            (this.customRange === undefined || this.customRange[0] !== props.customRange[0] || this.customRange[1] !== props.customRange[1])
        ) {
            this.customRange = [props.customRange[0], props.customRange[1]];
            colorsChanged = true;
        }
        if (props.invert !== undefined && props.invert !== this.invert) {
            this.invert = props.invert;
            colorsChanged = true;
        }
        if (props.logScale !== undefined && props.logScale !== this.logScale) {
            this.logScale = props.logScale;
            colorsChanged = true;
        }
        if (props.solidColor !== undefined && props.solidColor !== this.solidColor) {
            this.solidColor = props.solidColor;
            colorsChanged = true;
        }
        if (props.opacity !== undefined && props.opacity !== this.opacity) {
            this.opacity = Math.min(1, Math.max(0, props.opacity));
            displayChanged = true;
        }
        if (props.pointSize !== undefined && props.pointSize > 0 && props.pointSize !== this.pointSize) {
            this.pointSize = props.pointSize;
            displayChanged = true;
        }
        if (props.lineWidth !== undefined && props.lineWidth > 0 && props.lineWidth !== this.lineWidth) {
            this.lineWidth = props.lineWidth;
            displayChanged = true;
        }
        if (props.background !== undefined && props.background !== this.background) {
            this.background = props.background;
            displayChanged = true;
        }
        if (props.scalarBarVisible !== undefined && props.scalarBarVisible !== this.scalarBarVisible) {
            this.scalarBarVisible = props.scalarBarVisible;
            chromeChanged = true;
        }
        if (props.shading !== undefined && isViewerShadingMode(props.shading) && props.shading !== this.shading) {
            this.shading = props.shading;
            displayChanged = true;
        }
        if (props.clip !== undefined) {
            this.clip = props.clip;
            clipChanged = true;
        }
        let warpChanged = false;
        if (props.warpEnabled !== undefined && props.warpEnabled !== this.warpEnabled) {
            this.warpEnabled = props.warpEnabled;
            warpChanged = true;
        }
        if (props.warpArray !== undefined && props.warpArray !== this.warpArray) {
            this.warpArray = props.warpArray;
            warpChanged = true;
        }
        if (props.warpScaleMode !== undefined && isWarpScaleMode(props.warpScaleMode) && props.warpScaleMode !== this.warpScaleMode) {
            this.warpScaleMode = props.warpScaleMode;
            warpChanged = true;
        }
        if (
            props.warpScale !== undefined &&
            Number.isFinite(props.warpScale) &&
            props.warpScale >= 0 &&
            props.warpScale !== this.warpScale
        ) {
            this.warpScale = props.warpScale;
            warpChanged = true;
        }
        if (warpChanged) {
            // Enabling warp with nothing valid selected falls back to the
            // first vector array (same default the loader applies), so the
            // switch takes effect immediately instead of idling on no array.
            if (this.warpEnabled && !this.warpOptions().some((option) => option.value === this.warpArray)) {
                const first = this.warpOptions()[0];
                if (first) {
                    this.warpArray = first.value;
                }
            }
            this.applyWarp();
        }
        let thresholdChanged = false;
        if (props.thresholdEnabled !== undefined && props.thresholdEnabled !== this.thresholdEnabled) {
            this.thresholdEnabled = props.thresholdEnabled;
            thresholdChanged = true;
        }
        if (props.thresholdRange !== undefined) {
            if (props.thresholdRange === 'data') {
                if (this.thresholdCustom !== undefined) {
                    this.thresholdCustom = undefined;
                    thresholdChanged = true;
                }
            } else if (
                Number.isFinite(props.thresholdRange[0]) &&
                Number.isFinite(props.thresholdRange[1]) &&
                (this.thresholdCustom === undefined ||
                    this.thresholdCustom[0] !== props.thresholdRange[0] ||
                    this.thresholdCustom[1] !== props.thresholdRange[1])
            ) {
                // Inverted inputs normalize on read (Range-slider parity);
                // non-finite inputs never commit.
                this.thresholdCustom = [props.thresholdRange[0], props.thresholdRange[1]];
                thresholdChanged = true;
            }
        }
        if (thresholdChanged) {
            // Same funnels warp uses (positions) plus the recolor pass
            // (voxel instances): warp positions first, then hide cells.
            this.rewriteWarpPositions();
            this.recolor();
            // Glyphs sit after the warp rewrite (warped positions) and skip
            // threshold-hidden tuples, so they refresh on the same funnel.
            this.refreshGlyphs();
        }
        let glyphChanged = false;
        if (props.glyphEnabled !== undefined && props.glyphEnabled !== this.glyphEnabled) {
            this.glyphEnabled = props.glyphEnabled;
            glyphChanged = true;
        }
        if (props.glyphDensity !== undefined && Number.isFinite(props.glyphDensity)) {
            const next = clampGlyphDensity(props.glyphDensity);
            if (next !== this.glyphDensity) {
                this.glyphDensity = next;
                glyphChanged = true;
            }
        }
        if (props.glyphScale !== undefined && Number.isFinite(props.glyphScale)) {
            const next = clampGlyphScale(props.glyphScale);
            if (next !== this.glyphScale) {
                this.glyphScale = next;
                glyphChanged = true;
            }
        }
        if (glyphChanged) {
            this.refreshGlyphs();
        }
        if (colorsChanged) {
            this.recolor();
            // Glyph instance colors follow the active mapping (same funnel
            // as the dataset repaint).
            this.refreshGlyphs();
        } else if (displayChanged) {
            this.applyDisplayProps();
        } else if (clipChanged && !warpChanged) {
            this.applyClip();
            this.renderScene();
        }
        if (colorsChanged || displayChanged || clipChanged || chromeChanged || warpChanged || thresholdChanged || glyphChanged) {
            this.update();
        }
        if (colorsChanged) {
            // Comparison shared-range input: the active array's data range,
            // never the custom window, so applying the union cannot feed back
            // into the bus.
            this.publishComparisonRange();
            // A color-by switch resets the range to auto; keep the shared
            // union authoritative while this pane opts in.
            this.enforceComparisonSharedRange();
        }
    }

    /**
     * Switch the color-by array: a new array brings a new value domain, so the
     * mapping state resets (component, range, log scale). Invert is a
     * per-user preference and survives the switch.
     */
    private setColorBy(value: string): void {
        this.colorBy = value;
        this.component = MAGNITUDE_COMPONENT;
        this.rangeMode = 'auto';
        this.logScale = false;
        // A new array brings a new value domain, so a stale custom window
        // could blank the scene — it clears (Range-reset parity) while the
        // enable switch persists.
        this.thresholdCustom = undefined;
    }

    // ------------------------------------------------------------------
    // Viewer Settings sidebar API (single-direction sync: the panel reads
    // the snapshot and applies edits through these setters — the same calls
    // the header used to make, never duplicated state)
    // ------------------------------------------------------------------

    /** Color-by entries for the sidebar select (same options the header offered). */
    colorByOptions(): { value: string; label: string }[] {
        if (!this.model || !this.classified) {
            return [{ value: SOLID_COLOR, label: SOLID_COLOR }];
        }
        const options: { value: string; label: string }[] = [{ value: SOLID_COLOR, label: SOLID_COLOR }];
        const push = (arrays: OpenMCVtkArrayInfo[]): void => {
            for (const array of arrays) {
                const value = colorByValue(array);
                options.push({ value, label: `${array.association === 'point' ? 'Point' : 'Cell'}: ${array.name}` });
            }
        };
        push(this.classified.energies);
        push(this.classified.fluxGroups);
        for (const group of this.classified.windowGroups) {
            if (group.lower) {
                options.push({ value: colorByValue(group.lower), label: `Cell: ${group.lower.name}` });
            }
            if (group.upper) {
                options.push({ value: colorByValue(group.upper), label: `Cell: ${group.upper.name}` });
            }
        }
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

    /** Arm or disarm the distance-measure tool (sidebar toggle); arming disarms probe picking. */
    setMeasureActive(active: boolean): void {
        const disarmProbe = active && this.probePicking;
        if (disarmProbe) {
            this.probePicking = false;
        }
        const next = setMeasureActive(this.measure, active);
        if (next !== this.measure) {
            this.measure = next;
            this.update();
        } else if (disarmProbe) {
            this.update();
        }
    }

    /** Snap the camera to an orbit-handle direction (sidebar snap group). */
    snapViewerTo(direction: BoundsCorner): void {
        this.orbitControls?.setViewDirection(direction);
    }

    /**
     * Link identity: the viewed file path, so views of different files never
     * link. Tabs without a file (converted tally text loads) stay unlinked
     * until their source key arrives through {@link setCameraLinkKey}.
     */
    protected cameraLinkKey(): string | undefined {
        return this.cameraLinkSource ?? this.fileUri?.path.toString();
    }

    /** Override the link identity (source-file keying for file-less tabs); re-subscribes when it changes. */
    setCameraLinkKey(key: string | undefined): void {
        // A comparison session owns the identity while joined: late tally-tab
        // source keys must not silently drop the pane out of the shared camera.
        const next = this.comparisonView ? comparisonCameraKey(this.comparisonView.sessionId) : key;
        if (next === this.cameraLinkSource) {
            return;
        }
        this.cameraLinkSource = next;
        this.ensureCameraLinkSubscription();
        this.update();
    }

    /** Flip the nav-bar `Link cameras` toggle (per-widget state, default off). */
    setCameraLinked(linked: boolean): void {
        if (linked === this.cameraLinked) {
            return;
        }
        this.cameraLinked = linked;
        this.update();
    }

    /** Nav-bar toggle: comparison panes keep the stored comparison option in sync. */
    private toggleCameraLink(): void {
        if (this.comparisonView) {
            this.setComparisonLinkCameras(!this.cameraLinked);
        } else {
            this.setCameraLinked(!this.cameraLinked);
        }
    }

    // ------------------------------------------------------------------
    // Comparison workspace: 2–4 panes share camera orientation
    // and a union color range. Additive and opt-in — outside a comparison
    // every method below is a safe no-op.
    // ------------------------------------------------------------------

    /**
     * Join a comparison session. Captures the pre-comparison camera-link
     * identity/toggle and range window so {@link leaveComparison} restores
     * them exactly; re-joining leaves the previous session first.
     */
    joinComparison(options: ComparisonViewOptions): void {
        if (this.comparisonView) {
            this.leaveComparison();
        }
        this.comparisonRestoreLinkSource = this.cameraLinkSource;
        this.comparisonRestoreLinked = this.cameraLinked;
        this.comparisonRestoreRangeMode = this.rangeMode;
        this.comparisonRestoreCustomRange = this.customRange ? [this.customRange[0], this.customRange[1]] : undefined;
        this.comparisonView = { ...options };
        this.comparisonUnion = undefined;
        this.setCameraLinkKey(comparisonCameraKey(options.sessionId));
        this.setCameraLinked(options.linkCameras);
        this.ensureComparisonRangeSubscription();
        this.publishComparisonRange();
        // Seed from the bus: covers a union that predates this subscription,
        // and hands the shared window to a pane that joined later.
        this.comparisonUnion = comparisonRangeBus.union(options.sessionId);
        if (options.sharedRange) {
            this.applyComparisonUnion(this.comparisonUnion);
        }
        this.update();
    }

    /** Leave the comparison session: restore the captured link/range state. */
    leaveComparison(): void {
        const view = this.comparisonView;
        if (!view) {
            return;
        }
        this.dropComparisonRangeSubscription();
        const linkSource = this.comparisonRestoreLinkSource;
        const linked = this.comparisonRestoreLinked;
        const rangeMode = this.comparisonRestoreRangeMode;
        const customRange = this.comparisonRestoreCustomRange;
        this.comparisonView = undefined;
        this.comparisonUnion = undefined;
        this.comparisonRestoreLinkSource = undefined;
        this.comparisonRestoreLinked = false;
        this.comparisonRestoreRangeMode = 'auto';
        this.comparisonRestoreCustomRange = undefined;
        this.setCameraLinkKey(linkSource);
        this.setCameraLinked(linked);
        if (view.sharedRange) {
            // Shared range replaced the captured window; restore it through
            // the same prop funnel the sidebar uses.
            this.applyProps({ rangeMode, customRange });
        }
        this.update();
    }

    /** Current comparison participation (undefined outside a comparison). */
    getComparisonView(): ComparisonViewOptions | undefined {
        return this.comparisonView;
    }

    /** Per-pane `Link cameras` toggle (comparison section of Viewer Settings). */
    setComparisonLinkCameras(linked: boolean): void {
        const view = this.comparisonView;
        if (!view || view.linkCameras === linked) {
            return;
        }
        this.comparisonView = { ...view, linkCameras: linked };
        this.setCameraLinked(linked);
        this.update();
    }

    /** Per-pane `Shared color range` toggle: apply the union or restore the captured window. */
    setComparisonSharedRange(shared: boolean): void {
        const view = this.comparisonView;
        if (!view || view.sharedRange === shared) {
            return;
        }
        this.comparisonView = { ...view, sharedRange: shared };
        if (shared) {
            this.applyComparisonUnion(this.comparisonUnion);
        } else {
            this.applyProps({ rangeMode: this.comparisonRestoreRangeMode, customRange: this.comparisonRestoreCustomRange });
        }
        this.update();
    }

    /** Per-pane pane-label toggle (A/B/C badge). */
    setComparisonShowLabels(show: boolean): void {
        const view = this.comparisonView;
        if (!view || view.showLabels === show) {
            return;
        }
        this.comparisonView = { ...view, showLabels: show };
        this.update();
    }

    /** Active color-by array's data range (never the custom/effective mapping range). */
    getActiveDataRange(): [number, number] | undefined {
        const selection = parseColorBy(this.colorBy);
        if (!selection || selection.kind === 'solid') {
            return undefined;
        }
        const array = this.findArray(selection.kind, selection.name);
        return array ? [array.range[0], array.range[1]] : undefined;
    }

    /** Publish the current pose so the activated pane seeds the shared orientation. */
    syncComparisonCamera(): void {
        if (this.cameraLinked) {
            this.publishCameraPose();
        }
    }

    /** (Re)subscribe the comparison range endpoint after attach/join. */
    private ensureComparisonRangeSubscription(): void {
        const view = this.comparisonView;
        if (!view || this.comparisonRangeEndpoint) {
            return;
        }
        this.comparisonRangeEndpoint = comparisonRangeBus.link(view.sessionId, this.id, (range) => this.onComparisonRange(range));
        // A detach disposed the endpoint (and with it this view's range);
        // republish after every attach so the shared union stays complete.
        this.publishComparisonRange();
    }

    /** Drop the range endpoint (detach/dispose path — a re-attach re-subscribes). */
    private dropComparisonRangeSubscription(): void {
        this.comparisonRangeEndpoint?.dispose();
        this.comparisonRangeEndpoint = undefined;
    }

    /** Union update from the range bus: cache it and apply it while shared range is on. */
    private onComparisonRange(range: ComparisonRange | undefined): void {
        const previous = this.comparisonUnion;
        const unchanged =
            previous === undefined ? range === undefined : range !== undefined && previous[0] === range[0] && previous[1] === range[1];
        if (unchanged) {
            return;
        }
        this.comparisonUnion = range ? [range[0], range[1]] : undefined;
        if (this.comparisonView?.sharedRange) {
            this.applyComparisonUnion(this.comparisonUnion);
        }
        this.update();
    }

    /** Apply the union as a custom mapping window (no-op without a union). */
    private applyComparisonUnion(range: ComparisonRange | undefined): void {
        if (!range) {
            return;
        }
        this.applyProps({ rangeMode: 'custom', customRange: [range[0], range[1]] });
    }

    /** True when the effective mapping is exactly the shared union window. */
    private comparisonRangeApplied(range: ComparisonRange): boolean {
        return (
            this.rangeMode === 'custom' &&
            this.customRange !== undefined &&
            this.customRange[0] === range[0] &&
            this.customRange[1] === range[1]
        );
    }

    /** Re-apply the shared union after a mapping edit reset the range window. */
    private enforceComparisonSharedRange(): void {
        if (!this.comparisonView?.sharedRange || !this.comparisonUnion) {
            return;
        }
        if (this.comparisonRangeApplied(this.comparisonUnion)) {
            return;
        }
        this.applyComparisonUnion(this.comparisonUnion);
    }

    /** Publish the active data range (undefined clears this pane's contribution). */
    private publishComparisonRange(): void {
        this.comparisonRangeEndpoint?.publish(this.getActiveDataRange());
    }

    /** (Re)subscribe the link endpoint when the viewed file changes; drops it while there is no linkable file. */
    private ensureCameraLinkSubscription(): void {
        const key = this.cameraLinkKey();
        if (key === this.cameraLinkSubscribedKey) {
            return;
        }
        this.dropCameraLinkSubscription();
        if (key !== undefined) {
            this.cameraLinkEndpoint = cameraLinkBus.link(key, (pose) => this.onLinkedPose(pose));
            this.cameraLinkSubscribedKey = key;
        }
    }

    /** Drop the link subscription (detach/dispose path — no leaked bus listeners). */
    private dropCameraLinkSubscription(): void {
        this.cameraLinkEndpoint?.dispose();
        this.cameraLinkEndpoint = undefined;
        this.cameraLinkSubscribedKey = undefined;
    }

    /**
     * Orbit change hook: the existing render-on-demand repaint plus the link
     * publish when the toggle is on. Applying a linked pose sets
     * {@link applyingLinkedPose}, so the resulting change never rebroadcasts.
     */
    private onOrbitChanged(): void {
        this.renderScene();
        if (!this.cameraLinked || this.applyingLinkedPose) {
            return;
        }
        this.publishCameraPose();
    }

    /**
     * Publish the current orbit pose on the camera-link bus. Comparison panes
     * publish their live direction (their own target); same-file linking keeps
     * the mirrored fit target for parity. No-op without a live endpoint.
     */
    private publishCameraPose(): void {
        const camera = this.camera;
        const endpoint = this.cameraLinkEndpoint;
        if (!camera || !endpoint) {
            return;
        }
        const poseTarget = this.orbitControls?.getPose().target;
        const target = this.comparisonView ? (poseTarget ?? this.linkTarget) : (this.linkTarget ?? poseTarget);
        if (!target) {
            return;
        }
        const position = camera.position;
        endpoint.publish({
            position: [position.x, position.y, position.z],
            target: [target[0], target[1], target[2]]
        });
    }

    /**
     * Apply a linked pose from another pane. Outside a comparison the existing
     * same-file behavior applies (stage the linked distance, snap orientation).
     * Comparison panes apply the direction only through `setViewDirection`, so
     * every pane keeps its own target and framing distance. Display settings
     * are never touched: camera-only sync.
     */
    private onLinkedPose(pose: CameraLinkPose): void {
        if (!this.cameraLinked || this.applyingLinkedPose) {
            return;
        }
        const direction = cameraPoseDirection(pose);
        const camera = this.camera;
        const controls = this.orbitControls;
        if (!direction || !camera || !controls) {
            return;
        }
        this.applyingLinkedPose = true;
        try {
            if (!this.comparisonView) {
                // Same-file link parity: stage the source distance on the
                // owned camera before snapping the shared direction.
                camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
            }
            // Comparison panes stay cross-file: direction only, so every pane
            // keeps its own target and framing distance.
            controls.setViewDirection(direction);
        } finally {
            this.applyingLinkedPose = false;
        }
        this.renderScene();
    }

    /** Read the current settings for the sidebar panel. */
    getViewerSettingsSnapshot(): ViewerSettingsSnapshot {
        const solid = this.colorBy === SOLID_COLOR;
        const selection = parseColorBy(this.colorBy);
        const array = selection && selection.kind !== 'solid' ? this.findArray(selection.kind, selection.name) : undefined;
        const effectiveRange = array ? resolveEffectiveRange(this.rangeMode, array.range, this.customRange) : undefined;
        const warpOptions = this.warpOptions();
        const warpArray = this.resolvedWarpArray();
        const glyph = this.glyphSnapshot();
        const bivariate = selection && selection.kind === 'cell' ? this.bivariateCompanion(array) : undefined;
        return {
            widgetId: this.id,
            title: this.title.label,
            hasDataset: this.model !== undefined,
            colorBy: { value: this.colorBy, options: this.colorByOptions() },
            colormap: {
                value: this.colormap,
                options: [...COLORMAP_NAMES],
                disabled: solid,
                invert: this.invert,
                logScale: { value: this.logScale, disabled: !effectiveRange || !logScaleAvailable(effectiveRange) }
            },
            ...(array && array.components > 1
                ? { component: { value: this.component, options: [...componentOptions(array.components)] } }
                : {}),
            ...(array && effectiveRange
                ? {
                      range: {
                          mode: this.rangeMode,
                          min: effectiveRange[0],
                          max: effectiveRange[1],
                          dataMin: array.range[0],
                          dataMax: array.range[1]
                      }
                  }
                : {}),
            scalarBar: { visible: this.scalarBarVisible, title: this.scalarBarTitle, verticalLabels: this.scalarBarVertical },
            ...(bivariate
                ? {
                      bivariate: {
                          enabled: this.bivariateEnabled,
                          channel: this.bivariateOptions.channel,
                          maxRelativeError: this.bivariateOptions.maxRelativeError,
                          lowQualityColor: this.bivariateOptions.lowQualityColor
                      }
                  }
                : {}),
            ...(this.volumeSmoothGrid() !== undefined
                ? {
                      volume: {
                          visible: this.volumeVisible,
                          smooth: this.volumeMode === 'smooth',
                          opacityStops: this.volumeTransfer.opacityStops,
                          blendMode: this.volumeTransfer.blendMode,
                          shade: this.volumeTransfer.shade
                      }
                  }
                : {}),
            ...(this.sliceSource() !== undefined
                ? { slice: { axis: this.orthoSliceAxis, fraction: this.orthoSliceFraction, smooth: this.orthoSliceSmooth } }
                : {}),
            ...(warpOptions.length > 0 && warpArray !== undefined
                ? {
                      warp: {
                          enabled: this.warpEnabled,
                          array: warpArray,
                          options: warpOptions,
                          scaleMode: this.warpScaleMode,
                          scale: this.warpScale,
                          autoScale: this.warpAutoScale(),
                          effectiveScale: this.warpEffectiveScale()
                      }
                  }
                : {}),
            ...(array ? { threshold: this.thresholdSnapshotFor(array) } : {}),
            ...(glyph ? { glyph } : {}),
            ...(solid ? { solidColor: { value: this.solidColor } } : {}),
            background: { value: this.resolveBackground() },
            shading: { value: this.shading },
            clip: { state: this.clip, tab: this.clipTab, caps: this.clipCaps },
            measure: { active: this.measure.active },
            ...(this.comparisonView
                ? {
                      comparison: {
                          label: this.comparisonView.label,
                          linkCameras: this.comparisonView.linkCameras,
                          sharedRange: this.comparisonView.sharedRange,
                          showLabels: this.comparisonView.showLabels,
                          ...(this.comparisonUnion ? { range: [this.comparisonUnion[0], this.comparisonUnion[1]] as const } : {})
                      }
                  }
                : {}),
            axesGrid: { visible: this.axesGridVisible },
            opacity: { value: this.opacity, ...OPACITY_SPEC },
            pointSize: { value: this.pointSize, ...POINT_SIZE_SPEC },
            lineWidth: { value: this.lineWidth, ...LINE_WIDTH_SPEC }
        };
    }

    /** Capture the full viewer state (settings + camera) for Save view. */
    getViewerState(): ViewerState | undefined {
        const snapshot = this.getViewerSettingsSnapshot();
        if (!snapshot || !this.orbitControls) {
            return undefined;
        }
        const pose = this.orbitControls.getPose();
        return viewerStateFromSnapshot(snapshot, {
            position: pose.position,
            target: pose.target,
            up: pose.up ?? [0, 1, 0],
            orthographic: false
        });
    }

    /** Restore a saved viewer state (settings first, then the camera pose). */
    applyViewerState(state: ViewerState): void {
        this.applyViewerSettings(viewerStateToPatch(state));
        this.orbitControls?.setPose({
            position: state.camera.position,
            target: state.camera.target,
            up: state.camera.up
        });
        this.renderScene();
        this.update();
    }

    /** Apply a sidebar edit through the existing prop setters. */
    applyViewerSettings(patch: ViewerSettingsPatch): void {
        if (patch.comparisonLinkCameras !== undefined) {
            this.setComparisonLinkCameras(patch.comparisonLinkCameras);
        }
        if (patch.comparisonSharedRange !== undefined) {
            this.setComparisonSharedRange(patch.comparisonSharedRange);
        }
        if (patch.comparisonShowLabels !== undefined) {
            this.setComparisonShowLabels(patch.comparisonShowLabels);
        }
        if (patch.comparisonLeave) {
            this.leaveComparison();
        }
        if (patch.clipTab !== undefined && patch.clipTab !== this.clipTab) {
            this.clipTab = patch.clipTab;
            this.update();
        }
        if (patch.clipCaps !== undefined && patch.clipCaps !== this.clipCaps) {
            this.clipCaps = patch.clipCaps;
            this.applyClip();
            this.update();
        }
        if (patch.measureActive !== undefined) {
            this.setMeasureActive(patch.measureActive);
        }
        if (patch.axesGridVisible !== undefined && patch.axesGridVisible !== this.axesGridVisible) {
            this.setAxesGridVisible(patch.axesGridVisible);
        }
        if (patch.snap !== undefined) {
            this.snapViewerTo(viewerSnapDirection(patch.snap));
        }
        if (patch.tallyVolumeVisible !== undefined) {
            this.setVolumeVisible(patch.tallyVolumeVisible);
        }
        if (patch.tallyVolumeSmooth !== undefined) {
            this.setVolumeSmooth(patch.tallyVolumeSmooth);
        }
        if (patch.volumeVisible !== undefined) {
            this.setVolumeVisible(patch.volumeVisible);
        }
        if (patch.volumeSmooth !== undefined) {
            this.setVolumeSmooth(patch.volumeSmooth);
        }
        let volumeTransferChanged = false;
        if (patch.volumeOpacityStops !== undefined) {
            this.volumeTransfer = { ...this.volumeTransfer, opacityStops: normalizeOpacityStops(patch.volumeOpacityStops) };
            volumeTransferChanged = true;
        }
        if (patch.volumeBlendMode !== undefined) {
            this.volumeTransfer = { ...this.volumeTransfer, blendMode: patch.volumeBlendMode };
            volumeTransferChanged = true;
        }
        if (patch.volumeShade !== undefined) {
            this.volumeTransfer = { ...this.volumeTransfer, shade: patch.volumeShade };
            volumeTransferChanged = true;
        }
        if (volumeTransferChanged) {
            this.refreshVolumeSmooth();
            this.renderScene();
            this.update();
        }
        let sliceChanged = false;
        if (patch.sliceAxis !== undefined) {
            this.orthoSliceAxis = patch.sliceAxis;
            sliceChanged = true;
        }
        if (patch.sliceFraction !== undefined && Number.isFinite(patch.sliceFraction)) {
            this.orthoSliceFraction = Math.min(1, Math.max(0, patch.sliceFraction));
            sliceChanged = true;
        }
        if (patch.sliceSmooth !== undefined) {
            this.orthoSliceSmooth = patch.sliceSmooth;
            sliceChanged = true;
        }
        if (sliceChanged) {
            this.update();
        }
        let bivariateChanged = false;
        if (patch.bivariateEnabled !== undefined && patch.bivariateEnabled !== this.bivariateEnabled) {
            this.bivariateEnabled = patch.bivariateEnabled;
            bivariateChanged = true;
        }
        if (patch.bivariate !== undefined) {
            // Editor emits the complete options object; sanitize persisted
            // values here so a stale/garbage channel or threshold can never
            // paint every bin as masked.
            const next = patch.bivariate;
            const options: BivariateOptions = {
                channel: isUncertaintyChannel(next.channel) ? next.channel : DEFAULT_BIVARIATE_OPTIONS.channel,
                maxRelativeError: normalizeMaxRelativeError(next.maxRelativeError),
                lowQualityColor:
                    typeof next.lowQualityColor === 'string' && next.lowQualityColor.trim() !== ''
                        ? next.lowQualityColor
                        : DEFAULT_BIVARIATE_OPTIONS.lowQualityColor
            };
            if (
                options.channel !== this.bivariateOptions.channel ||
                options.maxRelativeError !== this.bivariateOptions.maxRelativeError ||
                options.lowQualityColor !== this.bivariateOptions.lowQualityColor
            ) {
                this.bivariateOptions = options;
                bivariateChanged = true;
            }
        }
        if (bivariateChanged) {
            // Same instant repaint as color-by/range edits: surfaces and
            // voxel instance colors follow the new blend, no reload.
            this.recolor();
            this.update();
        }
        let nextRangeMode: ColorRangeMode | undefined;
        let nextCustomRange: [number, number] | undefined;
        if (patch.range !== undefined) {
            if (patch.range === 'auto') {
                nextRangeMode = 'auto';
            } else {
                nextRangeMode = 'custom';
                nextCustomRange = [patch.range[0], patch.range[1]];
            }
        }
        let legendChanged = false;
        if (patch.scalarBarTitle !== undefined) {
            this.scalarBarTitle = patch.scalarBarTitle.trim().length > 0 ? patch.scalarBarTitle : undefined;
            legendChanged = true;
        }
        if (patch.scalarBarVertical !== undefined) {
            this.scalarBarVertical = patch.scalarBarVertical;
            legendChanged = true;
        }
        if (legendChanged) {
            this.update();
        }
        this.applyProps({
            colorBy: patch.colorBy,
            colormap: patch.colormap as ColormapName | undefined,
            component: patch.component,
            rangeMode: nextRangeMode,
            customRange: nextCustomRange,
            invert: patch.invert,
            logScale: patch.logScale,
            scalarBarVisible: patch.scalarBarVisible,
            solidColor: patch.solidColor,
            background: patch.background,
            opacity: patch.opacity,
            pointSize: patch.pointSize,
            lineWidth: patch.lineWidth,
            shading: patch.shading,
            clip: patch.clip,
            warpEnabled: patch.warpEnabled,
            warpArray: patch.warpArray,
            warpScaleMode: patch.warpScaleMode,
            warpScale: patch.warpScale,
            thresholdEnabled: patch.thresholdEnabled,
            thresholdRange: patch.thresholdRange,
            glyphEnabled: patch.glyphEnabled,
            glyphDensity: patch.glyphDensity,
            glyphScale: patch.glyphScale
        });
    }

    // ------------------------------------------------------------------
    // Smooth raycast volume (maximum-intensity projection over true 3D
    // grids; Viewer Settings tally-volume rows). Subclasses expose a grid
    // through volumeSmoothGrid(); without one the rows stay hidden and
    // every method below is a safe no-op.
    // ------------------------------------------------------------------

    /**
     * Grid behind the smooth raycast volume in world coordinates. Any
     * axis-aligned rectilinear/image dataset exposes one; subclasses may
     * override (the DAGMC drape supplies its tally grid separately).
     */
    protected volumeSmoothGrid(): VolumeGrid | undefined {
        const model = this.model;
        if (!model || (model.family !== 'rectilinear' && model.family !== 'image')) {
            return undefined;
        }
        const dims = model.gridDimensions;
        const axes = model.gridAxes;
        if (!dims || !axes) {
            return undefined;
        }
        const [xAxis, yAxis, zAxis] = axes;
        if (xAxis.length === 0 || yAxis.length === 0 || zAxis.length === 0) {
            return undefined;
        }
        return {
            dims: [dims[0], dims[1], dims[2]],
            min: [xAxis[0], yAxis[0], zAxis[0]],
            max: [xAxis[xAxis.length - 1], yAxis[yAxis.length - 1], zAxis[zAxis.length - 1]]
        };
    }

    /**
     * Cell-centered grid source for the Slice preview: the active cell array
     * reduced to one scalar per cell. Undefined for point clouds, Solid
     * Color, point-array color-by, or a grid whose active array is not a
     * one-tuple-per-cell array.
     */
    private sliceSource(): { source: GridSliceSource; array: NativeVtkDataArray } | undefined {
        const model = this.model;
        if (!model || (model.family !== 'rectilinear' && model.family !== 'image') || !model.gridDimensions) {
            return undefined;
        }
        const cells = model.gridDimensions[0] * model.gridDimensions[1] * model.gridDimensions[2];
        const selection = parseColorBy(this.colorBy);
        let array = selection && selection.kind === 'cell' ? this.findArray('cell', selection.name) : undefined;
        if (!array || array.values.length !== cells * Math.max(1, array.components)) {
            // Solid Color (or a point-array selection) still gets a useful
            // slice: use the first cell array with one tuple per cell.
            array = model.cellArrays.find((entry) => entry.values.length === cells * Math.max(1, entry.components));
        }
        if (!array) {
            return undefined;
        }
        const components = Math.max(1, array.components);
        if (array.values.length !== cells * components) {
            return undefined;
        }
        let values: ArrayLike<number> = array.values;
        if (components > 1) {
            const scalar = new Float64Array(cells);
            for (let i = 0; i < cells; i++) {
                scalar[i] = tupleScalar(array.values, components, i, this.component);
            }
            values = scalar;
        }
        return {
            source: {
                dims: model.gridDimensions,
                axes: model.gridAxes ?? [new Float64Array(0), new Float64Array(0), new Float64Array(0)],
                values,
                range: resolveEffectiveRange(this.rangeMode, array.range, this.customRange)
            },
            array
        };
    }

    /** Render the current 2D orthoslice for the Viewer Settings Slice section. */
    getSlicePreview(settings: ViewerSliceSettings): ViewerSlicePreview | undefined {
        const active = this.sliceSource();
        if (!active) {
            return undefined;
        }
        const mapping = this.scalarMappingFor(active.array);
        if (!mapping) {
            return undefined;
        }
        const slice = extractGridSlice(active.source, settings.axis, settings.fraction, settings.smooth ? 'linear' : 'nearest');
        if (!slice) {
            return undefined;
        }
        return { width: slice.width, height: slice.height, rgba: sliceToRgba(slice, mapping), range: slice.range };
    }

    /** Dataset Inspector: summary of the loaded model (no-op until a dataset lands). */
    getDatasetSummary(): DatasetSummary | undefined {
        return this.model ? summarizeNativeModel(this.model) : undefined;
    }

    /** Dataset Inspector: paged point/cell table for one named array. */
    getDatasetTable(association: DatasetAssociation, name: string): DatasetTable | undefined {
        return this.model ? tableForArray(this.model, association, name) : undefined;
    }

    /** Dataset Inspector: descriptive stats (and cell integral when measurable). */
    getDatasetStats(association: DatasetAssociation, name: string): DatasetStats | undefined {
        return this.model ? statsForArray(this.model, association, name, this.component) : undefined;
    }

    /** Find Data dialog overlay (transient; never document state). */
    protected renderFindData(): React.ReactNode {
        if (!this.findDataOpen || !this.model) {
            return undefined;
        }
        return (
            <div className="find-data-host">
                <FindDataDialog
                    arrays={[...this.model.pointArrays, ...this.model.cellArrays]}
                    onSelect={(association, name, indices) => this.setFindDataSelection(association, name, indices)}
                    onClear={() => this.clearFindDataSelection()}
                    onExtractCsv={(association, name, indices) => this.exportFindDataCsv(association, name, indices)}
                />
            </div>
        );
    }

    /**
     * Generic probe dialog overlay: point sampling works for every native
     * dataset, while the line tab needs a real file for the headless
     * `base.probe` run (converted tally tabs have no file URI).
     */
    protected renderProbe(): React.ReactNode {
        if (!this.probeDialogOpen || !this.model) {
            return undefined;
        }
        const model = this.model;
        const arrays = [...model.pointArrays, ...model.cellArrays].map((array) => ({
            association: array.association,
            name: array.name,
            components: array.components
        }));
        const selection = parseColorBy(this.colorBy);
        const defaultArray =
            selection && selection.kind !== 'solid' && this.findArray(selection.kind, selection.name) !== undefined
                ? { association: selection.kind, name: selection.name }
                : undefined;
        return (
            <div className="probe-host">
                <ProbeDialog
                    arrays={arrays}
                    defaultArray={defaultArray}
                    bounds={boundingBoxFromPositions(model.positions)}
                    samples={this.probeSamples}
                    picking={this.probePicking}
                    canProfile={this.fileUri !== undefined}
                    profileRunning={this.probeProfileRunning}
                    profileError={this.probeProfileError}
                    profileResult={this.probeProfileResult}
                    onTogglePick={() => this.setProbePicking(!this.probePicking)}
                    onClearSamples={() => this.clearProbeSamples()}
                    onExportSamples={() => this.exportProbeSamplesCsv()}
                    onRunProfile={(request) => void this.runProbeProfile(request)}
                    onExportProfile={() => this.exportProbeProfileCsv()}
                    onClose={() => this.closeProbe()}
                />
            </div>
        );
    }

    /** Apply a Find Data selection and rebuild the canvas highlight. */
    protected setFindDataSelection(association: FindDataAssociation, name: string, indices: Uint32Array): void {
        this.findDataSelection = { association, name, indices };
        this.rebuildSelectionOverlay();
        this.update();
    }

    /** Drop the transient selection (Clear / new dataset). */
    clearFindDataSelection(): void {
        this.findDataSelection = undefined;
        this.clearSelectionOverlay();
        this.update();
    }

    /** Download the selected tuples as CSV (x/y/z plus the source array). */
    protected exportFindDataCsv(association: FindDataAssociation, name: string, indices: Uint32Array): void {
        const array = this.findArray(association, name);
        if (!array) {
            return;
        }
        const csv = selectionToCsv({ values: array.values, components: array.components }, indices, {
            includeIndex: true,
            valueLabel: array.name
        });
        const blob = new Blob([csv], { type: 'text/csv' });
        const anchor = document.createElement('a');
        anchor.href = URL.createObjectURL(blob);
        anchor.download = `${this.fileUri?.path.base ?? 'selection'}-${name}.csv`;
        anchor.click();
        URL.revokeObjectURL(anchor.href);
    }

    // ------------------------------------------------------------------
    // Generic probe: point picking is client-side; line profiles
    // ride the existing headless `base.probe` seam. Every bit of this state
    // is viewport-transient (reset on rebuild, never documents).
    // ------------------------------------------------------------------

    /** Open/close the probe dialog from the nav trigger; closing disarms picking. */
    private toggleProbe(): void {
        this.probeDialogOpen = !this.probeDialogOpen;
        if (!this.probeDialogOpen) {
            this.probePicking = false;
        }
        this.update();
    }

    /** Close the probe dialog from its Close button (also disarms picking). */
    protected closeProbe(): void {
        if (!this.probeDialogOpen && !this.probePicking) {
            return;
        }
        this.probeDialogOpen = false;
        this.probePicking = false;
        this.update();
    }

    /** Arm/disarm canvas point picking (arming disarms the measure tool). */
    protected setProbePicking(active: boolean): void {
        if (this.probePicking === active) {
            return;
        }
        this.probePicking = active;
        if (active) {
            // Both tools consume the same canvas click; never both armed.
            this.setMeasureActive(false);
        }
        this.update();
    }

    /** Drop the point-probe history (dialog Clear) and its marker overlay. */
    protected clearProbeSamples(): void {
        if (this.probeSamples.length === 0) {
            return;
        }
        this.probeSamples = [];
        this.syncProbeMarkers();
        this.update();
    }

    /** Download the point-probe history as `<file>-probe.csv`. */
    protected exportProbeSamplesCsv(): void {
        if (this.probeSamples.length === 0) {
            return;
        }
        this.downloadProbeCsv('probe', probeSamplesToCsv(this.probeSamples));
    }

    /** Download the last line profile as `<file>-profile.csv`. */
    protected exportProbeProfileCsv(): void {
        if (!this.probeProfileResult) {
            return;
        }
        this.downloadProbeCsv('profile', probeLineToCsv(this.probeProfileResult));
    }

    /** Blob + anchor download (dataset name prefix, no server round-trip). */
    private downloadProbeCsv(kind: 'probe' | 'profile', csv: string): void {
        const blob = new Blob([csv], { type: 'text/csv' });
        const anchor = document.createElement('a');
        anchor.href = URL.createObjectURL(blob);
        anchor.download = `${this.fileUri?.path.base ?? 'dataset'}-${kind}.csv`;
        anchor.click();
        URL.revokeObjectURL(anchor.href);
    }

    /** Remove the current highlight group (dataset/selection change). */
    private clearSelectionOverlay(): void {
        const group = this.findDataGroup;
        if (!group) {
            return;
        }
        group.parent?.remove(group);
        this.disposeObject(group);
        this.findDataGroup = undefined;
    }

    /**
     * Rebuild the orange selection highlight from the current query indices.
     * Uses the same warped positions as the rendered scene and the same
     * clipping planes, so the highlight follows warp/clip edits.
     */
    private rebuildSelectionOverlay(): void {
        this.clearSelectionOverlay();
        const model = this.model;
        const selection = this.findDataSelection;
        if (!model || !selection || !this.dataGroup) {
            return;
        }
        const gridCells = model.gridDimensions ? model.gridDimensions[0] * model.gridDimensions[1] * model.gridDimensions[2] : 0;
        const overlay = buildSelectionOverlay(
            {
                positions: this.scenePositions(),
                family: model.family,
                pointCount: model.nPoints,
                cellCount: gridCells,
                triangles: model.triangles,
                triangleCells: model.triangleCells,
                segments: model.segments,
                segmentCells: model.segmentCells,
                vertices: model.vertices
            },
            selection.association,
            selection.indices
        );
        if (!overlay?.points || overlay.points.length === 0) {
            return;
        }
        const group = new THREE.Group();
        group.name = 'find-data-selection';
        const color = 0xffb300;
        if (overlay.triangles) {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(overlay.points, 3));
            geometry.setIndex(new THREE.BufferAttribute(overlay.triangles, 1));
            geometry.userData.role = 'find-data-selection';
            const material = new THREE.MeshBasicMaterial({
                color,
                transparent: true,
                opacity: 0.55,
                depthTest: false,
                depthWrite: false,
                side: THREE.DoubleSide
            });
            const mesh = new THREE.Mesh(geometry, material);
            mesh.renderOrder = 20;
            group.add(mesh);
        }
        if (overlay.segments) {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(overlay.points, 3));
            geometry.setIndex(new THREE.BufferAttribute(overlay.segments, 1));
            geometry.userData.role = 'find-data-selection';
            const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false });
            const lines = new THREE.LineSegments(geometry, material);
            lines.renderOrder = 20;
            group.add(lines);
        }
        if (!overlay.triangles && !overlay.segments) {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(overlay.points, 3));
            geometry.userData.role = 'find-data-selection';
            const material = new THREE.PointsMaterial({
                color,
                size: Math.max(4, this.pointSize * 2),
                sizeAttenuation: false,
                transparent: true,
                opacity: 0.95,
                depthTest: false,
                depthWrite: false,
                map: getPointSpriteTexture() ?? null
            });
            const points = new THREE.Points(geometry, material);
            points.renderOrder = 20;
            group.add(points);
        }
        const planes = this.toThreePlanes();
        group.traverse((child) => {
            if (child instanceof THREE.Mesh || child instanceof THREE.Points || child instanceof THREE.LineSegments) {
                (child.material as THREE.Material).clippingPlanes = planes;
            }
        });
        this.dataGroup.add(group);
        this.findDataGroup = group;
        this.renderScene();
    }

    /** Show or hide the volume (Viewer Settings toggle): boxes, smooth mesh, and grid points. */
    setVolumeVisible(visible: boolean): void {
        if (visible === this.volumeVisible) {
            return;
        }
        this.volumeVisible = visible;
        this.applyShadingVisibility();
        this.renderScene();
        this.update();
    }

    /** Switch the volume representation (Viewer Settings smooth toggle). */
    setVolumeSmooth(smooth: boolean): void {
        const mode: TallyVolumeMode = smooth ? 'smooth' : 'boxes';
        if (mode === this.volumeMode) {
            return;
        }
        this.volumeMode = mode;
        if (smooth && !this.volumeVisible) {
            // Same rule as the DAGMC drape: smooth selects a
            // representation, not visibility — otherwise enabling it while
            // hidden shows nothing.
            this.volumeVisible = true;
        }
        this.refreshVolumeSmooth();
        this.applyShadingVisibility();
        this.renderScene();
        this.update();
    }

    /** True while the smooth mesh should draw (mode on, grid present). */
    protected isVolumeSmoothActive(): boolean {
        return this.volumeMode === 'smooth' && this.volumeSmoothGrid() !== undefined;
    }

    /**
     * Follow-up for volume reconciles (underlay dimming and friends);
     * subclasses override, the default is a no-op.
     */
    protected syncUnderlayDimming(): void {}

    /** Build the RGBA raycast LUT from the current transfer function + global opacity. */
    private volumeLut(mapping: ScalarMapping, range: readonly [number, number]): Uint8Array<ArrayBuffer> {
        return buildVolumeTransferLut(mapping, range, this.volumeTransfer, VOLUME_LUT_SIZE, this.opacity);
    }

    /**
     * Reconcile the smooth raycast mesh with the current mode and color-by
     * array: builds it on first switch (falling back to boxes when the grid
     * is missing or WebGL2 3D textures fail), repacks the volume texture on
     * array/component switches, and refreshes the lookup otherwise. Smooth
     * renders mapped cell data only — Solid Color mode and non-cell arrays
     * revert to boxes so the volume never shows stale data.
     */
    protected refreshVolumeSmooth(): void {
        const smooth = this.volumeSmooth;
        const grid = this.volumeSmoothGrid();
        if (this.volumeMode !== 'smooth' || !grid || !this.dataGroup) {
            if (smooth) {
                smooth.mesh.visible = false;
            }
            this.syncUnderlayDimming();
            return;
        }
        const selection = parseColorBy(this.colorBy);
        const voxelArray = selection && selection.kind !== 'solid' ? this.findArray(selection.kind, selection.name) : undefined;
        const mapping = voxelArray ? this.scalarMappingFor(voxelArray) : undefined;
        const tupleCount = voxelArray ? Math.floor(voxelArray.values.length / Math.max(1, voxelArray.components)) : 0;
        const nCells = grid.dims[0] * grid.dims[1] * grid.dims[2];
        if (!voxelArray || !mapping || voxelArray.association !== 'cell' || tupleCount !== nCells) {
            console.warn('[native-vtk-viewer] smooth volume needs a mapped cell array — falling back to voxel boxes');
            this.volumeMode = 'boxes';
            if (smooth) {
                smooth.mesh.visible = false;
            }
            this.applyShadingVisibility();
            this.syncUnderlayDimming();
            this.update();
            return;
        }
        const resolved = new Float64Array(tupleCount);
        let dataMin = Infinity;
        let dataMax = -Infinity;
        for (let t = 0; t < tupleCount; t++) {
            const v = tupleScalar(voxelArray.values, voxelArray.components, t, mapping.component);
            resolved[t] = v;
            if (v < dataMin) {
                dataMin = v;
            }
            if (v > dataMax) {
                dataMax = v;
            }
        }
        if (!Number.isFinite(dataMin) || !Number.isFinite(dataMax)) {
            dataMin = 0;
            dataMax = 0;
        }
        const key = `${voxelArray.name}:${voxelArray.components}:${mapping.component}:${voxelArray.values.length}:${dataMin}:${dataMax}`;
        // A live handle whose mesh lost its group (dataset rebuild swaps
        // the data group out from under it) must recreate, not just
        // relut: updating a detached mesh leaves smooth mode blank.
        if (!smooth || smooth.mesh.parent !== this.dataGroup || this.volumePackedKey !== key) {
            const scalars = packVolumeScalars(resolved, grid.dims, [dataMin, dataMax]);
            try {
                if (smooth) {
                    smooth.mesh.parent?.remove(smooth.mesh);
                    smooth.dispose();
                    this.volumeSmooth = undefined;
                }
                this.volumePackedRange = [dataMin, dataMax];
                this.volumeSmooth = createVolumeRaycastMesh({
                    grid: {
                        dims: [...grid.dims] as [number, number, number],
                        min: [...grid.min] as [number, number, number],
                        max: [...grid.max] as [number, number, number]
                    },
                    scalars,
                    lut: this.volumeLut(mapping, [dataMin, dataMax]),
                    blendMode: this.volumeTransfer.blendMode,
                    shade: this.volumeTransfer.shade
                });
                this.volumePackedKey = key;
                // Drawn after translucent shells so the interior stays
                // readable (DAGMC drape precedent).
                this.volumeSmooth.mesh.renderOrder = 10;
                if (!this.volumeSmooth.mesh.parent) {
                    this.dataGroup.add(this.volumeSmooth.mesh);
                }
            } catch (error) {
                console.warn(
                    '[native-vtk-viewer] smooth volume failed, falling back to voxel boxes:',
                    error instanceof Error ? error.message : error
                );
                this.volumeMode = 'boxes';
                this.applyShadingVisibility();
                this.syncUnderlayDimming();
                this.update();
                return;
            }
        } else {
            smooth.updateLut(this.volumeLut(mapping, this.volumePackedRange ?? [0, 0]));
            smooth.setRenderOptions({ blendMode: this.volumeTransfer.blendMode, shade: this.volumeTransfer.shade });
        }
        this.applyVolumeClipBox();
        this.updateVolumeVisibility();
        this.syncUnderlayDimming();
    }

    /** Show the smooth mesh exactly when its mode is active (boxes follow the shading flags). */
    private updateVolumeVisibility(): void {
        if (!this.dataGroup) {
            return;
        }
        const flags = resolveViewerShadingFlags(this.shading, this.opacity);
        if (this.volumeSmooth) {
            this.volumeSmooth.mesh.visible = this.volumeVisible && this.volumeMode === 'smooth' && !flags.pointsOnly;
        }
    }

    /** CPU box-section clip for the smooth mesh (the raycast shader has no clipping chunks). */
    private applyVolumeClipBox(): void {
        const smooth = this.volumeSmooth;
        const grid = this.volumeSmoothGrid();
        if (!smooth || !grid || !this.model) {
            return;
        }
        const bounds = boundingBoxFromPositions(this.model.positions);
        if (!bounds) {
            return;
        }
        const placement = clipVolumeBox(
            this.clip,
            [bounds.min[0], bounds.min[1], bounds.min[2]],
            [bounds.max[0], bounds.max[1], bounds.max[2]],
            grid.min,
            grid.max
        );
        if (!placement) {
            smooth.mesh.visible = false;
            return;
        }
        smooth.setBox(placement.center, placement.size);
    }

    // ------------------------------------------------------------------
    // Source-bank point layer ("+ Source" flow): one round point per
    // particle over the dataset, colored by energy (weight fallback)
    // through the current colormap with its own data range — independent
    // of the dataset color-by array. Follows the point-size/opacity
    // sliders and clip planes like any other points.
    // ------------------------------------------------------------------

    /** Drop the source-bank overlay (new dataset load); visibility state is not kept. */
    protected clearTallySource(): void {
        if (this.tallySourcePoints) {
            this.tallySourcePoints.parent?.remove(this.tallySourcePoints);
            this.tallySourcePoints.geometry.dispose();
            (this.tallySourcePoints.material as THREE.Material).dispose();
            this.tallySourcePoints = undefined;
        }
        this.tallySourceValues = undefined;
        this.tallySourceRange = undefined;
    }

    /**
     * Layer a converted source-bank `.vtp` cloud over the scene: one round
     * point per particle. Throws when the file is not a point cloud.
     */
    async setSourceFile(uri: URI): Promise<void> {
        this.clearTallySource();
        const text = await readVtkText(this.fileService, uri);
        const model = await parseNativeVtkXml(text);
        if (model.family !== 'polydata' || model.positions.length === 0) {
            throw new Error(`Source file '${uri.path.base}' holds no point cloud to overlay`);
        }
        const picked = selectSourceColorArray(model.pointArrays.map((entry) => entry.name));
        const sourceArray = picked !== undefined ? model.pointArrays.find((entry) => entry.name === picked) : undefined;
        const count = Math.floor(model.positions.length / 3);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(model.positions.slice(), 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
        geometry.userData = { role: 'tally-source' };
        const material = new THREE.PointsMaterial({
            size: this.pointSize,
            vertexColors: true,
            transparent: true,
            opacity: this.opacity,
            sizeAttenuation: false,
            depthWrite: false,
            map: getPointSpriteTexture() ?? null
        });
        const points = new THREE.Points(geometry, material);
        points.name = 'tally-source';
        points.frustumCulled = false;
        points.renderOrder = 10;
        this.tallySourcePoints = points;
        if (sourceArray) {
            this.tallySourceValues = sourceArray.values.slice() as Float64Array;
            this.tallySourceRange = [...sourceArray.range] as [number, number];
        }
        if (this.dataGroup) {
            this.dataGroup.add(points);
            this.applyClip();
            this.syncMaterialProps();
            this.refreshTallySourceColors();
            this.renderScene();
        }
        this.update();
    }

    /**
     * Recolor the source overlay from its energy values (weight fallback,
     * solid when neither exists) through the current colormap with the
     * energy data range — independent of the dataset color-by array.
     */
    protected refreshTallySourceColors(): void {
        const points = this.tallySourcePoints;
        if (!points) {
            return;
        }
        const geometry = points.geometry as THREE.BufferGeometry;
        const colors = geometry.getAttribute('color') as THREE.BufferAttribute;
        const solid = new THREE.Color(this.solidColor);
        const values = this.tallySourceValues;
        if (!values || !this.tallySourceRange) {
            for (let i = 0; i < colors.count; i++) {
                colors.setXYZ(i, solid.r, solid.g, solid.b);
            }
            colors.needsUpdate = true;
            return;
        }
        const definition = getColormap(this.colormap);
        const mapping: ScalarMapping | undefined = definition
            ? { definition, range: this.tallySourceRange, logScale: this.logScale, invert: this.invert, component: MAGNITUDE_COMPONENT }
            : undefined;
        for (let i = 0; i < colors.count && i < values.length; i++) {
            const mapped = mapping ? mapScalar(values[i], mapping) : undefined;
            if (mapped) {
                colors.setXYZ(i, mapped[0], mapped[1], mapped[2]);
            } else {
                colors.setXYZ(i, solid.r, solid.g, solid.b);
            }
        }
        colors.needsUpdate = true;
    }

    /**
     * Instant-open entry: show the viewer tab with a loading status while a
     * headless conversion runs, so the tab appears immediately instead of
     * waiting on the backend. Mirrors the DAGMC `beginPendingLoad` pattern.
     */
    beginPendingLoad(label: string, statusMessage: string): void {
        this.title.label = `${NativeVtkViewerWidget.LABEL}: ${label}`;
        this.title.caption = `${NativeVtkViewerWidget.LABEL}: ${label}`;
        this.isLoading = true;
        this.error = undefined;
        this.statusMessage = statusMessage;
        this.update();
    }

    /** Fail the pending load in-tab (conversion failure shows the error panel, not a toast-only dead end). */
    failPendingLoad(message: string): void {
        this.isLoading = false;
        this.error = message;
        this.statusMessage = '';
        this.update();
    }

    /** Load a VTK file from disk through Theia's FileService (no HTTP fetch). */
    async setVtkFile(uri: URI): Promise<void> {
        this.fileUri = uri;
        this.ensureCameraLinkSubscription();
        this.id = `${NativeVtkViewerWidget.ID}:${uri.path.toString()}`;
        this.title.label = `${NativeVtkViewerWidget.LABEL}: ${uri.path.base}`;
        this.title.caption = `${NativeVtkViewerWidget.LABEL}: ${uri.path.toString()}`;
        const token = ++this.loadToken;
        this.isLoading = true;
        this.error = undefined;
        this.statusMessage = 'Reading VTK file…';
        this.update();
        try {
            const text = await readVtkText(this.fileService, uri);
            if (token !== this.loadToken) {
                return;
            }
            await this.setVtkText(text, token);
        } catch (error) {
            if (token !== this.loadToken) {
                return;
            }
            this.isLoading = false;
            this.error = error instanceof Error ? error.message : String(error);
            this.messageService.error(`Failed to load VTK file: ${this.error}`);
            this.update();
        }
    }

    /** Load already-read VTK XML text (used after FileService reads and by future contributions). */
    async setVtkText(text: string, token = ++this.loadToken): Promise<void> {
        this.ensureCameraLinkSubscription();
        this.isLoading = true;
        this.error = undefined;
        this.statusMessage = 'Parsing VTK dataset…';
        this.update();
        try {
            // Dispatcher (XML + legacy ASCII): the probe and this parse must
            // agree, or probed-OK legacy files fail here with an XML error.
            const model = await parseNativeVtk(text, this.fileUri?.path.ext ?? '');
            if (token !== this.loadToken) {
                return;
            }
            this.model = model;
            this.classified = classifyNativeVtkArrays([...model.pointArrays, ...model.cellArrays]);
            const fallback = defaultNativeColorBy(this.classified, model.family);
            if (parseColorBy(this.colorBy) === undefined || !this.hasArray(this.colorBy)) {
                this.setColorBy(fallback ?? SOLID_COLOR);
            }
            // A new dataset keeps the warp switch but re-defaults the array
            // (the previous DISP may not exist here); warp stays a no-op
            // until a 3-component point array is present.
            const warpFallback = this.warpOptions()[0];
            if (warpFallback && !this.warpOptions().some((option) => option.value === this.warpArray)) {
                this.warpArray = warpFallback.value;
            }
            this.note = '';
            this.isLoading = false;
            this.statusMessage = '';
            this.buildScene();
            this.update();
            // Comparison shared-range input after the dataset lands.
            this.publishComparisonRange();
            this.enforceComparisonSharedRange();
        } catch (error) {
            if (token !== this.loadToken) {
                return;
            }
            this.isLoading = false;
            this.error = error instanceof Error ? error.message : String(error);
            this.messageService.error(`Failed to parse VTK dataset: ${this.error}`);
            this.update();
        }
    }

    /** Download a screenshot of the current canvas (one-click PNG by default). */
    saveScreenshot(options: ScreenshotOptions = {}): void {
        if (!this.renderer || !this.scene || !this.camera || !this.model) {
            return;
        }
        const dataUrl = captureRendererScreenshot(this.renderer, this.scene, this.camera, this.host ?? this.renderer.domElement, options);
        this.renderScene();
        downloadScreenshotDataUrl(dataUrl, {
            ...options,
            filename: buildScreenshotFilename(this.fileUri?.path.base ?? 'native-vtk', new Date(), options.format ?? 'png')
        });
    }

    /** Export the loaded dataset through the headless `base.export` command. */
    async exportData(format: 'csv' | 'vtk'): Promise<void> {
        const uri = this.fileUri;
        if (!uri) {
            return;
        }
        const source = uri.path.fsPath();
        const extension = format === 'csv' ? '.csv' : uri.path.ext || '.vtk';
        const output = `${source}.viewer-export${extension}`;
        try {
            const result = await this.visualizerBackend.runBaseCommand('base.export', [
                '--file',
                source,
                '--format',
                format,
                '--output',
                output
            ]);
            const exported = (result as { path?: string }).path ?? output;
            const exportedUri = new URI(exported);
            const content = await this.fileService.read(exportedUri);
            const blob = new Blob([content.value.toString()], { type: format === 'csv' ? 'text/csv' : 'text/plain' });
            const anchor = document.createElement('a');
            anchor.href = URL.createObjectURL(blob);
            anchor.download = `${uri.path.base}.export${extension}`;
            anchor.click();
            URL.revokeObjectURL(anchor.href);
            try {
                await this.fileService.delete(exportedUri, { useTrash: false });
            } catch {
                // Best-effort cleanup; a failed delete must not hide the export.
            }
        } catch (error) {
            this.messageService.error(error instanceof Error ? error.message : String(error));
        }
    }

    /** Run `base.mesh-quality`, then open the metric dataset in a new viewer tab. */
    async applyMeshQuality(metric: MeshQualityMetric): Promise<void> {
        const uri = this.fileUri;
        if (!uri) {
            return;
        }
        const source = uri.path.fsPath();
        const extension = this.model?.family === 'polydata' ? '.vtp' : '.vtu';
        const output = `${source}.quality${extension}`;
        try {
            const result = await this.visualizerBackend.runBaseCommand('base.mesh-quality', [
                '--file',
                source,
                '--output',
                output,
                '--metric',
                metric
            ]);
            const path = (result as { path?: string }).path ?? output;
            await this.workspaceService.open(new URI(path));
        } catch (error) {
            this.messageService.error(error instanceof Error ? error.message : String(error));
        }
    }

    /**
     * Run the headless `base.probe --path` profile for the dialog request and
     * publish the parsed series. Token-guarded like dataset loads, so a stale
     * response can never overwrite a newer run or a rebuilt dataset.
     */
    protected async runProbeProfile(request: ProbeProfileRequest): Promise<void> {
        const uri = this.fileUri;
        if (!uri) {
            this.probeProfileError = 'Line profiles need a file-backed viewer — this tab renders converted data.';
            this.probeProfileResult = undefined;
            this.update();
            return;
        }
        const source = uri.path.fsPath();
        const token = ++this.probeProfileToken;
        this.probeProfileRunning = true;
        this.probeProfileError = undefined;
        this.probeProfileResult = undefined;
        this.update();
        try {
            const result = await this.visualizerBackend.runBaseCommand('base.probe', [
                '--file',
                source,
                '--array',
                `${request.association}:${request.name}`,
                '--path',
                `${request.start};${request.end}`,
                '--samples',
                String(request.samples)
            ]);
            if (token !== this.probeProfileToken) {
                return;
            }
            this.probeProfileResult = this.parseProbeLineResult(result, request);
            this.probeProfileRunning = false;
            this.update();
        } catch (error) {
            if (token !== this.probeProfileToken) {
                return;
            }
            this.probeProfileRunning = false;
            this.probeProfileError = error instanceof Error ? error.message : String(error);
            this.update();
        }
    }

    /**
     * Validate the `base.probe` stdout payload into a {@link ProbeLineResult}:
     * finite distances/positions only, non-finite values stay `null` so the
     * chart renders gaps. Throws on an error payload or an empty series.
     */
    private parseProbeLineResult(payload: unknown, request: ProbeProfileRequest): ProbeLineResult {
        if (typeof payload !== 'object' || payload === null) {
            throw new Error('Probe returned no result');
        }
        const data = payload as {
            array?: unknown;
            association?: unknown;
            series?: unknown;
            length?: unknown;
            dataRange?: unknown;
            error?: unknown;
        };
        if (typeof data.error === 'string') {
            throw new Error(data.error);
        }
        const rawSeries = Array.isArray(data.series) ? data.series : [];
        const series: ProbeLinePoint[] = [];
        for (const entry of rawSeries) {
            if (typeof entry !== 'object' || entry === null) {
                continue;
            }
            const point = entry as { distance?: unknown; position?: unknown; value?: unknown; valid?: unknown };
            const position = Array.isArray(point.position) ? point.position : undefined;
            if (typeof point.distance !== 'number' || !Number.isFinite(point.distance) || position === undefined || position.length < 3) {
                continue;
            }
            const [x, y, z] = position;
            const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
            if (!finite(x) || !finite(y) || !finite(z)) {
                continue;
            }
            const value = finite(point.value) ? point.value : null;
            const valid = typeof point.valid === 'boolean' ? point.valid && value !== null : value !== null;
            series.push({ distance: point.distance, position: [x, y, z], value, valid });
        }
        if (series.length === 0) {
            throw new Error('Probe returned no profile samples');
        }
        const association: ProbeAssociation = data.association === 'cell' ? 'cell' : request.association;
        const length = typeof data.length === 'number' && Number.isFinite(data.length) ? data.length : undefined;
        const rawRange = Array.isArray(data.dataRange) ? data.dataRange : undefined;
        const dataRange =
            rawRange !== undefined &&
            rawRange.length >= 2 &&
            typeof rawRange[0] === 'number' &&
            Number.isFinite(rawRange[0]) &&
            typeof rawRange[1] === 'number' &&
            Number.isFinite(rawRange[1])
                ? ([rawRange[0], rawRange[1]] as const)
                : undefined;
        return {
            array: typeof data.array === 'string' ? data.array : request.name,
            association,
            series,
            length,
            dataRange
        };
    }

    /** Copy the current canvas to the clipboard (falls back to a visible warning). */
    async copyScreenshot(options: ScreenshotOptions = {}): Promise<void> {
        if (!this.renderer || !this.scene || !this.camera) {
            return;
        }
        const dataUrl = captureRendererScreenshot(this.renderer, this.scene, this.camera, this.host ?? this.renderer.domElement, options);
        this.renderScene();
        try {
            await copyScreenshotDataUrl(dataUrl);
        } catch (error) {
            this.messageService.warn(error instanceof Error ? error.message : String(error));
        }
    }

    /** Frame the loaded dataset through the orbit controls (target + distance). */
    fitView(): void {
        const model = this.model;
        if (!model || !this.camera || !this.orbitControls) {
            return;
        }
        // Frame the rendered scene (warped when warp is active), not the
        // base positions, so magnified deformation never orbits out of view.
        const positions = this.scenePositions();
        if (positions.length === 0) {
            return;
        }
        const box = new THREE.Box3();
        for (let i = 0; i < positions.length; i += 3) {
            box.expandByPoint(new THREE.Vector3(positions[i], positions[i + 1], positions[i + 2]));
        }
        // Widen by the underlay holder when present (overlay mode frames
        // tally voxels and ghost geometry together); empty holders expand
        // to nothing.
        const underlay = this.dataGroup?.getObjectByName(UNDERLAY_GROUP_NAME);
        if (underlay) {
            box.expandByObject(underlay);
        }
        const center: [number, number, number] = [(box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2];
        this.orbitControls.fitBounds([box.min.x, box.min.y, box.min.z], [box.max.x, box.max.y, box.max.z]);
        // Mirror the orbit target for link publishes (fit is the only
        // widget-driven target change; a local pan re-anchors on the next fit).
        this.linkTarget = center;
    }

    // ------------------------------------------------------------------
    // React rendering
    // ------------------------------------------------------------------

    protected render(): React.ReactNode {
        return (
            <div className="openmc-output-viewer-container">
                {this.renderHeader()}
                {this.error ? this.renderError() : this.renderContent()}
            </div>
        );
    }

    /**
     * Optional header strip. The base viewer keeps no header at all —
     * screenshot/reload ride the nav bar ({@link renderNavCluster}) and the
     * file name lives exactly once in the canvas `ViewBadge`. Subclasses with
     * real header content (tally kind chip, random-ray quick-select) override
     * this. Display settings live in the Viewer Settings sidebar, which
     * drives this widget through `applyViewerSettings`.
     */
    protected renderHeader(): React.ReactNode {
        return undefined;
    }

    protected renderContent(): React.ReactNode {
        if (this.isLoading && !this.model) {
            return (
                <div className="openmc-output-viewer-status">
                    <div className="openmc-output-viewer-spinner"></div>
                    <span>{this.statusMessage || 'Loading…'}</span>
                </div>
            );
        }
        return (
            <>
                <div className="openmc-output-viewer-viewarea">
                    <div className="openmc-output-viewer-hint nuke-viewer-status-line">
                        {this.describeModel()}
                        {this.note ? ` — ${this.note}` : ''} Drag to orbit, wheel to zoom, right-drag to pan.
                        {this.measure.active ? ' Measure mode: click two surface points; Escape cancels.' : ''}
                        {this.probePicking ? ' Probe mode: click the canvas to read values; Escape cancels.' : ''}
                    </div>
                    <div style={{ flex: '1', minHeight: '0', position: 'relative', display: 'flex' }}>
                        <div ref={this.attachHost} style={{ flex: '1', minHeight: '0', position: 'relative' }} />
                        {this.renderViewBadge()}
                        {this.renderComparisonBadge()}
                        {this.renderNavCluster()}
                        {this.renderGizmo()}
                        {this.renderMeasureLabel()}
                        {this.renderFindData()}
                        {this.renderProbe()}
                        <AxesGridOverlayHost
                            ref={(handle) => {
                                this.axesGridOverlayRef = handle;
                            }}
                            visible={this.axesGridVisible}
                        />
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
     * cards whose controls call the existing prop setters — stateless
     * mirrors of the sidebar, never new state.
     *
     * The one-click X-plane section button is folded into the Clip card
     * (per-axis enable covers it); Exclude/Isolate stay DAGMC-only direct
     * buttons (transient canvas selection, no CAD popover analog).
     */
    protected renderNavCluster(): React.ReactNode {
        const disabled = this.isLoading || !this.model;
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
                    <LinkCamerasTrigger
                        linked={this.cameraLinked}
                        disabled={disabled || this.cameraLinkKey() === undefined}
                        onToggle={() => this.toggleCameraLink()}
                    />
                    <FindDataTrigger
                        active={this.findDataSelection !== undefined}
                        disabled={disabled}
                        onClick={() => {
                            this.findDataOpen = !this.findDataOpen;
                            this.update();
                        }}
                    />
                    <ProbeTrigger active={this.probeDialogOpen} disabled={disabled} onClick={() => this.toggleProbe()} />
                    <ViewerQualityMenu
                        disabled={disabled || this.fileUri === undefined}
                        onApply={(metric) => void this.applyMeshQuality(metric)}
                    />
                    <ViewerPanelActions
                        disabled={disabled}
                        onOpenSettings={() => void this.commands.executeCommand(VIEWER_SETTINGS_COMMAND_ID)}
                        onOpenDatasetInspector={() => void this.commands.executeCommand(DATASET_INSPECTOR_COMMAND_ID)}
                    />
                    <ViewerFileActions
                        disabled={disabled}
                        onScreenshot={() => this.saveScreenshot()}
                        onReload={() => this.fileUri && this.setVtkFile(this.fileUri)}
                        exportMenu={
                            <ViewerExportMenu
                                disabled={disabled}
                                onExport={(options) => this.saveScreenshot(options)}
                                onCopy={(options) => void this.copyScreenshot(options)}
                                onExportData={(format) => void this.exportData(format)}
                            />
                        }
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

    /** Dataset badge over the 3D viewarea (hidden until a dataset loads). */
    protected renderViewBadge(): React.ReactNode {
        if (!this.model) {
            return undefined;
        }
        return <ViewBadge text={this.fileUri?.path.base ?? 'VTK dataset'} />;
    }

    /** Comparison pane label (A/B/C) below the dataset badge while labels are on. */
    protected renderComparisonBadge(): React.ReactNode {
        const comparison = this.comparisonView;
        if (!comparison || !comparison.showLabels) {
            return undefined;
        }
        return <div className="nuke-viewer-comparison-badge">{comparison.label}</div>;
    }

    /** Shared orientation cube over the 3D viewarea (hidden until a dataset loads). */
    protected renderGizmo(): React.ReactNode {
        if (!this.model) {
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

    /** Distance-measure label over the 3D viewarea (hidden until a dataset loads; positioned imperatively). */
    protected renderMeasureLabel(): React.ReactNode {
        if (!this.model) {
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

    /** Raycast-pick threshold from the dataset bounds (points/lines need a world-size tolerance). */
    private measurePickTolerance(): number {
        const bounds = this.model ? boundingBoxFromPositions(this.model.positions) : undefined;
        if (!bounds) {
            return this.measureMarkerSize;
        }
        const dx = bounds.max[0] - bounds.min[0];
        const dy = bounds.max[1] - bounds.min[1];
        const dz = bounds.max[2] - bounds.min[2];
        return Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz) * 0.01, 1e-9);
    }

    /**
     * Canvas click while the measure tool is active: raycast the data meshes
     * and record the surface point. Probe picking takes precedence on the same
     * click (the two tools are mutually exclusive by construction).
     */
    private onMeasureClick = (event: MouseEvent): void => {
        if (event.button !== 0) {
            return;
        }
        if (this.probePicking) {
            this.onProbeClick(event);
            return;
        }
        if (!this.measure.active) {
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
        // Data meshes only (never the measure overlay itself): a miss leaves
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
     * Canvas click while probe picking is armed: raycast the data group,
     * resolve the hit tuple in the active array, and prepend the sample.
     * Overlays (edges, clip caps, selection highlight, box helper) are
     * skipped so their indices never resolve against the model.
     */
    private onProbeClick(event: MouseEvent): void {
        const model = this.model;
        const canvas = this.renderer?.domElement;
        const camera = this.camera;
        const dataGroup = this.dataGroup;
        if (!model || !canvas || !camera || !dataGroup) {
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
        let intersection: THREE.Intersection | undefined;
        let kind: ProbeHit['kind'] | undefined;
        for (const candidate of raycaster.intersectObjects(dataGroup.children, true)) {
            const classified = this.probeHitKind(candidate.object);
            if (classified !== undefined) {
                intersection = candidate;
                kind = classified;
                break;
            }
        }
        if (!intersection || kind === undefined) {
            return;
        }
        const hit: ProbeHit = {
            position: [intersection.point.x, intersection.point.y, intersection.point.z],
            kind,
            faceIndex: intersection.faceIndex ?? undefined,
            pointIndex: intersection.index ?? undefined,
            instanceId: intersection.instanceId ?? undefined
        };
        const array = this.probeActiveArray();
        const tuple = array ? resolveProbeTuple(this.probeTopology(model), hit, array.association) : undefined;
        const value = array && tuple !== undefined ? sampleProbeValue(array, tuple, this.component) : undefined;
        const sample: ProbeSample = {
            position: hit.position,
            association: array?.association,
            array: array?.name,
            tuple,
            value
        };
        this.probeSamples = [sample, ...this.probeSamples].slice(0, PROBE_SAMPLE_ROW_CAP);
        this.syncProbeMarkers();
        this.update();
    }

    /** Classify a data-group hit for probing (undefined = overlay or non-data geometry). */
    private probeHitKind(object: THREE.Object3D): ProbeHit['kind'] | undefined {
        // Box3Helper (grid bounds) is a role-less LineSegments — never data.
        if (object instanceof THREE.Box3Helper) {
            return undefined;
        }
        if (object === this.glyphMesh) {
            // Direction glyphs are derived cones, not dataset cells.
            return undefined;
        }
        if (object instanceof THREE.InstancedMesh) {
            return this.voxelLayout ? 'voxel' : undefined;
        }
        if (object instanceof THREE.LineSegments) {
            const role = probeObjectRole(object);
            return isShadingEdgeRole(role) || role === 'find-data-selection' ? undefined : 'lines';
        }
        if (object instanceof THREE.Points) {
            const role = probeObjectRole(object);
            if (role === 'find-data-selection' || role === 'tally-source') {
                return undefined;
            }
            if (role === 'mesh-points' || role === 'line-points' || role === 'grid-points') {
                return role;
            }
            return 'points';
        }
        if (object instanceof THREE.Mesh) {
            // Only the surface soup maps face indices onto model triangles;
            // clip caps and the smooth volume are derived geometry.
            return probeObjectRole(object) === 'mesh' ? 'mesh' : undefined;
        }
        return undefined;
    }

    /** Active color-by array in probe-model shape (undefined in Solid Color or when the array is missing). */
    private probeActiveArray(): ProbeArray | undefined {
        const selection = parseColorBy(this.colorBy);
        if (!selection || selection.kind === 'solid') {
            return undefined;
        }
        const array = this.findArray(selection.kind, selection.name);
        return array === undefined
            ? undefined
            : { association: array.association, name: array.name, components: array.components, values: array.values };
    }

    /** Topology snapshot for tuple resolution (rendered positions, grid stride, voxel cells). */
    private probeTopology(model: NativeVtkModel): ProbeTopology {
        return {
            positions: this.scenePositions(),
            nPoints: model.nPoints,
            stride: strideForBudget(model.positions.length / 3),
            triangles: model.triangles,
            triangleCells: model.triangleCells,
            segments: model.segments,
            segmentCells: model.segmentCells,
            voxelCells: this.voxelLayout?.cells
        };
    }

    /**
     * Lazily create the world-anchored probe-marker group. It hangs off the
     * scene (never `dataGroup`), so probe/measure raycasts cannot hit the
     * markers and clipping leaves the annotations visible.
     */
    private ensureProbeMarkerGroup(): THREE.Group | undefined {
        if (!this.scene) {
            return undefined;
        }
        if (!this.probeMarkerGroup) {
            this.probeMarkerGroup = new THREE.Group();
            this.probeMarkerGroup.name = 'probe-markers';
            this.scene.add(this.probeMarkerGroup);
        }
        return this.probeMarkerGroup;
    }

    /** Dispose every marker geometry/material and detach the overlay group. */
    private clearProbeMarkers(): void {
        const group = this.probeMarkerGroup;
        if (!group) {
            return;
        }
        while (group.children.length > 0) {
            const child = group.children.pop();
            if (child instanceof THREE.Mesh) {
                child.geometry.dispose();
                (child.material as THREE.Material).dispose();
            }
        }
        group.removeFromParent();
        this.probeMarkerGroup = undefined;
    }

    /**
     * Rebuild the marker overlay from the newest-first sample history: one
     * low-poly sphere per sample, with index 0 larger and accented. Runs on
     * sample/clear/build only, never per frame.
     */
    private syncProbeMarkers(): void {
        this.clearProbeMarkers();
        if (this.probeSamples.length === 0) {
            this.renderScene();
            return;
        }
        const group = this.ensureProbeMarkerGroup();
        if (!group) {
            return;
        }
        const baseRadius = this.measureMarkerSize * PROBE_MARKER_HISTORY_SCALE;
        this.probeSamples.forEach((sample, index) => {
            const newest = index === 0;
            const geometry = new THREE.SphereGeometry(probeMarkerRadius(baseRadius, index), 12, 8);
            const material = newest
                ? new THREE.MeshBasicMaterial({ color: PROBE_MARKER_NEWEST_COLOR })
                : new THREE.MeshBasicMaterial({
                      color: PROBE_MARKER_HISTORY_COLOR,
                      transparent: true,
                      opacity: PROBE_MARKER_HISTORY_OPACITY,
                      depthWrite: false
                  });
            const marker = new THREE.Mesh(geometry, material);
            marker.position.set(sample.position[0], sample.position[1], sample.position[2]);
            group.add(marker);
        });
        this.renderScene();
    }

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
        // Probe picking is the most recent arm (dialog close comes next, so a
        // second Escape closes the card); measure cancel stays last.
        if (this.probePicking) {
            this.probePicking = false;
            this.update();
            event.stopPropagation();
            event.preventDefault();
            return;
        }
        if (this.probeDialogOpen) {
            this.probeDialogOpen = false;
            this.update();
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
        if (!segment || !this.model) {
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
        const selection = parseColorBy(this.colorBy);
        const array = selection && selection.kind !== 'solid' ? this.findArray(selection.kind, selection.name) : undefined;
        if (!array) {
            return undefined;
        }
        const mapping = this.scalarMappingFor(array);
        if (!mapping) {
            return undefined;
        }
        const title = this.scalarBarTitle?.trim() || array.name;
        return (
            <div className="nuke-viewer-legend-anchor">
                <Tooltip
                    content={`${title}: ${formatRangeValue(mapping.range[0])} to ${formatRangeValue(mapping.range[1])}`}
                    position="top"
                    stretch
                >
                    <div className={`nuke-viewer-legend${this.scalarBarVertical ? ' nuke-viewer-legend-vertical' : ''}`}>
                        <div className="nuke-viewer-legend-title">{title}</div>
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

    /** Toggle the bounding-box axes grid and its labels. */
    setAxesGridVisible(visible: boolean): void {
        this.axesGridVisible = visible;
        if (visible && !this.axesGridLines) {
            this.rebuildAxesGridLines();
        }
        if (this.axesGridLines) {
            this.axesGridLines.visible = visible;
        }
        this.updateAxesGridOverlay();
        this.update();
        this.renderScene();
    }

    /** Rebuild grid lines from the current (possibly warped) scene bounds. */
    private rebuildAxesGridLines(): void {
        this.clearAxesGridLines();
        const model = this.model;
        if (!model || !this.scene) {
            return;
        }
        const raw = boundingBoxFromPositions(this.scenePositions());
        if (!raw) {
            return;
        }
        const diagonal = Math.hypot(raw.max[0] - raw.min[0], raw.max[1] - raw.min[1], raw.max[2] - raw.min[2]);
        const pad = Math.max(diagonal * 0.002, 1e-9);
        const bounds = {
            min: [raw.min[0] - pad, raw.min[1] - pad, raw.min[2] - pad] as [number, number, number],
            max: [raw.max[0] + pad, raw.max[1] + pad, raw.max[2] + pad] as [number, number, number]
        };
        this.axesGridModel = buildAxesGrid({ bounds, ticks: 5, titles: { X: 'X', Y: 'Y', Z: 'Z' } });
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(this.axesGridModel.lines, 3));
        const material = new THREE.LineBasicMaterial({
            color: 0x9aa0a6,
            transparent: true,
            opacity: 0.55,
            depthWrite: false
        });
        const lines = new THREE.LineSegments(geometry, material);
        lines.name = 'axes-grid-lines';
        lines.frustumCulled = false;
        lines.visible = this.axesGridVisible;
        this.scene.add(lines);
        this.axesGridLines = lines;
        this.updateAxesGridOverlay();
    }

    private clearAxesGridLines(): void {
        const lines = this.axesGridLines;
        if (!lines) {
            return;
        }
        lines.parent?.remove(lines);
        lines.geometry.dispose();
        (lines.material as THREE.Material).dispose();
        this.axesGridLines = undefined;
        this.axesGridModel = undefined;
    }

    /** Project the grid labels into CSS pixels for the isolated overlay host. */
    private updateAxesGridOverlay(): void {
        const model = this.axesGridModel;
        const camera = this.camera;
        const host = this.host;
        if (!this.axesGridVisible || !model || !camera || !host) {
            return;
        }
        camera.updateMatrixWorld();
        const width = Math.max(1, host.clientWidth);
        const height = Math.max(1, host.clientHeight);
        const labels = projectAxisLabels(
            model,
            {
                position: [camera.position.x, camera.position.y, camera.position.z],
                viewMatrix: camera.matrixWorldInverse.elements,
                projectionMatrix: camera.projectionMatrix.elements
            },
            { width, height }
        );
        this.axesGridOverlayRef?.set(labels, width, height);
    }

    protected renderError(): React.ReactNode {
        return (
            <div className="openmc-output-viewer-status error">
                <i className={codicon('error')}></i>
                <span>{this.error}</span>
                {this.fileUri && (
                    <button className="theia-button secondary" onClick={() => this.fileUri && this.setVtkFile(this.fileUri)}>
                        <i className={codicon('refresh')}></i>
                        Retry
                    </button>
                )}
            </div>
        );
    }

    // ------------------------------------------------------------------
    // three.js scene (built once per dataset; recolor rewrites colors only)
    // ------------------------------------------------------------------

    protected onAfterAttach(msg: Message): void {
        super.onAfterAttach(msg);
        this.ensureRenderer();
        this.ensureCameraLinkSubscription();
        this.ensureComparisonRangeSubscription();
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
        this.dropCameraLinkSubscription();
        this.dropComparisonRangeSubscription();
        this.teardownRenderer();
        super.onBeforeDetach(msg);
    }

    override dispose(): void {
        this.loadToken++;
        // Invalidate any in-flight line-profile run (same guard pattern as loads).
        this.probeProfileToken++;
        this.clearProbeMarkers();
        this.dropCameraLinkSubscription();
        this.dropComparisonRangeSubscription();
        this.comparisonView = undefined;
        this.comparisonUnion = undefined;
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
        if (!this.host || !this.isAttached) {
            return;
        }
        if (this.renderer) {
            // React may replace the host div between renders (spinner swaps
            // the whole subtree); the renderer's canvas went down with the
            // old node, so re-attach it instead of stranding an empty view.
            if (this.renderer.domElement.parentElement !== this.host) {
                this.host.appendChild(this.renderer.domElement);
                this.resizeRenderer();
                this.renderScene();
            }
            return;
        }
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
        this.renderer.domElement.style.width = '100%';
        this.renderer.domElement.style.height = '100%';
        this.renderer.domElement.style.display = 'block';
        // Focusable canvas: a click focuses it, so the window-capture Escape
        // handler (measure cancel / popover dismiss) sees key events targeted
        // inside this widget — plain canvas clicks otherwise leave focus on
        // <body> and Escape dead-ends.
        this.renderer.domElement.tabIndex = 0;
        this.renderer.domElement.addEventListener('pointerdown', () => this.renderer?.domElement.focus());
        this.renderer.localClippingEnabled = true;
        this.host.appendChild(this.renderer.domElement);
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(this.resolveBackground());
        // Lit scene (same intensities as the DAGMC viewer): Lambert surfaces
        // shade with depth instead of rendering flat gray.
        this.scene.add(new THREE.AmbientLight(0xffffff, 0.9));
        const directional = new THREE.DirectionalLight(0xffffff, 1.2);
        directional.position.set(1, 2, 3);
        this.scene.add(directional);
        this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1e9);
        this.attachOrbitControls();
        this.attachContextMenu(this.renderer.domElement);
        this.renderer.domElement.addEventListener('click', this.onMeasureClick);
        this.resizeObserver = new ResizeObserver(() => this.resizeRenderer());
        if (this.host) {
            this.resizeObserver.observe(this.host);
        }
        this.resizeRenderer();
        if (this.model) {
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
        this.clearAxesGridLines();
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
        this.updateAxesGridOverlay();
    }

    /** Re-project the cube axes for the current camera (direct DOM writes, never React state). */
    private updateGizmo(): void {
        const gizmo = this.gizmo;
        const camera = this.camera;
        if (!gizmo || !camera || !this.model) {
            return;
        }
        const quaternion = camera.quaternion;
        gizmo.update({ quaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w] });
    }

    /** Rebuild the data group from the current model (new dataset only). */
    private buildScene(): void {
        const model = this.model;
        if (!model || !this.scene || !this.camera) {
            return;
        }
        if (this.dataGroup) {
            this.scene.remove(this.dataGroup);
            this.disposeObject(this.dataGroup);
            this.dataGroup = undefined;
        }
        // A fresh dataset drops the glyph mesh with the group (the field
        // must not dangle at the disposed mesh) and its cell map.
        this.glyphMesh = undefined;
        this.glyphCellCache = undefined;
        this.clipCapGroup = undefined;
        this.clipCapKey = undefined;
        this.findDataSelection = undefined;
        this.findDataGroup = undefined;
        // Probe history and line profiles belong to the previous dataset:
        // clear them (and their world markers) and bump the token so an
        // in-flight profile cannot land.
        this.probePicking = false;
        this.probeSamples = [];
        this.clearProbeMarkers();
        this.probeProfileRunning = false;
        this.probeProfileError = undefined;
        this.probeProfileResult = undefined;
        this.probeProfileToken++;
        // Rebuild clears the measure session (viewport state, never document
        // state); the label hides on the next repaint via updateMeasureLabel.
        this.measure = resetMeasureState();
        this.clearMeasureSceneObjects();
        this.measureMarkerSize = this.measurePickTolerance();
        // A fresh dataset drops a stale source layer (callers re-layer it
        // explicitly, DAGMC manifest parity).
        this.clearTallySource();
        this.dataGroup = new THREE.Group();
        this.voxelLayout = undefined;
        if (model.triangles && model.triangles.length > 0) {
            // Surface datasets render filled triangles (lit, DoubleSide for
            // open shells); outlines/points come from the shading mode.
            // NOTE: never stride the triangle list itself — dropping whole
            // triangles punches holes (half of every quad). Density is
            // capped at the source (slice writer decimates its grid).
            const positions = this.triangleVertexPositions(model);
            const mesh = this.buildTriangleMesh(positions);
            this.dataGroup.add(mesh);
            this.rebuildEdgeOverlays(this.dataGroup, mesh.geometry);
            this.dataGroup.add(this.buildTrianglePoints(positions));
        } else if (model.segments) {
            // Line datasets also carry a point cloud over the same vertices
            // (shared position buffer, zero-copy) so `points` shading mode has
            // something to show; visibility picks one representation.
            const positions = this.lineVertexPositions(model);
            this.dataGroup.add(this.buildLineSegments(positions));
            this.dataGroup.add(this.buildLinePoints(positions));
        } else if (model.gridAxes && model.gridDimensions) {
            // Axis-aligned grids render instanced voxel blocks (uniformly
            // thinned past the budget); the point cloud stays for `points`
            // shading mode. Curvilinear grids (no axes) keep clouds only.
            const voxels = this.buildModelVoxelMesh(model);
            this.voxelLayout = voxels.layout;
            this.dataGroup.add(voxels.mesh);
            const points = this.buildPoints(model);
            points.geometry.userData = { ...(points.geometry.userData ?? {}), role: 'grid-points' };
            this.dataGroup.add(points);
        } else {
            this.voxelLayout = undefined;
            this.dataGroup.add(this.buildPoints(model));
        }
        this.dataGroup.add(this.createUnderlayGroup());
        if (model.family !== 'polydata') {
            const box = new THREE.Box3().setFromBufferAttribute(new THREE.BufferAttribute(this.decimatedPositions(model), 3));
            this.dataGroup.add(new THREE.Box3Helper(box, 0x888888));
        }
        this.scene.add(this.dataGroup);
        // Warp rewrites the fresh buffers before framing, so fit and the
        // following recolor both see the deformed scene (same funnel as
        // shading: every rebuild re-applies warp). Glyphs refresh after the
        // rewrite so cones sit on the warped positions.
        this.rewriteWarpPositions();
        this.refreshGlyphs();
        this.fitView();
        this.recolor();
        this.rebuildAxesGridLines();
    }

    /**
     * Optional scene underlay (e.g. ghosted CSG boxes behind tally voxels):
     * subclasses return fresh objects per call and the base owns them once
     * added (deep-disposed on rebuild, clipped with the dataset). The
     * objects nest in a named holder group so the flat recolor / material /
     * shading passes (direct children only) never restyle underlay content.
     */
    protected buildUnderlayObjects(): THREE.Object3D[] {
        return [];
    }

    /** Fresh holder filled through the subclass hook (empty by default). */
    private createUnderlayGroup(): THREE.Group {
        const holder = new THREE.Group();
        holder.name = UNDERLAY_GROUP_NAME;
        for (const object of this.buildUnderlayObjects()) {
            holder.add(object);
        }
        return holder;
    }

    /**
     * Rebuild only the underlay holder (new cells, theme switch): dataset
     * meshes are untouched, clip re-applies, and the canvas repaints.
     */
    protected rebuildUnderlay(): void {
        if (!this.scene || !this.dataGroup) {
            return;
        }
        const previous = this.dataGroup.getObjectByName(UNDERLAY_GROUP_NAME);
        if (previous) {
            this.dataGroup.remove(previous);
            this.disposeObject(previous);
        }
        this.dataGroup.add(this.createUnderlayGroup());
        this.applyClip();
        this.renderScene();
    }

    /** Deep-dispose a detached subtree (geometries + materials + instanced buffers). */
    private disposeObject(root: THREE.Object3D): void {
        root.traverse((child) => {
            if (child instanceof THREE.Points || child instanceof THREE.LineSegments || child instanceof THREE.Mesh) {
                child.geometry.dispose();
                (child.material as THREE.Material).dispose();
                if (child instanceof THREE.InstancedMesh) {
                    child.dispose();
                }
            }
        });
    }

    /** Expanded per-corner positions for triangle datasets (non-indexed soup; `source` is warped when warp is active). */
    private triangleVertexPositions(model: NativeVtkModel, source: ArrayLike<number> = model.positions): Float32Array {
        const triangles = model.triangles ?? new Uint32Array(0);
        const positions = new Float32Array(triangles.length * 3);
        for (let i = 0; i < triangles.length; i++) {
            const point = triangles[i] * 3;
            positions[i * 3] = source[point] ?? Number.NaN;
            positions[i * 3 + 1] = source[point + 1] ?? Number.NaN;
            positions[i * 3 + 2] = source[point + 2] ?? Number.NaN;
        }
        return positions;
    }

    /** Filled surface mesh (lit vertex colors; DoubleSide for open shells). */
    private buildTriangleMesh(positions: Float32Array): THREE.Mesh {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(positions.length), 3));
        // Non-indexed corner soup: per-corner normals give flat facet shading.
        geometry.computeVertexNormals();
        geometry.userData = { role: 'mesh' };
        const material = new THREE.MeshLambertMaterial({
            vertexColors: true,
            transparent: true,
            opacity: this.opacity,
            side: THREE.DoubleSide
        });
        return new THREE.Mesh(geometry, material);
    }

    /** Dark edge overlay for `edges`/`feature-edges` shading, derived from the current mesh geometry. */
    private buildEdgeOverlay(meshGeometry: THREE.BufferGeometry, role: ShadingEdgeRole): THREE.LineSegments {
        const geometry =
            role === 'feature-edges'
                ? new THREE.EdgesGeometry(meshGeometry, FEATURE_EDGE_ANGLE_DEGREES)
                : new THREE.EdgesGeometry(meshGeometry);
        geometry.userData = { role };
        const material = new THREE.LineBasicMaterial({
            color: 0x1a1a1a,
            transparent: true,
            opacity: this.opacity,
            linewidth: this.lineWidth
        });
        const lines = new THREE.LineSegments(geometry, material);
        lines.visible = this.shading === role;
        return lines;
    }

    /**
     * Rebuild both surface edge overlays from the current mesh geometry:
     * `edges` keeps every triangle edge, `feature-edges` keeps only edges
     * above the dihedral threshold. Shared by scene build and warp/threshold
     * rewrites so the two overlays never drift apart.
     */
    private rebuildEdgeOverlays(group: THREE.Group, meshGeometry: THREE.BufferGeometry): void {
        const previous = group.children.filter(
            (child): child is THREE.LineSegments =>
                child instanceof THREE.LineSegments && isShadingEdgeRole(child.geometry.userData?.['role'])
        );
        for (const overlay of previous) {
            group.remove(overlay);
            overlay.geometry.dispose();
            (overlay.material as THREE.Material).dispose();
        }
        group.add(this.buildEdgeOverlay(meshGeometry, 'edges'));
        group.add(this.buildEdgeOverlay(meshGeometry, 'feature-edges'));
    }

    /** Corner points over triangle data (shares the corner buffer); shown in `points` mode. */
    private buildTrianglePoints(positions: Float32Array): THREE.Points {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(positions.length), 3));
        geometry.userData = { role: 'mesh-points' };
        const material = new THREE.PointsMaterial({
            size: this.pointSize,
            vertexColors: true,
            transparent: true,
            opacity: this.opacity,
            sizeAttenuation: false,
            depthWrite: false,
            map: getPointSpriteTexture() ?? null
        });
        return new THREE.Points(geometry, material);
    }

    /** Expanded per-vertex positions for line-segment datasets (`source` is warped when warp is active). */
    private lineVertexPositions(model: NativeVtkModel, source: ArrayLike<number> = model.positions): Float32Array {
        const segments = model.segments ?? new Uint32Array(0);
        const positions = new Float32Array(segments.length * 3);
        for (let i = 0; i < segments.length; i++) {
            const point = segments[i] * 3;
            positions[i * 3] = source[point];
            positions[i * 3 + 1] = source[point + 1];
            positions[i * 3 + 2] = source[point + 2];
        }
        return positions;
    }

    private buildLineSegments(positions: Float32Array): THREE.LineSegments {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(positions.length), 3));
        const material = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: this.opacity });
        return new THREE.LineSegments(geometry, material);
    }

    /** Point cloud over line vertices (shares the segment position buffer); shown in `points` mode. */
    private buildLinePoints(positions: Float32Array): THREE.Points {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(positions.length), 3));
        geometry.userData = { role: 'line-points' };
        const material = new THREE.PointsMaterial({
            size: this.pointSize,
            vertexColors: true,
            transparent: true,
            opacity: this.opacity,
            sizeAttenuation: false,
            depthWrite: false,
            map: getPointSpriteTexture() ?? null
        });
        return new THREE.Points(geometry, material);
    }

    /**
     * Instanced voxel blocks for axis-aligned grids (uniformly thinned past
     * the voxel budget); the grid-point cloud covers `points` shading mode.
     */
    private buildModelVoxelMesh(model: NativeVtkModel): { mesh: THREE.InstancedMesh; layout: VoxelInstanceLayout } {
        const dims = model.gridDimensions ?? [0, 0, 0];
        const axes = model.gridAxes ?? [new Float64Array(0), new Float64Array(0), new Float64Array(0)];
        const layout = voxelInstanceLayout(dims, axes);
        const mesh = buildVoxelMesh(layout, this.opacity);
        return { mesh, layout };
    }

    private buildPoints(model: NativeVtkModel): THREE.Points {
        const positions = this.decimatedPositions(model);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(positions.length), 3));
        const material = new THREE.PointsMaterial({
            size: this.pointSize,
            vertexColors: true,
            transparent: true,
            opacity: this.opacity,
            sizeAttenuation: false,
            depthWrite: false,
            map: getPointSpriteTexture() ?? null
        });
        return new THREE.Points(geometry, material);
    }

    /** Evenly decimated positions for point clouds and grid centers (`source` is warped when warp is active). */
    private decimatedPositions(model: NativeVtkModel, source: ArrayLike<number> = model.positions): Float32Array {
        const count = source.length / 3;
        const stride = strideForBudget(count);
        if (stride <= 1) {
            return source instanceof Float32Array ? source : Float32Array.from(source);
        }
        const kept = Math.ceil(count / stride);
        const out = new Float32Array(kept * 3);
        for (let i = 0; i < kept; i++) {
            out[i * 3] = source[i * stride * 3];
            out[i * 3 + 1] = source[i * stride * 3 + 1];
            out[i * 3 + 2] = source[i * stride * 3 + 2];
        }
        return out;
    }

    /**
     * Build the effective scalar mapping for one array (shared by recolor and
     * the legend): colormap definition, effective range (auto data range or
     * the custom user range), log scale (only when strictly positive),
     * invert, and component.
     */
    private scalarMappingFor(array: NativeVtkDataArray): ScalarMapping | undefined {
        const definition = getColormap(this.colormap) ?? getColormap(DEFAULT_COLORMAP);
        if (!definition) {
            return undefined;
        }
        const range = resolveEffectiveRange(this.rangeMode, array.range, this.customRange);
        return {
            definition,
            range,
            logScale: this.logScale && logScaleAvailable(range),
            invert: this.invert,
            component: this.component
        };
    }

    /**
     * Instant recolor: rewrite vertex colors from the current color-by array
     * and scalar mapping. No reload, no server restart — the random-ray
     * restart hack is structurally impossible on this path.
     */
    private recolor(): void {
        const model = this.model;
        if (!model || !this.dataGroup) {
            return;
        }
        // Keep the smooth volume in step with the new mapping (no-op
        // without a volume grid); the lookup refreshes even when only the
        // range or colormap changed. The source layer repaints from its own
        // energy domain right after (its colors never enter the paint
        // passes below).
        this.refreshVolumeSmooth();
        this.refreshTallySourceColors();
        this.note = '';
        const selection = parseColorBy(this.colorBy);
        const solid = new THREE.Color(this.solidColor);
        const paint = (geometry: THREE.BufferGeometry, colorAt: (vertex: number) => [number, number, number]): void => {
            // Box3Helper (grid bounds) and the edges overlay carry no color attribute — leave them.
            // The source layer paints itself from its own energy domain — leave it too.
            // Glyph cones carry per-instance colors (no color attribute) — the glyph refresh paints them.
            if ((geometry.userData?.['role'] as string | undefined) === 'tally-source') {
                return;
            }
            if ((geometry.userData?.['role'] as string | undefined) === 'glyphs') {
                return;
            }
            const colors = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
            if (!colors) {
                return;
            }
            const count = geometry.getAttribute('position').count;
            for (let i = 0; i < count; i++) {
                const [r, g, b] = colorAt(i);
                colors.setXYZ(i, r, g, b);
            }
            colors.needsUpdate = true;
        };
        const paintAllSolid = (): void => {
            const solidAt = (): [number, number, number] => [solid.r, solid.g, solid.b];
            const thresholdHidden = this.thresholdHidesVoxelInstance();
            this.dataGroup?.children.forEach((child) => {
                if (child instanceof THREE.InstancedMesh && this.voxelLayout) {
                    updateVoxelInstances(child, this.voxelLayout, solidAt, thresholdHidden);
                } else if (child instanceof THREE.Points || child instanceof THREE.LineSegments || child instanceof THREE.Mesh) {
                    paint(child.geometry, solidAt);
                }
            });
        };
        const array = selection && selection.kind !== 'solid' ? this.findArray(selection.kind, selection.name) : undefined;
        if (!array) {
            if (selection && selection.kind !== 'solid') {
                this.note = `'${this.colorBy}' is not in this file — showing Solid Color`;
            }
            paintAllSolid();
            this.refreshView();
            return;
        }
        const mapping = this.scalarMappingFor(array);
        if (!mapping) {
            paintAllSolid();
            this.refreshView();
            return;
        }
        // Non-finite values (no preset nanColor) paint the solid color, matching the pre-LUT behavior.
        const mapAt = (value: number): [number, number, number] => {
            const mapped = mapScalar(value, mapping);
            return mapped ? [mapped[0], mapped[1], mapped[2]] : [solid.r, solid.g, solid.b];
        };
        // Bivariate (mean + relative error): one weight per tuple drives the
        // RGB blend toward the mask color. Vertex/instance colors have no
        // alpha channel, so the opacity/noise channels resolve to the same
        // desaturate blend on surfaces and voxel blocks; the smooth raycast
        // volume and slice preview stay mean-only (documented in the panel).
        const companion = this.bivariateEnabled ? this.bivariateCompanion(array) : undefined;
        const bivariateOptions = this.bivariateOptions;
        const tupleCount = Math.floor(array.values.length / Math.max(1, array.components));
        const uncertaintyAt = (source: NativeVtkDataArray | undefined, tuple: number): number => {
            if (!source || tuple < 0 || tuple >= tupleCount) {
                return Number.NaN;
            }
            const components = Math.max(1, source.components);
            const component = Math.min(components - 1, Math.max(0, mapping.component));
            return source.values[tuple * components + component];
        };
        const weightAt = (tuple: number): number => {
            if (!companion) {
                return 1;
            }
            const relErr = companion.relErr
                ? uncertaintyAt(companion.relErr, tuple)
                : relativeError(tupleScalar(array.values, array.components, tuple, mapping.component), uncertaintyAt(companion.std, tuple));
            return bivariateWeight(relErr, bivariateOptions);
        };
        const mapTuple = (tuple: number): [number, number, number] => {
            const mean = mapAt(tupleScalar(array.values, array.components, tuple, mapping.component));
            if (!companion || tuple < 0 || tuple >= tupleCount) {
                return mean;
            }
            const [r, g, b] = bivariateRgba(mean, weightAt(tuple), bivariateOptions);
            return [r, g, b];
        };
        this.dataGroup.children.forEach((child) => {
            if (child instanceof THREE.LineSegments) {
                const segments = model.segments ?? new Uint32Array(0);
                const tupleOfVertex = this.lineTupleIndex(model, array, segments);
                paint(child.geometry, (vertex) => mapTuple(tupleOfVertex(vertex)));
            } else if (child instanceof THREE.InstancedMesh && this.voxelLayout) {
                // Voxel blocks carry per-instance colors (no color attribute);
                // raw-zero cells collapse so void never washes out geometry.
                const layout = this.voxelLayout;
                const thresholdHidden = this.thresholdHidesVoxelInstance();
                const tupleOfInstance = (instance: number): number => {
                    if (array.association !== 'cell') {
                        return -1;
                    }
                    const tuple = layout.cells[instance] ?? -1;
                    return tuple >= 0 && tuple < tupleCount ? tuple : -1;
                };
                const isEmpty = (instance: number): boolean => {
                    if (thresholdHidden(instance)) {
                        return true;
                    }
                    const tuple = tupleOfInstance(instance);
                    return tuple >= 0 && array.values[tuple] === 0;
                };
                updateVoxelInstances(child, layout, (instance) => mapTuple(tupleOfInstance(instance)), isEmpty);
            } else if (child instanceof THREE.Mesh) {
                const triangles = model.triangles ?? new Uint32Array(0);
                const tupleOfVertex = this.meshTupleIndex(model, array, triangles);
                paint(child.geometry, (vertex) => mapTuple(tupleOfVertex(vertex)));
            } else if (child instanceof THREE.Points) {
                const role = child.geometry.userData?.['role'];
                if (role === 'mesh-points' && model.triangles) {
                    const tupleOfVertex = this.meshTupleIndex(model, array, model.triangles);
                    paint(child.geometry, (vertex) => mapTuple(tupleOfVertex(vertex)));
                } else if (role === 'line-points' && model.segments) {
                    const segments = model.segments;
                    const tupleOfVertex = this.lineTupleIndex(model, array, segments);
                    paint(child.geometry, (vertex) => mapTuple(tupleOfVertex(vertex)));
                } else {
                    const tupleOfVertex = this.pointTupleIndex(model, array);
                    paint(child.geometry, (vertex) => mapTuple(tupleOfVertex(vertex)));
                }
            }
        });
        this.refreshView();
    }

    /** Cell/point tuple index for each line-segment vertex. */
    private lineTupleIndex(model: NativeVtkModel, array: NativeVtkDataArray, segments: Uint32Array): (vertex: number) => number {
        if (array.association === 'point') {
            return (vertex) => segments[vertex];
        }
        const cells = model.segmentCells;
        if (cells && cells.length * 2 === segments.length) {
            return (vertex) => cells[Math.floor(vertex / 2)];
        }
        return () => -1;
    }

    /** Cell/point tuple index for each triangle corner (non-indexed soup: corner v of triangle floor(v/3)). */
    private meshTupleIndex(model: NativeVtkModel, array: NativeVtkDataArray, triangles: Uint32Array): (vertex: number) => number {
        if (array.association === 'point') {
            return (vertex) => triangles[vertex] ?? -1;
        }
        const cells = model.triangleCells;
        if (cells && cells.length * 3 === triangles.length) {
            return (vertex) => cells[Math.floor(vertex / 3)];
        }
        return () => -1;
    }

    /** Tuple index for each rendered point (decimation-aware for clouds/grids). */
    private pointTupleIndex(model: NativeVtkModel, array: NativeVtkDataArray): (vertex: number) => number {
        if (model.segments) {
            // Should not happen (lines take the segment path), but stay total.
            return () => -1;
        }
        if (array.association === 'cell' && model.family === 'polydata' && model.vertices) {
            const verts = model.vertices;
            if (array.values.length / Math.max(1, array.components) >= verts.length) {
                const stride = strideForBudget(model.positions.length / 3);
                return (vertex) => vertex * stride;
            }
            return () => -1;
        }
        if (array.association === 'point' && model.family !== 'polydata') {
            return () => -1;
        }
        const stride = strideForBudget(model.positions.length / 3);
        return (vertex) => vertex * stride;
    }

    private syncMaterialProps(): void {
        const flags = resolveViewerShadingFlags(this.shading, this.opacity);
        this.dataGroup?.children.forEach((child) => {
            // Box3Helper (grid bounds) carries no color attribute — leave it alone.
            if (child instanceof THREE.Box3Helper) {
                return;
            }
            // Find Data highlights own their material (orange, always-on-top).
            if ((child as THREE.Object3D).userData?.['role'] === 'find-data-selection') {
                return;
            }
            if (child instanceof THREE.InstancedMesh) {
                const material = child.material as THREE.MeshLambertMaterial;
                material.opacity = flags.opacity;
                material.transparent = flags.transparent;
                // Ghosted voxels must not depth-reject their interior:
                // without this the inside stays invisible behind
                // translucent fronts (unsorted blending stays approximate).
                material.depthWrite = !flags.transparent;
                material.wireframe = flags.wireframe;
                material.needsUpdate = true;
            } else if (child instanceof THREE.Points) {
                const material = child.material as THREE.PointsMaterial;
                material.size = this.pointSize;
                material.opacity = flags.opacity;
                material.transparent = flags.transparent;
                material.needsUpdate = true;
            } else if (child instanceof THREE.LineSegments) {
                const material = child.material as THREE.LineBasicMaterial;
                material.opacity = flags.opacity;
                material.transparent = flags.transparent;
                material.depthWrite = flags.depthWrite;
                material.linewidth = this.lineWidth;
                material.needsUpdate = true;
            } else if (child instanceof THREE.Mesh) {
                // The smooth raycast mesh owns its appearance (RGBA lookup +
                // custom shader): opacity/wireframe live there, not in
                // built-in material flags.
                if ((child as THREE.Mesh).userData?.['tallyVolumeSmooth'] === true) {
                    return;
                }
                // Lambert supports wireframe/opacity/depthWrite; emissive stays untouched.
                const material = child.material as THREE.MeshLambertMaterial;
                material.opacity = flags.opacity;
                material.transparent = flags.transparent;
                // Ghosted surfaces must not write depth: depth ties across
                // nested DoubleSide shells (plus imprint-coincident faces)
                // flip winners per frame and blink while orbiting.
                material.depthWrite = !flags.transparent;
                material.wireframe = flags.wireframe;
                material.needsUpdate = true;
            }
        });
        this.clipCapGroup?.children.forEach((cap) => {
            if (cap instanceof THREE.Mesh) {
                const material = cap.material as THREE.MeshLambertMaterial;
                material.opacity = flags.opacity;
                material.transparent = flags.transparent;
                material.wireframe = false;
                material.needsUpdate = true;
            }
        });
    }

    /** Effective canvas backdrop: the setting, else the theme editor background (the look before scene.background). */
    private resolveBackground(): string {
        if (this.background !== undefined) {
            return this.background;
        }
        const themed = getComputedStyle(document.documentElement).getPropertyValue('--theia-editor-background').trim();
        return themed.length > 0 ? themed : '#1a1a26';
    }

    /** Light display-only refresh: background/material props/visibility/clip, no vertex repaint. */
    private applyDisplayProps(): void {
        if (this.scene) {
            this.scene.background = new THREE.Color(this.resolveBackground());
        }
        this.syncMaterialProps();
        this.applyShadingVisibility();
        this.applyClip();
        this.refreshVolumeSmooth();
        this.renderScene();
    }

    /** Toggle volume/box/line/point visibility for shading modes and the tally-volume rows. */
    private applyShadingVisibility(): void {
        if (!this.dataGroup) {
            return;
        }
        const flags = resolveViewerShadingFlags(this.shading, this.opacity);
        const smoothActive = this.isVolumeSmoothActive();
        this.dataGroup.children.forEach((child) => {
            if (child instanceof THREE.Box3Helper) {
                child.visible = true;
            } else if (child instanceof THREE.Points) {
                const role = child.geometry.userData?.['role'];
                if (role === 'grid-points') {
                    child.visible = this.volumeVisible && flags.pointsOnly;
                } else {
                    child.visible = role === 'line-points' || role === 'mesh-points' ? flags.pointsOnly : true;
                }
            } else if (child instanceof THREE.LineSegments) {
                const role = child.geometry.userData?.['role'];
                child.visible = isShadingEdgeRole(role) ? this.shading === role && !flags.pointsOnly : !flags.pointsOnly;
            } else if (child instanceof THREE.Mesh) {
                if (child.userData?.['role'] === 'clip-cap') {
                    child.visible = this.clipCaps && anyClipEnabled(this.clip) && !flags.pointsOnly && this.shading !== 'wireframe';
                } else if ((child as THREE.Mesh).userData?.['tallyVolumeSmooth'] === true) {
                    child.visible = this.volumeVisible && this.volumeMode === 'smooth' && !flags.pointsOnly;
                } else if (child instanceof THREE.InstancedMesh && this.voxelLayout) {
                    child.visible = this.volumeVisible && !smoothActive && !flags.pointsOnly;
                } else {
                    child.visible = !flags.pointsOnly;
                }
            }
        });
    }

    /** Apply the viewer-core per-axis clip state to every data material (three.js native clipping). */
    private applyClip(): void {
        if (!this.dataGroup) {
            return;
        }
        const planes = this.toThreePlanes();
        // Traverse (not direct children): the named underlay holder nests
        // ghost meshes one level down and clip must cut those too. The
        // smooth raycast material ignores plane chunks (no-op there); its
        // CPU box-section follows through applyVolumeClipBox.
        this.dataGroup.traverse((child) => {
            if (child instanceof THREE.Points || child instanceof THREE.LineSegments || child instanceof THREE.Mesh) {
                (child.material as THREE.Material).clippingPlanes = planes;
            }
        });
        this.rebuildClipCaps(planes);
        this.applyVolumeClipBox();
    }

    /** Remove the current cap meshes (clip/state/dataset change). */
    private clearClipCaps(): void {
        this.clipCapKey = undefined;
        const group = this.clipCapGroup;
        if (!group) {
            return;
        }
        group.parent?.remove(group);
        this.disposeObject(group);
        this.clipCapGroup = undefined;
    }

    /**
     * Rebuild solid caps for every enabled clip plane from the unclipped
     * triangle soup. Caps use the solid color and follow the same opacity;
     * other enabled planes clip them at box-section edges. Open/non-manifold
     * soups produce no cap (the hollow cut remains).
     */
    private rebuildClipCaps(planes: readonly THREE.Plane[]): void {
        const model = this.model;
        const key =
            this.clipCaps && model?.triangles
                ? `${JSON.stringify(this.clip)}:${model.positions.length}:${model.triangles.length}:${this.warpEnabled}:${this.warpEffectiveScale()}:${this.colorBy}:${this.solidColor}`
                : undefined;
        if (key !== undefined && this.clipCapGroup && this.clipCapKey === key) {
            return;
        }
        this.clearClipCaps();
        if (
            key === undefined ||
            !this.clipCaps ||
            !this.dataGroup ||
            !model?.triangles ||
            model.triangles.length === 0 ||
            planes.length === 0
        ) {
            return;
        }
        const positions = this.scenePositions();
        if (positions.length === 0) {
            return;
        }
        const group = new THREE.Group();
        group.name = 'clip-caps';
        for (const plane of planes) {
            const cap = buildClipCap(
                { positions, triangles: model.triangles },
                [plane.normal.x, plane.normal.y, plane.normal.z],
                plane.constant
            );
            if (!cap || cap.length === 0) {
                continue;
            }
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(cap, 3));
            geometry.computeVertexNormals();
            const material = new THREE.MeshLambertMaterial({
                color: this.solidColor,
                side: THREE.DoubleSide,
                transparent: this.opacity < 1,
                opacity: this.opacity,
                clippingPlanes: [...planes],
                polygonOffset: true,
                polygonOffsetFactor: 1,
                polygonOffsetUnits: 1
            });
            const mesh = new THREE.Mesh(geometry, material);
            mesh.userData['role'] = 'clip-cap';
            group.add(mesh);
        }
        if (group.children.length === 0) {
            return;
        }
        this.dataGroup.add(group);
        this.clipCapGroup = group;
        this.clipCapKey = key;
        this.applyShadingVisibility();
    }

    private toThreePlanes(): THREE.Plane[] {
        if (!this.model) {
            return [];
        }
        // Clip follows the rendered scene (warped when warp is active).
        const bounds = boundingBoxFromPositions(this.scenePositions());
        if (!bounds) {
            return [];
        }
        return toThreePlaneParamsArray(this.clip, bounds).map(
            (params) => new THREE.Plane(new THREE.Vector3(...params.normal), params.constant)
        );
    }

    /** Re-apply material props, shading visibility, and clip, then repaint. */
    private refreshView(): void {
        this.syncMaterialProps();
        this.applyShadingVisibility();
        this.applyClip();
        this.renderScene();
    }

    private findArray(kind: 'point' | 'cell', name: string): NativeVtkDataArray | undefined {
        const list = kind === 'point' ? this.model?.pointArrays : this.model?.cellArrays;
        return list?.find((array) => array.name === name);
    }

    /**
     * Uncertainty companions for the active color-by cell array, if any.
     *
     * Detection is deliberately narrow (never guess arbitrary pairs):
     * - `<base>-mean` pairs with `<base>-rel-err`, falling back to
     *   `<base>-std` (relative error becomes `std / |mean|`).
     * - Any other `<name>` only pairs with an explicit `<name>-rel-err`;
     *   a bare `<name>-std` is not enough.
     * Companions must be cell arrays with one scalar tuple per mean tuple.
     * Returns undefined for point arrays, Solid Color, or a missing/mismatched
     * companion, which hides the Viewer Settings Uncertainty section.
     */
    private bivariateCompanion(
        array: NativeVtkDataArray | undefined
    ): { relErr?: NativeVtkDataArray; std?: NativeVtkDataArray } | undefined {
        if (!array || array.association !== 'cell' || !this.model) {
            return undefined;
        }
        const tuples = Math.floor(array.values.length / Math.max(1, array.components));
        const companion = (name: string): NativeVtkDataArray | undefined => {
            const candidate = this.model?.cellArrays.find((entry) => entry.name === name);
            if (!candidate || Math.max(1, candidate.components) !== 1) {
                return undefined;
            }
            return Math.floor(candidate.values.length / Math.max(1, candidate.components)) === tuples ? candidate : undefined;
        };
        const suffix = '-mean';
        if (array.name.length > suffix.length && array.name.endsWith(suffix)) {
            const base = array.name.slice(0, -suffix.length);
            const relErr = companion(`${base}-rel-err`);
            const std = companion(`${base}-std`);
            return relErr || std ? { relErr, std } : undefined;
        }
        const relErr = companion(`${array.name}-rel-err`);
        return relErr ? { relErr } : undefined;
    }

    private hasArray(colorBy: string): boolean {
        const selection = parseColorBy(colorBy);
        return !selection || selection.kind === 'solid' || this.findArray(selection.kind, selection.name) !== undefined;
    }

    // ------------------------------------------------------------------
    // Warp-by-vector (FEM magnified deformation): position-buffer rewrite
    // along a 3-component point array, normals recomputed. The base
    // positions are never mutated — disabling warp rewrites the same
    // buffers from `model.positions`, so no warped copy is ever stored.
    // Subclasses (tally, tracks, generic, ...) inherit the hook with no
    // overrides; voxel grids keep their layout (their positions are cell
    // centers, not displaceable nodes).
    // ------------------------------------------------------------------

    /** 3-component point arrays eligible as warp vectors (cell arrays cannot displace vertices 1:1). */
    warpOptions(): { value: string; label: string }[] {
        if (!this.model) {
            return [];
        }
        const options: { value: string; label: string }[] = [];
        for (const array of this.model.pointArrays) {
            if (array.components === 3) {
                options.push({ value: colorByValue(array), label: `Point: ${array.name}` });
            }
        }
        return options;
    }

    /** Selected warp vector array when it still exists (otherwise the first option, otherwise none). */
    private resolvedWarpArray(): string | undefined {
        const options = this.warpOptions();
        if (options.length === 0) {
            return undefined;
        }
        if (options.some((option) => option.value === this.warpArray)) {
            return this.warpArray;
        }
        return options[0].value;
    }

    /**
     * Warp vector values for the resolved array: point data, three
     * components, one tuple per mesh point. Undefined when the array is
     * missing or cannot displace the positions 1:1.
     */
    private warpVectorValues(): Float64Array | undefined {
        const model = this.model;
        const resolved = this.resolvedWarpArray();
        if (!model || resolved === undefined) {
            return undefined;
        }
        const selection = parseColorBy(resolved);
        if (!selection || selection.kind !== 'point') {
            return undefined;
        }
        const array = model.pointArrays.find((entry) => entry.name === selection.name);
        if (!array || array.components !== 3) {
            return undefined;
        }
        if (Math.floor(array.values.length / 3) !== Math.floor(model.positions.length / 3)) {
            return undefined;
        }
        return array.values;
    }

    /** 10%-of-size auto scale for the resolved warp array (0 without vectors — the degenerate guard). */
    private warpAutoScale(): number {
        if (!this.model) {
            return 0;
        }
        const vectors = this.warpVectorValues();
        if (!vectors) {
            return 0;
        }
        return autoWarpScale(this.model.positions, vectors);
    }

    /** Effective warp scale actually applied (0 when warp is off or has no vectors). */
    warpEffectiveScale(): number {
        if (!this.warpEnabled || !this.model) {
            return 0;
        }
        const vectors = this.warpVectorValues();
        if (!vectors) {
            return 0;
        }
        return resolveWarpScale(
            this.warpScaleMode,
            this.warpScale,
            autoWarpScale(this.model.positions, vectors),
            WARP_EXAGGERATION_SPEC.max
        );
    }

    /** Warped model positions, or undefined when warp is off (callers fall back to the base positions). */
    private warpedPositions(): Float32Array | undefined {
        if (!this.model || !this.warpEnabled) {
            return undefined;
        }
        const vectors = this.warpVectorValues();
        if (!vectors) {
            return undefined;
        }
        const scale = this.warpEffectiveScale();
        if (!(scale > 0)) {
            return undefined;
        }
        return applyWarp(this.model.positions, vectors, scale);
    }

    /** Positions the scene currently renders (warped when warp is active, base otherwise). */
    private scenePositions(): ArrayLike<number> {
        return this.warpedPositions() ?? this.model?.positions ?? new Float32Array(0);
    }

    /**
     * Rewrite every point-mapped position buffer from the scene positions
     * and recompute mesh normals (plus bounding spheres, so culling and the
     * measure raycast follow the warp). Runs after every build and after
     * every warp settings change — the same funnel as shading — so
     * rebuild/re-color paths re-apply warp. Voxel instances, grid-point
     * clouds, and the underlay holder keep their layout.
     */
    private rewriteWarpPositions(): void {
        const model = this.model;
        const group = this.dataGroup;
        if (!model || !group) {
            return;
        }
        const warped = this.warpedPositions();
        const positions = warped ?? model.positions;
        let warpedMesh: THREE.BufferGeometry | undefined;
        group.children.forEach((child) => {
            if (child instanceof THREE.InstancedMesh) {
                return;
            }
            if (child instanceof THREE.Mesh) {
                if ((child as THREE.Mesh).userData?.['tallyVolumeSmooth'] === true) {
                    return;
                }
                if (child.geometry.userData?.['role'] !== 'mesh') {
                    return;
                }
                const soup = this.triangleVertexPositions(model, positions);
                // Threshold collapses after warp displaces (order: positions
                // first, then hide cells), so the edges rebuild below sees
                // the hidden triangles as zero-area.
                this.collapseHiddenTriangles(soup);
                const attribute = child.geometry.getAttribute('position') as THREE.BufferAttribute;
                attribute.array.set(soup);
                attribute.needsUpdate = true;
                child.geometry.computeVertexNormals();
                child.geometry.computeBoundingSphere();
                warpedMesh = child.geometry;
            } else if (child instanceof THREE.LineSegments) {
                if (isShadingEdgeRole(child.geometry.userData?.['role'])) {
                    return;
                }
                const soup = this.lineVertexPositions(model, positions);
                this.collapseHiddenSegments(soup);
                const attribute = child.geometry.getAttribute('position') as THREE.BufferAttribute;
                attribute.array.set(soup);
                attribute.needsUpdate = true;
                child.geometry.computeBoundingSphere();
            } else if (child instanceof THREE.Points) {
                const role = child.geometry.userData?.['role'];
                if (role === 'tally-source' || role === 'grid-points') {
                    return;
                }
                const soup =
                    role === 'mesh-points' && model.triangles
                        ? this.triangleVertexPositions(model, positions)
                        : role === 'line-points' && model.segments
                          ? this.lineVertexPositions(model, positions)
                          : // Fresh copy: decimatedPositions may alias the
                            // source buffer, and the threshold collapse below
                            // writes NaN into hidden vertices in place.
                            Float32Array.from(this.decimatedPositions(model, positions));
                // Mesh/line point clouds collapse exactly like their parent
                // geometry; generic clouds drop hidden vertices to NaN (and
                // skip frustum culling while any hide, so a NaN-poisoned
                // bounding sphere can never cull the cloud).
                child.frustumCulled = !this.collapseHiddenPointSoup(role, soup);
                const attribute = child.geometry.getAttribute('position') as THREE.BufferAttribute;
                attribute.array.set(soup);
                attribute.needsUpdate = true;
                child.geometry.computeBoundingSphere();
            }
        });
        if (warpedMesh) {
            // Both edge overlays derive from the mesh geometry — rebuild them
            // from the warped corners so they track the deformation and the
            // current threshold, with no stale pre-warp lines.
            this.rebuildEdgeOverlays(group, warpedMesh);
        }
    }

    /** Rewrite warp positions, re-apply clip (bounds may have moved), and repaint. */
    private applyWarp(): void {
        this.rewriteWarpPositions();
        // Cones, Find Data highlights, and the axes grid follow deformation.
        this.refreshGlyphs();
        this.rebuildSelectionOverlay();
        this.rebuildAxesGridLines();
        this.applyClip();
        this.renderScene();
    }

    // ------------------------------------------------------------------
    // Threshold (hide cells outside the active-array window): per-cell
    // visibility over the active color-by array (parsed or a transient
    // derived field), applied in the same funnels as warp — position
    // collapse inside rewriteWarpPositions (warp displaces first, then
    // cells hide) plus voxel-instance collapse in the recolor pass — so
    // rebuild/re-color paths re-apply it with no duplicated state.
    // Grid-point clouds and the underlay holder keep their layout (warp
    // parity); the smooth raycast volume ignores the window (documented
    // limitation). The panel reads the snapshot and patches through
    // applyProps; the widget owns every value.
    // ------------------------------------------------------------------

    /** Active threshold window over the active color-by array, or undefined when off/inapplicable. */
    private activeThreshold(): { array: NativeVtkDataArray; min: number; max: number } | undefined {
        if (!this.thresholdEnabled || !this.model) {
            return undefined;
        }
        const selection = parseColorBy(this.colorBy);
        if (!selection || selection.kind === 'solid') {
            return undefined;
        }
        const array = this.findArray(selection.kind, selection.name);
        if (!array) {
            return undefined;
        }
        // No custom window follows the data range (enabling then hides
        // nothing); inverted inputs normalize on read (Range parity).
        const custom = this.thresholdCustom ? normalizeThresholdRange(this.thresholdCustom[0], this.thresholdCustom[1]) : undefined;
        const min = custom ? custom[0] : array.range[0];
        const max = custom ? custom[1] : array.range[1];
        if (!Number.isFinite(min) || !Number.isFinite(max)) {
            return undefined;
        }
        return { array, min, max };
    }

    /** Snapshot section for the active array (the panel's Threshold row reads this). */
    private thresholdSnapshotFor(array: NativeVtkDataArray): ViewerThresholdSettings {
        const active = this.activeThreshold();
        const min = active ? active.min : array.range[0];
        const max = active ? active.max : array.range[1];
        const coverage = countThresholdVisible(array.values, array.components, this.component, min, max);
        return {
            enabled: this.thresholdEnabled,
            min,
            max,
            dataMin: array.range[0],
            dataMax: array.range[1],
            visible: active ? coverage.visible : coverage.total,
            total: coverage.total
        };
    }

    /** Collapse hidden triangles in a corner soup (no-op without an active window). */
    private collapseHiddenTriangles(soup: Float32Array): void {
        const model = this.model;
        const active = this.activeThreshold();
        const triangles = model?.triangles;
        if (!model || !active || !triangles || soup.length !== triangles.length * 3) {
            return;
        }
        const { array, min, max } = active;
        const component = this.component;
        const tupleOfVertex = this.meshTupleIndex(model, array, triangles);
        collapseTriangleSoup(
            soup,
            hiddenTriangles(triangles.length / 3, tupleOfVertex, (tuple) =>
                thresholdTupleVisible(array.values, array.components, tuple, component, min, max)
            )
        );
    }

    /** Collapse hidden segments in an expanded vertex-pair soup (no-op without an active window). */
    private collapseHiddenSegments(soup: Float32Array): void {
        const model = this.model;
        const active = this.activeThreshold();
        const segments = model?.segments;
        if (!model || !active || !segments || soup.length !== segments.length * 3) {
            return;
        }
        const { array, min, max } = active;
        const component = this.component;
        const tupleOfVertex = this.lineTupleIndex(model, array, segments);
        collapseSegmentSoup(
            soup,
            hiddenSegments(segments.length / 2, tupleOfVertex, (tuple) =>
                thresholdTupleVisible(array.values, array.components, tuple, component, min, max)
            )
        );
    }

    /**
     * Collapse hidden vertices in a point soup (role-aware: mesh/line
     * clouds fold exactly like their parent geometry, generic clouds drop
     * hidden vertices to NaN). Returns true when any vertex hid, so the
     * caller can disable frustum culling while NaN poisons the bounds.
     */
    private collapseHiddenPointSoup(role: unknown, soup: Float32Array): boolean {
        const model = this.model;
        const active = this.activeThreshold();
        if (!model || !active) {
            return false;
        }
        const { array, min, max } = active;
        const component = this.component;
        const tupleVisible = (tuple: number): boolean => thresholdTupleVisible(array.values, array.components, tuple, component, min, max);
        if (role === 'mesh-points' && model.triangles && soup.length === model.triangles.length * 3) {
            collapseTriangleSoup(
                soup,
                hiddenTriangles(model.triangles.length / 3, this.meshTupleIndex(model, array, model.triangles), tupleVisible)
            );
            return false;
        }
        if (role === 'line-points' && model.segments && soup.length === model.segments.length * 3) {
            collapseSegmentSoup(
                soup,
                hiddenSegments(model.segments.length / 2, this.lineTupleIndex(model, array, model.segments), tupleVisible)
            );
            return false;
        }
        if (role === 'mesh-points' || role === 'line-points') {
            return false;
        }
        return collapsePointSoup(soup, hiddenPoints(soup.length / 3, this.pointTupleIndex(model, array), tupleVisible)) > 0;
    }

    /**
     * Extra voxel-instance hide from the threshold (identity when the
     * window cannot apply): cell arrays test their flat cell tuple; point
     * arrays never map to instances (recolor paints those tuples as
     * unmapped, so they stay visible here too).
     */
    private thresholdHidesVoxelInstance(): (instance: number) => boolean {
        const active = this.activeThreshold();
        const layout = this.voxelLayout;
        if (!active || !layout || active.array.association !== 'cell') {
            return () => false;
        }
        const { array, min, max } = active;
        const component = this.component;
        return (instance) => !thresholdTupleVisible(array.values, array.components, layout.cells[instance] ?? -1, component, min, max);
    }

    // ------------------------------------------------------------------
    // Direction glyphs (decimated cone instancing along per-point vectors):
    // one THREE.InstancedMesh over the warped scene positions, planned by
    // viewer-core/glyph-layout.ts (decimation + orientation, zero-vector
    // skip) with threshold-hidden tuples dropped. The vector source is the
    // subclass hook below — the base resolves none, so viewers without a
    // direction source (tally, weight-windows, generic, ...) show no Glyph
    // row and every method here short-circuits.
    // ------------------------------------------------------------------

    /**
     * Per-point direction vectors (xyz-packed, one tuple per model point)
     * for glyph orientation, or undefined when this viewer has no direction
     * source. Tracks override with polyline tangents; collision tracks with
     * the first 3-component point array. Positions always come from the
     * warped scene positions at refresh time (glyphs follow warp).
     */
    protected glyphVectors(): ArrayLike<number> | undefined {
        return undefined;
    }

    /** Snapshot section for the Viewer Settings Glyphs rows (undefined without vectors). */
    private glyphSnapshot(): ViewerGlyphSettings | undefined {
        const model = this.model;
        if (!model) {
            return undefined;
        }
        const vectors = this.glyphVectors();
        if (!vectors) {
            return undefined;
        }
        const total = Math.floor(model.positions.length / 3);
        let count = 0;
        for (const placement of planGlyphs(total, vectors, this.glyphDensity)) {
            if (this.glyphTupleVisible(placement.index)) {
                count++;
            }
        }
        return { enabled: this.glyphEnabled, density: this.glyphDensity, scale: this.glyphScale, count, total };
    }

    /** Whether the glyph at one model point survives the active threshold window. */
    private glyphTupleVisible(point: number): boolean {
        const active = this.activeThreshold();
        if (!active) {
            return true;
        }
        const { array, min, max } = active;
        if (array.association === 'point') {
            return thresholdTupleVisible(array.values, array.components, point, this.component, min, max);
        }
        // Cell arrays test the first incident segment's cell (the track
        // polyline form); unmapped points stay visible (the nanColor rule).
        const tuple = this.glyphCellTuple(point, array);
        if (tuple === undefined) {
            return true;
        }
        return thresholdTupleVisible(array.values, array.components, tuple, this.component, min, max);
    }

    /**
     * Data tuple coloring (and hiding) the glyph at one model point: point
     * arrays map 1:1, cell arrays resolve through the first incident
     * segment's cell (undefined when unmapped). The incident map builds once
     * per model + array (slider drags must not rebuild it per tick).
     */
    private glyphCellTuple(point: number, array: NativeVtkDataArray): number | undefined {
        const model = this.model;
        if (!model || !model.segments || !model.segmentCells) {
            return undefined;
        }
        let cache = this.glyphCellCache;
        if (!cache || cache.model !== model || cache.array !== array) {
            const count = Math.floor(model.positions.length / 3);
            const map = new Int32Array(count).fill(-1);
            const segments = model.segments;
            const cells = model.segmentCells;
            const pairCount = Math.min(Math.floor(segments.length / 2), cells.length);
            for (let s = 0; s < pairCount; s++) {
                const cell = cells[s];
                const a = segments[s * 2];
                const b = segments[s * 2 + 1];
                if (a >= 0 && a < count && map[a] === -1) {
                    map[a] = cell;
                }
                if (b >= 0 && b < count && map[b] === -1) {
                    map[b] = cell;
                }
            }
            cache = { model, array, map };
            this.glyphCellCache = cache;
        }
        const tuple = cache.map[point] ?? -1;
        return tuple >= 0 ? tuple : undefined;
    }

    /** Data tuple painted onto the glyph at one model point (cell arrays resolve like visibility). */
    private glyphColorTuple(point: number, array: NativeVtkDataArray | undefined): number {
        if (!array) {
            return -1;
        }
        if (array.association === 'point') {
            return point;
        }
        return this.glyphCellTuple(point, array) ?? -1;
    }

    /**
     * Rebuild the cone instances from the current scene positions (warped
     * when warp is active — always call after the warp rewrite in the
     * rebuild funnel, same order as the threshold collapse). Drops the mesh
     * when glyphs are off, vectorless, empty, or degenerately sized; colors
     * follow the active mapping (solid in Solid Color mode). Render-on-demand:
     * direct three.js writes plus one repaint, never React state.
     */
    private refreshGlyphs(): void {
        let removed = false;
        if (this.glyphMesh && this.dataGroup) {
            this.dataGroup.remove(this.glyphMesh);
            this.glyphMesh.geometry.dispose();
            (this.glyphMesh.material as THREE.Material).dispose();
            this.glyphMesh.dispose();
            this.glyphMesh = undefined;
            removed = true;
        }
        const model = this.model;
        if (!model || !this.dataGroup || !this.glyphEnabled) {
            if (removed) {
                this.renderScene();
            }
            return;
        }
        const vectors = this.glyphVectors();
        if (!vectors) {
            this.renderScene();
            return;
        }
        const total = Math.floor(model.positions.length / 3);
        const visible = planGlyphs(total, vectors, this.glyphDensity).filter((placement) => this.glyphTupleVisible(placement.index));
        if (visible.length === 0) {
            this.renderScene();
            return;
        }
        // Glyph layout runs on the rendered positions (warped when warp is
        // active), never the base positions — deformation moves the cones.
        const positions = this.scenePositions();
        const size = autoGlyphSize(positions) * this.glyphScale;
        if (!(size > 0)) {
            this.renderScene();
            return;
        }
        // Unit cone (apex +Y, base at the origin after the translate) scaled
        // per instance, so each cone sits on its point along its direction.
        const geometry = new THREE.ConeGeometry(0.35, 1, 12);
        geometry.translate(0, 0.5, 0);
        geometry.userData = { role: 'glyphs' };
        const material = new THREE.MeshLambertMaterial({ transparent: true, opacity: this.opacity });
        const mesh = new THREE.InstancedMesh(geometry, material, visible.length);
        const selection = parseColorBy(this.colorBy);
        const array = selection && selection.kind !== 'solid' ? this.findArray(selection.kind, selection.name) : undefined;
        const mapping = array ? this.scalarMappingFor(array) : undefined;
        const solid = new THREE.Color(this.solidColor);
        const matrix = new THREE.Matrix4();
        const quaternion = new THREE.Quaternion();
        const position = new THREE.Vector3();
        const scale = new THREE.Vector3(size, size, size);
        const color = new THREE.Color();
        visible.forEach((placement, i) => {
            position.set(positions[placement.index * 3], positions[placement.index * 3 + 1], positions[placement.index * 3 + 2]);
            quaternion.set(placement.quaternion[0], placement.quaternion[1], placement.quaternion[2], placement.quaternion[3]);
            matrix.compose(position, quaternion, scale);
            mesh.setMatrixAt(i, matrix);
            const tuple = this.glyphColorTuple(placement.index, array);
            const mapped =
                array && mapping ? mapScalar(tupleScalar(array.values, array.components, tuple, mapping.component), mapping) : undefined;
            if (mapped) {
                color.setRGB(mapped[0], mapped[1], mapped[2]);
            } else {
                color.copy(solid);
            }
            mesh.setColorAt(i, color);
        });
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) {
            mesh.instanceColor.needsUpdate = true;
        }
        // Instance transforms span the scene (the base geometry bounds do
        // not), so frustum culling must stay off — same rule as the source
        // overlay points.
        mesh.frustumCulled = false;
        this.dataGroup.add(mesh);
        this.glyphMesh = mesh;
        this.syncMaterialProps();
        this.applyShadingVisibility();
        this.applyClip();
        this.renderScene();
    }

    private describeModel(): string {
        const model = this.model;
        if (!model) {
            return this.isLoading ? this.statusMessage : 'No dataset loaded';
        }
        const warpScale = this.warpEffectiveScale();
        const warpSuffix = warpScale > 0 ? ` — warped x${Number(warpScale.toPrecision(3))}` : '';
        const threshold = this.activeThreshold();
        let thresholdSuffix = '';
        if (threshold) {
            const coverage = countThresholdVisible(
                threshold.array.values,
                threshold.array.components,
                this.component,
                threshold.min,
                threshold.max
            );
            thresholdSuffix = ` — threshold ${coverage.visible.toLocaleString()} of ${coverage.total.toLocaleString()} shown`;
        }
        const glyph = this.glyphSnapshot();
        const glyphSuffix =
            glyph && glyph.enabled && glyph.total > 0 ? ` — glyphs ${glyph.count.toLocaleString()} of ${glyph.total.toLocaleString()}` : '';
        if (model.family === 'polydata') {
            const parts: string[] = [];
            if (model.triangles) {
                parts.push(`${(model.triangles.length / 3).toLocaleString()} triangles`);
            }
            if (model.segments) {
                parts.push(`${(model.segments.length / 2).toLocaleString()} segments`);
            }
            if (model.vertices) {
                parts.push(`${model.vertices.length.toLocaleString()} points`);
            }
            if (parts.length === 0) {
                parts.push(`${model.nPoints.toLocaleString()} points`);
            }
            return `PolyData — ${parts.join(' + ')}${warpSuffix}${thresholdSuffix}${glyphSuffix}`;
        }
        const [nx, ny, nz] = model.gridDimensions ?? [0, 0, 0];
        const kind = model.family === 'rectilinear' ? 'RectilinearGrid' : 'ImageData';
        const shape = model.gridAxes ? 'voxel blocks' : 'cell-center preview';
        return `${kind} — ${model.nPoints.toLocaleString()} cells (${nx} × ${ny} × ${nz}, ${shape})${warpSuffix}${thresholdSuffix}${glyphSuffix}`;
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

    /** View-action menu: fit, screenshot, clip toggle, per-mode shading (plus subclass extras). */
    private openContextMenu(clientX: number, clientY: number): void {
        if (!this.model) {
            return;
        }
        this.contextMenuClose?.();
        this.contextMenuClose = openViewerContextMenu({ x: clientX, y: clientY }, this.buildContextMenuItems(), (id) =>
            this.handleContextMenuAction(id)
        );
    }

    /** Standard menu contents; subclasses append their own rows (e.g. the tally underlay toggle). */
    protected buildContextMenuItems(): ViewerContextMenuItem[] {
        return buildViewerContextMenuItems({ shading: this.shading, clipChecked: anyClipEnabled(this.clip) });
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
        } else {
            this.handleExtraContextMenuAction(id);
        }
        this.update();
    }

    /** Subclass menu rows not covered above (no-op here so unknown ids stay ignored). */
    protected handleExtraContextMenuAction(id: string): void {
        void id;
    }

    /**
     * Attach OrbitControls to the renderer canvas. The controls class loads
     * asynchronously (same dynamic import style as nuke-cad); a renderer
     * teardown before the import resolves disposes the stale handle. Once
     * attached, the loaded dataset is framed through the controls.
     */
    private attachOrbitControls(): void {
        const renderer = this.renderer;
        const camera = this.camera;
        if (!renderer || !camera) {
            return;
        }
        createOrbitControls(camera, renderer.domElement, { onChange: () => this.onOrbitChanged() })
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
                console.warn('[NativeVtkViewer] Failed to load orbit controls:', error);
            });
    }
}
