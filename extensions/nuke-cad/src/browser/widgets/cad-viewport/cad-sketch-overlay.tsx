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

/**
 * React overlay for interactive sketch mode inside the CAD viewport.
 *
 * In document mode it also hosts the document toolbar (new sketch, rebuild,
 * feature creation) and the feature creation dialog.
 *
 * @module nuke-cad/browser/widgets
 */

import * as React from '@theia/core/shared/react';
import { type MessageService } from '@theia/core/lib/common/message-service';
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components/tooltip';
import {
    NukeDialog,
    NukeFormRow,
    NukePanel,
    NukeSection,
    NukeToolbar,
    NukeToolbarGroup
} from 'nuke-essentials/lib/theme/browser/components';
import { SketchModeController } from '../../sketch/sketch-mode-controller';
import {
    SKETCH_TOOL_SHORTCUTS,
    type SketchSession,
    type SketchTool,
    type ConstraintKind,
    type SketchStatus
} from '../../sketch/sketch-session';
import { type DatumKind } from '../../sketch/sketch-math';
import {
    type SketchDimension,
    type DimensionKind,
    type DocumentUnits,
    type FeatureType,
    type FeatureParams,
    type FeatureDef,
    type CurvePoint,
    type FilletParams,
    type DraftParams,
    type ShellParams,
    type HoleParams,
    type BooleanParams
} from '../../../common/cad-document';
import { type TopologyRef } from '../../../common/topology-refs';
import { CadDocumentStore } from '../../document/cad-document-store';
import {
    type DragTargetFilter,
    type DraggablePanelApi,
    headerRegionTarget,
    useDraggablePanel,
    clampPanelPosition
} from './draggable-panel';
import { type DocumentTemplate } from '../../../common/document-templates';
import { validRelations, type SketchEntityType } from './constraint-relations';
import {
    validateSweepPipeDraft,
    validateLoftDraft,
    validateHelicalSweepDraft,
    loftDraftFromParams,
    helicalSweepDraftFromParams,
    helixAxisUnit,
    moveLoftSection,
    validateExtrudeDraft,
    validateRevolveDraft,
    validatePrimitiveDraft,
    type FeaturePreviewRequest,
    type HelixAxis
} from './sweep-pipe';

/** Presses on the sketch toolbar's header pick it up; the collapsed toggle doubles as a handle. */
const TOOLBAR_DRAG_TARGET: DragTargetFilter = (target) => {
    const button = target.closest('button');
    if (target.closest('.cad-sketch-toolbar-toggle-anchor') !== null) {
        return button === null || button.classList.contains('cad-sketch-toolbar-toggle');
    }
    return target.closest('.cad-sketch-toolbar-header') !== null && button === null;
};

/** Double-click/right-click resets from the same regions, header buttons included. */
const TOOLBAR_RESET_TARGET: DragTargetFilter = (target) =>
    target.closest('.cad-sketch-toolbar-toggle-anchor') !== null || target.closest('.cad-sketch-toolbar-header') !== null;

const NUKE_PANEL_HEADER_TARGET = headerRegionTarget('.nuke-panel-header');

/** The feature dialog drags by its NukeDialog header; double-click/right-click there resets. */
const NUKE_DIALOG_HEADER_TARGET = headerRegionTarget('.nuke-dialog-header');

interface CadSketchOverlayProps {
    readonly controller: SketchModeController;
    readonly documentStore: CadDocumentStore;
    readonly messageService: MessageService;
    readonly setupVisible: boolean;
    readonly featureCreationType?: FeatureType;
    readonly editFeature?: FeatureDef;
    readonly facePickMode?: 'sketchDatum' | 'externalGeometry';
    readonly dressUpPickMode?: { readonly type: FeatureType; readonly selecting: 'edge' | 'face' };
    readonly holePickMode?: boolean;
    readonly shortcutBar?: { readonly mode: 'document' | 'sketch'; readonly anchor: { readonly x: number; readonly y: number } };
    readonly sketchAutoDimension: boolean;
    readonly templates: ReadonlyArray<DocumentTemplate>;
    readonly onEnterSketch: (kind: DatumKind, offset: number) => void;
    /** Receives the full validated new-kind datum draft plus the picker offset. */
    readonly onEnterSketchDraft: (draft: DatumDraft, offset: number) => void;
    readonly onExitSketch: () => Promise<void>;
    readonly onStartFeatureCreation: (type: FeatureType) => void;
    readonly onAddFeature: (type: FeatureType, params: FeatureParams) => void;
    readonly onEditFeature?: (id: string, params: FeatureParams) => void;
    readonly onEditSketch: (sketchId: string) => void;
    readonly onExportPython?: () => void;
    readonly onNewDocument?: () => void;
    readonly onSaveDocument?: () => void;
    readonly onRebuildDocument?: () => void;
    readonly onCancelFeatureCreation: () => void;
    readonly onStartFacePick: (offset: number) => void;
    readonly onStartExternalGeometryPick: (featureId: string) => void;
    readonly onCancelFacePick: () => void;
    readonly onStartDressUpPick: (type: FeatureType, selecting: 'edge' | 'face', callback: (ref: TopologyRef) => void) => void;
    readonly onDressUpPickCancel: () => void;
    readonly onStartHolePick: (callback: (ref: TopologyRef, uv: [number, number]) => void) => void;
    readonly onHolePickCancel: () => void;
    readonly curvePickMode?: boolean;
    readonly onStartCurvePick: (callback: (curveId: string) => void) => void;
    readonly onCurvePickCancel: () => void;
    readonly onPreviewChange?: (request: FeaturePreviewRequest | undefined) => void;
    readonly measureActive?: boolean;
    readonly measureCount?: number;
    readonly measureListOpen?: boolean;
    readonly onToggleMeasure?: () => void;
    readonly onToggleMeasureList?: () => void;
    readonly onCloseShortcutBar: () => void;
}

/**
 * Display key for a sketch tool, derived from the session module's shortcut
 * registry (single source of truth — never hardcoded per tool).
 */
function keyFor(tool: SketchTool): string {
    for (const [key, mapped] of Object.entries(SKETCH_TOOL_SHORTCUTS)) {
        if (mapped === tool) {
            return key.toUpperCase();
        }
    }
    return '';
}

const TOOLS: Array<{ tool: SketchTool; label: string; icon: string; key: string }> = [
    { tool: 'select', label: 'Select', icon: 'codicon-nuke-cad-select', key: keyFor('select') },
    { tool: 'point', label: 'Point', icon: 'codicon-nuke-cad-point', key: keyFor('point') },
    { tool: 'line', label: 'Line', icon: 'codicon-nuke-cad-line', key: keyFor('line') },
    { tool: 'circle', label: 'Circle', icon: 'codicon-nuke-cad-circle', key: keyFor('circle') },
    { tool: 'arc3', label: '3-Point Arc', icon: 'codicon-nuke-cad-arc', key: keyFor('arc3') },
    { tool: 'rectangle', label: 'Rectangle', icon: 'codicon-nuke-cad-rectangle', key: keyFor('rectangle') },
    { tool: 'slot', label: 'Slot', icon: 'codicon-nuke-cad-slot', key: keyFor('slot') },
    { tool: 'trim', label: 'Trim', icon: 'codicon-nuke-cad-trim', key: keyFor('trim') },
    { tool: 'extend', label: 'Extend', icon: 'codicon-nuke-cad-extend', key: keyFor('extend') },
    { tool: 'split', label: 'Split', icon: 'codicon-nuke-cad-split', key: keyFor('split') },
    { tool: 'sketchFillet', label: 'Sketch Fillet', icon: 'codicon-nuke-cad-sketch-fillet', key: keyFor('sketchFillet') },
    { tool: 'sketchChamfer', label: 'Sketch Chamfer', icon: 'codicon-nuke-cad-sketch-chamfer', key: keyFor('sketchChamfer') },
    { tool: 'polyline', label: 'Polyline', icon: 'codicon-nuke-cad-polyline', key: keyFor('polyline') },
    { tool: 'polygon', label: 'Polygon', icon: 'codicon-nuke-cad-polygon', key: keyFor('polygon') },
    { tool: 'arcSlot', label: 'Arc Slot', icon: 'codicon-nuke-cad-arc-slot', key: keyFor('arcSlot') },
    { tool: 'ellipse', label: 'Ellipse', icon: 'codicon-nuke-cad-ellipse', key: keyFor('ellipse') },
    { tool: 'bspline', label: 'B-Spline', icon: 'codicon-nuke-cad-bspline', key: keyFor('bspline') },
    // Sketch transform gesture tools (session contract): they route through
    // controller.setTool like every other gesture tool. The ids and their
    // shortcuts are owned by the session module — keyFor reuses exactly what
    // SKETCH_TOOL_SHORTCUTS registers ('' until the session side lands them).
    { tool: 'move', label: 'Move', icon: 'codicon-nuke-cad-move', key: keyFor('move') },
    { tool: 'copy', label: 'Copy', icon: 'codicon-nuke-cad-copy', key: keyFor('copy') },
    { tool: 'rotate', label: 'Rotate', icon: 'codicon-nuke-cad-rotate', key: keyFor('rotate') },
    { tool: 'mirrorTool', label: 'Mirror', icon: 'codicon-nuke-cad-mirror', key: keyFor('mirrorTool') }
];

/** Snap-radius presets in screen pixels; M matches the session default. */
const SNAP_RADIUS_PRESETS: ReadonlyArray<{ label: string; px: number }> = [
    { label: 'S', px: 6 },
    { label: 'M', px: 12 },
    { label: 'L', px: 24 }
];

const SOLID_PRODUCERS: FeatureType[] = ['pad', 'pocket', 'revolve', 'groove', 'sweep', 'pipe', 'loft', 'helicalSweep', 'primitive'];

const CONSTRAINT_OPTIONS: Array<{ kind: ConstraintKind; label: string }> = [
    { kind: 'coincident', label: 'Coincident' },
    { kind: 'fix', label: 'Fix' },
    { kind: 'horizontal', label: 'Horizontal' },
    { kind: 'vertical', label: 'Vertical' },
    { kind: 'parallel', label: 'Parallel' },
    { kind: 'perpendicular', label: 'Perpendicular' },
    { kind: 'tangent', label: 'Tangent' },
    { kind: 'equal', label: 'Equal' },
    { kind: 'concentric', label: 'Concentric' },
    { kind: 'distance', label: 'Distance' },
    { kind: 'angle', label: 'Angle' },
    { kind: 'radius', label: 'Radius' },
    { kind: 'symmetry', label: 'Symmetry' },
    { kind: 'pointOnObject', label: 'Point on Object' }
];

const VALUE_CONSTRAINTS: ReadonlySet<ConstraintKind> = new Set(['distance', 'radius', 'angle']);

export function CadSketchOverlay(props: CadSketchOverlayProps): React.ReactElement {
    const {
        controller,
        documentStore,
        messageService,
        setupVisible,
        featureCreationType,
        editFeature,
        facePickMode,
        dressUpPickMode,
        holePickMode,
        shortcutBar,
        sketchAutoDimension,
        onEnterSketch,
        onEnterSketchDraft,
        onExitSketch,
        onStartFeatureCreation,
        onAddFeature,
        onEditFeature,
        onEditSketch,
        onExportPython,
        onNewDocument,
        onSaveDocument,
        onRebuildDocument,
        onCancelFeatureCreation,
        onStartFacePick,
        onStartExternalGeometryPick,
        onCancelFacePick,
        onStartDressUpPick,
        onDressUpPickCancel,
        onStartHolePick,
        onHolePickCancel,
        curvePickMode,
        onStartCurvePick,
        onCurvePickCancel,
        onPreviewChange,
        measureActive,
        measureCount,
        measureListOpen,
        onToggleMeasure,
        onToggleMeasureList,
        onCloseShortcutBar
    } = props;
    const [, forceUpdate] = React.useReducer((n) => n + 1, 0);

    React.useEffect(() => {
        const a = controller.onChange(forceUpdate);
        const b = documentStore.onChange(forceUpdate);
        return () => {
            a();
            b();
        };
    }, [controller, documentStore, forceUpdate]);

    React.useEffect(() => {
        controller.setAutoDimensionEnabled(sketchAutoDimension);
    }, [controller, sketchAutoDimension]);

    const active = controller.isActive;
    const tool = controller.getTool();
    const construction = controller.getConstruction();
    const status = controller.getStatus();
    const constraintInput = controller.getConstraintInput();
    const dimensions = active ? controller.getDimensions() : [];
    const dimensionLabels = active ? controller.getDimensionLabels() : [];
    const docUnits = documentStore.document?.units;
    const session = controller.getSession();
    const externalRefs = session?.getExternalRefs() ?? [];
    const sketchId = session?.getId();
    const consumingFeature = sketchId !== undefined ? findConsumingFeature(documentStore.document, sketchId) : undefined;
    const referenceResults = documentStore.getReferenceResults();
    const relevantRefs = consumingFeature !== undefined ? referenceResults.filter((r) => r.featureId === consumingFeature.id) : [];
    const externalGeometryTarget =
        documentStore.document !== undefined ? findExternalGeometryTargetFeature(documentStore.document) : undefined;

    const [value, setValue] = React.useState('');
    const [useDiameter, setUseDiameter] = React.useState(false);
    const [datumKind, setDatumKind] = React.useState<DatumKind>('XY');
    const [offset, setOffset] = React.useState('0');
    const [paramsOpen, setParamsOpen] = React.useState(false);
    const [diagnosticsOpen, setDiagnosticsOpen] = React.useState(false);
    const [editingDimension, setEditingDimension] = React.useState<SketchDimension | undefined>();
    const [editDimValue, setEditDimValue] = React.useState('');
    const [editDimDriving, setEditDimDriving] = React.useState(true);
    const [paramErrors, setParamErrors] = React.useState<Record<string, string>>({});

    // Popover placements are session state: dragged offsets survive closing and
    // reopening a panel, reset when the sketch session ends, never hit storage.
    const paramsDrag = useDraggablePanel({ canDrag: NUKE_PANEL_HEADER_TARGET, canResetFrom: NUKE_PANEL_HEADER_TARGET });
    const diagnosticsDrag = useDraggablePanel({ canDrag: NUKE_PANEL_HEADER_TARGET, canResetFrom: NUKE_PANEL_HEADER_TARGET });
    const externalRefsDrag = useDraggablePanel({ canDrag: NUKE_PANEL_HEADER_TARGET, canResetFrom: NUKE_PANEL_HEADER_TARGET });
    const shortcutsDrag = useDraggablePanel({ canDrag: NUKE_PANEL_HEADER_TARGET, canResetFrom: NUKE_PANEL_HEADER_TARGET });
    const { resetPosition: resetParamsPosition } = paramsDrag;
    const { resetPosition: resetDiagnosticsPosition } = diagnosticsDrag;
    const { resetPosition: resetExternalRefsPosition } = externalRefsDrag;
    const { resetPosition: resetShortcutsPosition } = shortcutsDrag;

    React.useEffect(() => {
        if (!active) {
            resetParamsPosition();
            resetDiagnosticsPosition();
            resetExternalRefsPosition();
            resetShortcutsPosition();
        }
    }, [active, resetParamsPosition, resetDiagnosticsPosition, resetExternalRefsPosition, resetShortcutsPosition]);

    const needsValue =
        constraintInput !== undefined &&
        VALUE_CONSTRAINTS.has(constraintInput.kind) &&
        constraintInput.targetIds.length === arityFor(constraintInput.kind);

    React.useEffect(() => {
        setValue('');
        setUseDiameter(false);
    }, [constraintInput?.kind, constraintInput?.targetIds.length]);

    React.useEffect(() => {
        if (editingDimension !== undefined) {
            setEditDimValue(editingDimension.parameter ?? String(editingDimension.value));
            setEditDimDriving(editingDimension.driving);
        }
    }, [editingDimension?.id, editingDimension?.parameter, editingDimension?.value, editingDimension?.driving]);

    const applyValue = (): void => {
        if (constraintInput === undefined) {
            return;
        }
        const num = Number(value);
        if (value.trim() !== '' && !Number.isFinite(num)) {
            return;
        }
        const effectiveValue = Number.isFinite(num) ? num : value;
        const options = constraintInput.kind === 'radius' && useDiameter ? { diameter: true } : undefined;
        void controller.applyConstraintValue(constraintInput.kind, effectiveValue, options);
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
        if (e.key === 'Enter') {
            applyValue();
        } else if (e.key === 'Escape') {
            controller.cancel();
        }
    };

    const openDimensionEdit = (dimension: SketchDimension): void => {
        setEditingDimension(dimension);
        controller.selectDimension(dimension.id);
    };

    const closeDimensionEdit = (): void => {
        setEditingDimension(undefined);
    };

    const applyDimensionEdit = async (): Promise<void> => {
        if (editingDimension === undefined || session === undefined) {
            return;
        }
        const num = Number(editDimValue);
        const isLiteral = editDimValue.trim() !== '' && Number.isFinite(num);
        const result = await session.editDimension(editingDimension.id, {
            value: isLiteral ? num : undefined,
            parameter: isLiteral ? '' : editDimValue.trim(),
            driving: editDimDriving
        });
        if (result.success) {
            setEditingDimension(undefined);
        }
    };

    const deleteDimension = async (): Promise<void> => {
        await controller.deleteSelectedDimension();
        setEditingDimension(undefined);
    };

    const addParameter = async (name: string, value: number): Promise<void> => {
        if (session === undefined) {
            return;
        }
        const result = await session.addParameter(name, value);
        setParamErrors((prev) => ({ ...prev, [name]: result.success ? '' : (result.error ?? 'Invalid parameter') }));
    };

    const removeParameter = (name: string): void => {
        if (session === undefined) {
            return;
        }
        const result = session.removeParameter(name);
        setParamErrors((prev) => ({ ...prev, [name]: result.success ? '' : (result.error ?? 'Invalid parameter') }));
    };

    const setParameter = async (name: string, value: number): Promise<void> => {
        if (session === undefined) {
            return;
        }
        const result = await session.setParameter(name, value);
        setParamErrors((prev) => ({ ...prev, [name]: result.success ? '' : (result.error ?? 'Invalid parameter') }));
    };

    const refCounts = countReferenceResults(relevantRefs);
    const snapSummary = controller.isSnapEnabled() ? `Snap: ${controller.getSnapRadiusPx()}px` : 'Snap off';
    const gestureHint =
        active && tool === 'ellipse'
            ? 'Click: center · Click: major-axis endpoint · Click: minor-radius point'
            : active && tool === 'bspline'
              ? 'Click: place poles · Double-click / Enter: finish (min 2 poles)'
              : undefined;
    const selectHint =
        active && tool === 'select' && constraintInput === undefined
            ? 'Click: select · Ctrl+Click: multi-select / relations · Q: shortcut bar · Del: delete · Esc: clear'
            : gestureHint;
    const statusText = buildStatusText(status, refCounts, snapSummary, selectHint);
    const hasDiagnostics =
        status.conflicting.length > 0 || status.redundant.length > 0 || refCounts.ambiguous > 0 || refCounts.unmatched > 0;

    const removeRedundantConstraints = async (): Promise<void> => {
        const liveSession = controller.getSession();
        if (liveSession === undefined) {
            return;
        }
        try {
            const removed = await liveSession.removeRedundantConstraints();
            if (removed === 0) {
                messageService?.warn('No redundant constraints to remove.');
            }
        } catch (error) {
            messageService?.warn(`Failed to remove redundant constraints: ${error instanceof Error ? error.message : String(error)}`);
        }
    };

    return (
        <div className="cad-sketch-overlay">
            {setupVisible && !active && (
                <DatumPicker
                    datumKind={datumKind}
                    offset={offset}
                    facePickMode={facePickMode}
                    holePickMode={holePickMode}
                    onDatumKindChange={setDatumKind}
                    onOffsetChange={setOffset}
                    onEnter={() => onEnterSketch(datumKind, Number(offset))}
                    onEnterExtendedKind={(draft) => onEnterSketchDraft(draft, Number(offset))}
                    onCancel={() => void onExitSketch()}
                    onStartFacePick={() => onStartFacePick(Number(offset))}
                    onCancelFacePick={onCancelFacePick}
                    onStartHolePick={onStartHolePick}
                    onHolePickCancel={onHolePickCancel}
                />
            )}

            {!active && documentStore.hasDocument && !setupVisible && (
                <DocumentModeToolbar
                    documentStore={documentStore}
                    onNewSketch={() => onEnterSketch('XY', 0)}
                    onExitSketch={() => void onExitSketch()}
                    onEditSketch={onEditSketch}
                    onStartFeatureCreation={onStartFeatureCreation}
                    onExportPython={onExportPython}
                    onNewDocument={onNewDocument}
                    onSaveDocument={onSaveDocument}
                    onRebuildDocument={onRebuildDocument}
                    measureActive={measureActive}
                    measureCount={measureCount}
                    measureListOpen={measureListOpen}
                    onToggleMeasure={onToggleMeasure}
                    onToggleMeasureList={onToggleMeasureList}
                />
            )}

            {featureCreationType !== undefined && !active && (
                <FeatureCreationDialog
                    type={featureCreationType}
                    editFeature={editFeature}
                    sketchId={documentStore.selection.selectedSketchId}
                    documentStore={documentStore}
                    dressUpPickMode={dressUpPickMode}
                    holePickMode={holePickMode}
                    onCancel={onCancelFeatureCreation}
                    onConfirm={(type, params) => {
                        onAddFeature(type, params);
                        onCancelFeatureCreation();
                    }}
                    onEditFeature={(id, params) => {
                        onEditFeature?.(id, params);
                        onCancelFeatureCreation();
                    }}
                    onStartDressUpPick={onStartDressUpPick}
                    onDressUpPickCancel={onDressUpPickCancel}
                    onStartHolePick={onStartHolePick}
                    onHolePickCancel={onHolePickCancel}
                    curvePickMode={curvePickMode}
                    onStartCurvePick={onStartCurvePick}
                    onCurvePickCancel={onCurvePickCancel}
                    onPreviewChange={onPreviewChange}
                />
            )}

            {curvePickMode === true && (
                <div className="cad-sketch-face-pick-banner">
                    <span className="codicon codicon-target" />
                    <span>Click a curve in the viewport to use it as the sweep path.</span>
                    <button className="theia-button secondary" onClick={onCurvePickCancel}>
                        Cancel
                    </button>
                </div>
            )}

            {shortcutBar !== undefined && (
                <ContextShortcutBar
                    mode={shortcutBar.mode}
                    anchor={shortcutBar.anchor}
                    documentStore={documentStore}
                    controller={controller}
                    onNewDocument={onNewDocument}
                    onNewSketch={() => onEnterSketch('XY', 0)}
                    onStartFeatureCreation={onStartFeatureCreation}
                    onClose={onCloseShortcutBar}
                />
            )}

            {active && (
                <>
                    <div className="cad-sketch-finish-anchor">
                        <Tooltip content="Exit sketch mode and merge the sketch into the document" position="bottom">
                            <button className="theia-button cad-sketch-finish-button" onClick={() => void onExitSketch()}>
                                <span className="codicon codicon-check" />
                                Finish Sketch
                            </button>
                        </Tooltip>
                    </div>

                    <SketchToolbar
                        controller={controller}
                        tool={tool}
                        construction={construction}
                        paramsOpen={paramsOpen}
                        setParamsOpen={setParamsOpen}
                        shortcutsDrag={shortcutsDrag}
                        externalGeometryTarget={externalGeometryTarget}
                        facePickMode={facePickMode}
                        onStartExternalGeometryPick={onStartExternalGeometryPick}
                        onCancelFacePick={onCancelFacePick}
                        measureActive={measureActive}
                        measureCount={measureCount}
                        measureListOpen={measureListOpen}
                        onToggleMeasure={onToggleMeasure}
                        onToggleMeasureList={onToggleMeasureList}
                        documentStore={documentStore}
                        messageService={messageService}
                    />

                    <div className="cad-sketch-constraint-bar">
                        <span className="cad-sketch-constraint-label">Constraint:</span>
                        <select
                            className="theia-select cad-sketch-constraint-select"
                            value={constraintInput?.kind ?? ''}
                            onChange={(e) => {
                                if (e.target.value !== '') {
                                    controller.startConstraint(e.target.value as ConstraintKind);
                                } else {
                                    controller.cancel();
                                }
                            }}
                        >
                            <option value="">None</option>
                            {CONSTRAINT_OPTIONS.map((opt) => (
                                <option key={opt.kind} value={opt.kind}>
                                    {opt.label}
                                </option>
                            ))}
                        </select>
                        {constraintInput !== undefined && (
                            <span className="cad-sketch-constraint-hint">
                                {constraintInput.targetIds.length} / {arityFor(constraintInput.kind)} selected
                            </span>
                        )}
                    </div>

                    {needsValue && constraintInput !== undefined && (
                        <div className="cad-sketch-value-input">
                            <label>
                                {labelForValue(constraintInput.kind)}
                                <input
                                    type="text"
                                    value={value}
                                    placeholder="value or param"
                                    onChange={(e) => setValue(e.target.value)}
                                    onKeyDown={onKeyDown}
                                    autoFocus
                                />
                            </label>
                            {constraintInput.kind === 'radius' && (
                                <label className="cad-sketch-diameter-toggle">
                                    <input type="checkbox" checked={useDiameter} onChange={(e) => setUseDiameter(e.target.checked)} />
                                    Diameter
                                </label>
                            )}
                            <button className="theia-button secondary" onClick={applyValue}>
                                <span className="codicon codicon-check" />
                            </button>
                            <button className="theia-button secondary" onClick={() => controller.cancel()}>
                                <span className="codicon codicon-close" />
                            </button>
                        </div>
                    )}

                    {facePickMode === 'externalGeometry' && (
                        <div className="cad-sketch-face-pick-banner">
                            <span className="codicon codicon-target" />
                            <span>Click a face or edge in the viewport to add external geometry.</span>
                            <button className="theia-button secondary" onClick={onCancelFacePick}>
                                Cancel
                            </button>
                        </div>
                    )}

                    {dressUpPickMode !== undefined && (
                        <div className="cad-sketch-face-pick-banner">
                            <span className="codicon codicon-target" />
                            <span>
                                Click a{dressUpPickMode.selecting === 'edge' ? 'n edge' : ' face'} in the viewport for{' '}
                                {capitalize(dressUpPickMode.type)}.
                            </span>
                            <button className="theia-button secondary" onClick={onDressUpPickCancel}>
                                Cancel
                            </button>
                        </div>
                    )}

                    {holePickMode && (
                        <div className="cad-sketch-face-pick-banner">
                            <span className="codicon codicon-target" />
                            <span>Click a planar face in the viewport to place the hole center.</span>
                            <button className="theia-button secondary" onClick={onHolePickCancel}>
                                Cancel
                            </button>
                        </div>
                    )}

                    {externalRefs.length > 0 && (
                        <ExternalRefsPanel
                            drag={externalRefsDrag}
                            refs={externalRefs}
                            onRemove={(index) => {
                                if (sketchId === undefined) {
                                    return;
                                }
                                const result = documentStore.removeExternalRef(sketchId, index);
                                if (!result.success) {
                                    // eslint-disable-next-line no-console
                                    console.error('[CadSketchOverlay] Failed to remove external ref:', result.error);
                                }
                                session?.removeExternalRef(index);
                            }}
                        />
                    )}

                    {constraintInput?.error !== undefined && (
                        <div className="cad-sketch-status cad-sketch-status-error">{constraintInput.error}</div>
                    )}

                    <AutoDimensionInput controller={controller} />

                    {dimensionLabels.map((label) => (
                        <div
                            key={label.id}
                            className={`cad-sketch-dimension-label ${label.selected ? 'selected' : ''} ${label.pinned ? 'pinned' : ''}`}
                            style={{ left: label.x, top: label.y }}
                            onClick={(e) => {
                                e.stopPropagation();
                                const dimension = dimensions.find((d) => d.id === label.id);
                                if (dimension !== undefined) {
                                    openDimensionEdit(dimension);
                                }
                            }}
                        >
                            {formatDimensionWithUnits(label.text, docUnits)}
                        </div>
                    ))}

                    {editingDimension !== undefined && (
                        <DimensionEditPopover
                            dimension={editingDimension}
                            units={docUnits}
                            value={editDimValue}
                            driving={editDimDriving}
                            onValueChange={setEditDimValue}
                            onDrivingChange={setEditDimDriving}
                            onApply={applyDimensionEdit}
                            onDelete={deleteDimension}
                            onClose={closeDimensionEdit}
                        />
                    )}

                    <ConstraintContextPopover controller={controller} />

                    {paramsOpen && session !== undefined && (
                        <ParametersPanel
                            drag={paramsDrag}
                            parameters={session.getParameters()}
                            dimensions={dimensions}
                            errors={paramErrors}
                            onAdd={addParameter}
                            onRename={() => {
                                // Rename is intentionally not supported yet.
                            }}
                            onSet={setParameter}
                            onRemove={removeParameter}
                            onClose={() => setParamsOpen(false)}
                        />
                    )}

                    {diagnosticsOpen && (
                        <DiagnosticsPopover
                            drag={diagnosticsDrag}
                            status={status}
                            constraints={session?.getConstraints() ?? []}
                            referenceResults={relevantRefs}
                            onHighlight={(kind) => controller.highlightDiagnostics(kind)}
                            onRemoveRedundant={() => void removeRedundantConstraints()}
                            onClose={() => setDiagnosticsOpen(false)}
                        />
                    )}
                </>
            )}

            {active && (
                <div
                    className={`cad-sketch-status-line ${hasDiagnostics ? 'has-diagnostics' : ''}`}
                    onClick={() => hasDiagnostics && setDiagnosticsOpen(!diagnosticsOpen)}
                >
                    {statusText}
                </div>
            )}
        </div>
    );
}

/** Datum kinds the datum-lite forms can author. */
export type DatumFormKind = DatumKind | 'threePoint' | 'midplane' | 'line2Point';

/** Validated three-point datum draft: a plane through three non-collinear points. */
export interface ThreePointDatumDraft {
    readonly kind: 'threePoint';
    readonly points: readonly [CurvePoint, CurvePoint, CurvePoint];
}

/** Validated midplane datum draft: the plane midway between two planar faces. */
export interface MidplaneDatumDraft {
    readonly kind: 'midplane';
    readonly faces: readonly [TopologyRef, TopologyRef];
}

/** Validated two-point line datum draft: an axis through two distinct points. */
export interface Line2PointDatumDraft {
    readonly kind: 'line2Point';
    readonly points: readonly [CurvePoint, CurvePoint];
}

/** Validated new-kind datum draft handed to the sketch-entry seam. */
export type DatumDraft = ThreePointDatumDraft | MidplaneDatumDraft | Line2PointDatumDraft;

/** Absolute floor for two datum points to count as distinct (model units). */
const MIN_DATUM_POINT_SEPARATION = 1e-9;

/** Absolute floor for three datum points to count as non-collinear (area in model units^2). */
const MIN_DATUM_TRIANGLE_AREA = 1e-9;

function parseDatumPoint(values: readonly [string, string, string]): CurvePoint | undefined {
    const nums = values.map((v) => Number(v));
    if (!nums.every((n) => Number.isFinite(n))) {
        return undefined;
    }
    return [nums[0], nums[1], nums[2]];
}

function datumTriangleArea(a: CurvePoint, b: CurvePoint, c: CurvePoint): number {
    const ab: CurvePoint = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac: CurvePoint = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cross = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    return 0.5 * Math.sqrt(cross[0] * cross[0] + cross[1] * cross[1] + cross[2] * cross[2]);
}

function datumPointDistance(a: CurvePoint, b: CurvePoint): number {
    return Math.sqrt((b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1]) + (b[2] - a[2]) * (b[2] - a[2]));
}

interface DatumPickerProps {
    datumKind: DatumKind;
    offset: string;
    facePickMode?: 'sketchDatum' | 'externalGeometry';
    holePickMode?: boolean;
    onDatumKindChange: (kind: DatumKind) => void;
    onOffsetChange: (value: string) => void;
    onEnter: () => void;
    /** Receives the validated new-kind draft; the overlay adapts it to the sketch-entry seam. */
    onEnterExtendedKind: (draft: DatumDraft) => void;
    onCancel: () => void;
    onStartFacePick: () => void;
    onCancelFacePick: () => void;
    onStartHolePick: (callback: (ref: TopologyRef, uv: [number, number]) => void) => void;
    onHolePickCancel: () => void;
}

function DatumPicker(props: DatumPickerProps): React.ReactElement {
    const picking = props.facePickMode === 'sketchDatum';
    const [formKind, setFormKind] = React.useState<DatumFormKind>(props.datumKind);
    const [pointInputs, setPointInputs] = React.useState<string[]>(['0', '0', '0', '0', '0', '0', '1', '0', '0']);
    const [midplaneFaces, setMidplaneFaces] = React.useState<TopologyRef[]>([]);
    const [midplaneSlot, setMidplaneSlot] = React.useState<0 | 1 | undefined>(undefined);
    const [datumError, setDatumError] = React.useState<string | undefined>();
    const midplanePicking = props.holePickMode === true && midplaneSlot !== undefined;

    // The hole channel is shared with the hole dialog; a pick that ends
    // anywhere (viewport pick or Escape-cancel) releases our slot.
    React.useEffect(() => {
        if (props.holePickMode !== true) {
            setMidplaneSlot(undefined);
        }
    }, [props.holePickMode]);

    const pickClassic = (kind: DatumKind): void => {
        setFormKind(kind);
        setDatumError(undefined);
        props.onDatumKindChange(kind);
    };

    const pickExtended = (kind: 'threePoint' | 'midplane' | 'line2Point'): void => {
        setFormKind(kind);
        setDatumError(undefined);
    };

    const setPointInput = (index: number, value: string): void => {
        setPointInputs((prev) => {
            const next = [...prev];
            next[index] = value;
            return next;
        });
    };

    const startMidplanePick = (slot: 0 | 1): void => {
        if (midplanePicking && midplaneSlot === slot) {
            setMidplaneSlot(undefined);
            props.onHolePickCancel();
            return;
        }
        setMidplaneSlot(slot);
        props.onStartHolePick((ref) => {
            // Hole-style face pick: keep the face ref, ignore the placement uv.
            setMidplaneFaces((prev) => {
                const next = [...prev];
                next[slot] = ref;
                return next;
            });
        });
    };

    const startExtended = (): void => {
        if (formKind === 'threePoint') {
            const parsed = [
                parseDatumPoint([pointInputs[0], pointInputs[1], pointInputs[2]]),
                parseDatumPoint([pointInputs[3], pointInputs[4], pointInputs[5]]),
                parseDatumPoint([pointInputs[6], pointInputs[7], pointInputs[8]])
            ];
            if (parsed.some((p) => p === undefined)) {
                setDatumError('Each point needs three finite numbers.');
                return;
            }
            const [a, b, c] = parsed as [CurvePoint, CurvePoint, CurvePoint];
            if (datumTriangleArea(a, b, c) < MIN_DATUM_TRIANGLE_AREA) {
                setDatumError('The three points must not be collinear.');
                return;
            }
            setDatumError(undefined);
            props.onEnterExtendedKind({ kind: 'threePoint', points: [a, b, c] });
            return;
        }
        if (formKind === 'line2Point') {
            const parsed = [
                parseDatumPoint([pointInputs[0], pointInputs[1], pointInputs[2]]),
                parseDatumPoint([pointInputs[3], pointInputs[4], pointInputs[5]])
            ];
            if (parsed.some((p) => p === undefined)) {
                setDatumError('Each point needs three finite numbers.');
                return;
            }
            const [a, b] = parsed as [CurvePoint, CurvePoint];
            if (datumPointDistance(a, b) < MIN_DATUM_POINT_SEPARATION) {
                setDatumError('The two points must be distinct.');
                return;
            }
            setDatumError(undefined);
            props.onEnterExtendedKind({ kind: 'line2Point', points: [a, b] });
            return;
        }
        if (midplaneFaces.length < 2 || midplaneFaces[0] === undefined || midplaneFaces[1] === undefined) {
            setDatumError('Pick two planar faces in the viewport for the midplane.');
            return;
        }
        setDatumError(undefined);
        props.onEnterExtendedKind({ kind: 'midplane', faces: [midplaneFaces[0], midplaneFaces[1]] });
    };

    const isExtended = formKind === 'threePoint' || formKind === 'midplane' || formKind === 'line2Point';
    const pointRowCount = formKind === 'line2Point' ? 2 : 3;
    return (
        <div className={`cad-sketch-datum-picker${picking ? ' picking' : ''}`}>
            <div className="cad-sketch-datum-title">Sketch Plane</div>
            {picking ? (
                <div className="cad-sketch-face-pick-banner">
                    <span className="codicon codicon-target" />
                    <span>Click a face in the viewport to place the sketch datum.</span>
                    <button className="theia-button secondary" onClick={props.onCancelFacePick}>
                        Cancel
                    </button>
                </div>
            ) : (
                <>
                    <div className="cad-sketch-datum-buttons">
                        {(['XY', 'YZ', 'XZ'] as DatumKind[]).map((kind) => (
                            <button
                                key={kind}
                                className={`theia-button secondary ${formKind === kind ? 'active' : ''}`}
                                onClick={() => pickClassic(kind)}
                            >
                                {kind}
                            </button>
                        ))}
                        <Tooltip content="Sketch on a selected face" position="bottom">
                            <button className="theia-button secondary" onClick={props.onStartFacePick}>
                                On Face…
                            </button>
                        </Tooltip>
                    </div>
                    <div className="cad-sketch-datum-buttons">
                        {(
                            [
                                { kind: 'threePoint', label: '3-Point' },
                                { kind: 'midplane', label: 'Midplane' },
                                { kind: 'line2Point', label: 'Line 2-Pt' }
                            ] as const
                        ).map(({ kind, label }) => (
                            <button
                                key={kind}
                                className={`theia-button secondary ${formKind === kind ? 'active' : ''}`}
                                onClick={() => pickExtended(kind)}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                    {formKind === 'midplane' ? (
                        <>
                            {[0, 1].map((slot) => (
                                <div key={slot} className="cad-sketch-datum-actions">
                                    <span className="cad-feature-dialog-label">
                                        Face {slot + 1}{' '}
                                        {midplaneFaces[slot] !== undefined ? `(${midplaneFaces[slot].featureId})` : '(none)'}
                                    </span>
                                    <button
                                        className={`theia-button secondary ${midplanePicking && midplaneSlot === slot ? 'active' : ''}`}
                                        onClick={() => startMidplanePick(slot as 0 | 1)}
                                    >
                                        <span className="codicon codicon-target" />{' '}
                                        {midplanePicking && midplaneSlot === slot ? 'Cancel pick' : 'Pick face'}
                                    </button>
                                    {midplaneFaces[slot] !== undefined && (
                                        <button
                                            className="theia-button secondary"
                                            onClick={() => setMidplaneFaces((prev) => prev.filter((_, i) => i !== slot))}
                                        >
                                            <span className="codicon codicon-close" />
                                        </button>
                                    )}
                                </div>
                            ))}
                        </>
                    ) : (
                        isExtended && (
                            <>
                                {Array.from({ length: pointRowCount }, (_, row) => (
                                    <label key={row} className="cad-sketch-datum-offset">
                                        P{row + 1}
                                        {(['x', 'y', 'z'] as const).map((axis, col) => (
                                            <input
                                                key={axis}
                                                type="number"
                                                placeholder={axis}
                                                value={pointInputs[row * 3 + col]}
                                                onChange={(e) => setPointInput(row * 3 + col, e.target.value)}
                                            />
                                        ))}
                                    </label>
                                ))}
                            </>
                        )
                    )}
                    {midplanePicking && (
                        <div className="cad-sketch-face-pick-banner">
                            <span className="codicon codicon-target" />
                            <span>Click a planar face in the viewport for midplane face {(midplaneSlot ?? 0) + 1} of 2.</span>
                            <button className="theia-button secondary" onClick={props.onHolePickCancel}>
                                Cancel
                            </button>
                        </div>
                    )}
                    <label className="cad-sketch-datum-offset">
                        Offset
                        <input
                            type="number"
                            value={props.offset}
                            onChange={(e) => props.onOffsetChange(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    if (isExtended) {
                                        startExtended();
                                    } else {
                                        props.onEnter();
                                    }
                                } else if (e.key === 'Escape') {
                                    props.onCancel();
                                }
                            }}
                        />
                    </label>
                    {datumError !== undefined && <div className="cad-feature-dialog-error">{datumError}</div>}
                    <div className="cad-sketch-datum-actions">
                        <button
                            className="theia-button secondary"
                            onClick={() => {
                                if (isExtended) {
                                    startExtended();
                                } else {
                                    props.onEnter();
                                }
                            }}
                        >
                            Start Sketch
                        </button>
                        <button className="theia-button secondary" onClick={props.onCancel}>
                            Cancel
                        </button>
                    </div>
                </>
            )}
        </div>
    );
}

interface DocumentModeToolbarProps {
    readonly documentStore: CadDocumentStore;
    readonly onNewSketch: () => void;
    readonly onExitSketch: () => void;
    readonly onEditSketch: (sketchId: string) => void;
    readonly onStartFeatureCreation: (type: FeatureType) => void;
    readonly onExportPython?: () => void;
    readonly onNewDocument?: () => void;
    readonly onSaveDocument?: () => void;
    readonly onRebuildDocument?: () => void;
    readonly measureActive?: boolean;
    readonly measureCount?: number;
    readonly measureListOpen?: boolean;
    readonly onToggleMeasure?: () => void;
    readonly onToggleMeasureList?: () => void;
}

interface DraggableNukePanelProps {
    readonly drag: DraggablePanelApi;
    readonly className?: string;
    readonly title: React.ReactNode;
    readonly onClose?: () => void;
    /** Stop pointerdown propagation (outside-click closers) after the drag handler ran. */
    readonly haltPointerPropagation?: boolean;
    readonly children: React.ReactNode;
}

/** NukePanel wrapped in the shared draggable shell: the wrapper owns placement, the header drags. */
function DraggableNukePanel(props: DraggableNukePanelProps): React.ReactElement {
    const { drag } = props;
    return (
        <div
            ref={drag.panelRef}
            {...drag.handleProps}
            onPointerDown={
                props.haltPointerPropagation === true
                    ? (event) => {
                          drag.handleProps.onPointerDown(event);
                          event.stopPropagation();
                      }
                    : drag.handleProps.onPointerDown
            }
            className={props.className !== undefined ? `cad-sketch-draggable ${props.className}` : 'cad-sketch-draggable'}
            style={drag.style}
        >
            <NukePanel title={props.title} onClose={props.onClose}>
                {props.children}
            </NukePanel>
        </div>
    );
}

interface ExternalRefsPanelProps {
    readonly refs: readonly import('../../../common/topology-refs').TopologyRef[];
    readonly onRemove: (index: number) => void;
    readonly drag: DraggablePanelApi;
}

function ExternalRefsPanel(props: ExternalRefsPanelProps): React.ReactElement {
    return (
        <DraggableNukePanel drag={props.drag} className="cad-sketch-external-refs" title="External Geometry">
            {props.refs.map((ref, index) => (
                <div key={`${ref.featureId}-${index}`} className="cad-sketch-external-ref-row">
                    <span className="cad-sketch-external-ref-kind">{ref.kind}</span>
                    <span className="cad-sketch-external-ref-feature">{ref.featureId}</span>
                    <Tooltip content="Remove" position="left">
                        <button className="theia-button secondary" onClick={() => props.onRemove(index)}>
                            <span className="codicon codicon-close" />
                        </button>
                    </Tooltip>
                </div>
            ))}
        </DraggableNukePanel>
    );
}

interface ToolbarAction {
    readonly id: string;
    readonly label: string;
    readonly icon: string;
    readonly disabled: boolean;
    readonly active?: boolean;
    readonly onClick: () => void;
}

/** Tooltip for the document-units dropdown (tags future inputs, never rescales). */
const SET_UNITS_TOOLTIP =
    'Document units for future numeric inputs. Changing units on a unitless document only tags future inputs and never rescales existing numbers.';

function DocumentModeToolbar(props: DocumentModeToolbarProps): React.ReactElement {
    const doc = props.documentStore.document;
    const selectedSketchId = props.documentStore.selection.selectedSketchId;
    const sketchSelected = selectedSketchId !== undefined;
    const hasBodies = doc !== undefined && doc.bodies.length > 0;
    const hasCurves = doc !== undefined && doc.curves.length > 0;
    const hasSolidProducers = doc !== undefined && doc.features.some((f) => SOLID_PRODUCERS.includes(f.type) && !f.suppressed);

    const groups: Array<{ label: string; actions: ToolbarAction[] }> = [
        {
            label: 'Document',
            actions: [
                {
                    id: 'newDocument',
                    label: 'New Document',
                    icon: 'codicon-new-file',
                    disabled: props.onNewDocument === undefined || props.documentStore.hasDocument,
                    onClick: () => props.onNewDocument?.()
                },
                {
                    id: 'saveDocument',
                    label: 'Save Document',
                    icon: 'codicon-save',
                    disabled: props.onSaveDocument === undefined || !props.documentStore.dirty,
                    onClick: () => props.onSaveDocument?.()
                },
                {
                    id: 'rebuild',
                    label: 'Rebuild Geometry',
                    icon: 'codicon-refresh',
                    disabled: props.onRebuildDocument === undefined,
                    onClick: () => props.onRebuildDocument?.()
                },
                {
                    id: 'exportPython',
                    label: 'Export as Python',
                    icon: 'codicon-code',
                    disabled: props.onExportPython === undefined,
                    onClick: () => props.onExportPython?.()
                }
            ]
        },
        {
            label: 'Sketch',
            actions: [
                {
                    id: 'newSketch',
                    label: 'New Sketch',
                    icon: 'codicon-nuke-cad-sketch',
                    disabled: false,
                    onClick: props.onNewSketch
                },
                ...(selectedSketchId !== undefined
                    ? [
                          {
                              id: 'editSketch',
                              label: 'Edit Selected Sketch',
                              icon: 'codicon-edit',
                              disabled: false,
                              onClick: () => props.onEditSketch(selectedSketchId)
                          }
                      ]
                    : [])
            ]
        },
        {
            label: 'Additive',
            actions: [
                {
                    id: 'pad',
                    label: 'Pad (extrude add)',
                    icon: 'codicon-nuke-cad-pad',
                    disabled: !sketchSelected,
                    onClick: () => props.onStartFeatureCreation('pad')
                },
                {
                    id: 'pocket',
                    label: 'Pocket (extrude cut)',
                    icon: 'codicon-nuke-cad-pocket',
                    disabled: !sketchSelected || !hasBodies,
                    onClick: () => props.onStartFeatureCreation('pocket')
                },
                {
                    id: 'revolve',
                    label: 'Revolve',
                    icon: 'codicon-nuke-cad-revolve',
                    disabled: !sketchSelected,
                    onClick: () => props.onStartFeatureCreation('revolve')
                },
                {
                    id: 'groove',
                    label: 'Groove',
                    icon: 'codicon-nuke-cad-groove',
                    disabled: !sketchSelected || !hasBodies,
                    onClick: () => props.onStartFeatureCreation('groove')
                },
                {
                    id: 'loft',
                    label: 'Loft (join sketch sections)',
                    icon: 'codicon-nuke-cad-loft',
                    disabled: doc === undefined || doc.sketches.length < 2,
                    onClick: () => props.onStartFeatureCreation('loft')
                },
                {
                    id: 'sweep',
                    label: 'Sweep (sketch along curve)',
                    icon: 'codicon-nuke-cad-sweep',
                    disabled: !sketchSelected || !hasCurves,
                    onClick: () => props.onStartFeatureCreation('sweep')
                },
                {
                    id: 'pipe',
                    label: 'Pipe (circle along curve)',
                    icon: 'codicon-nuke-cad-pipe',
                    disabled: !hasCurves,
                    onClick: () => props.onStartFeatureCreation('pipe')
                },
                {
                    id: 'helicalSweep',
                    label: 'Helical Sweep (sketch along helix)',
                    icon: 'codicon-nuke-cad-helix',
                    disabled: !sketchSelected,
                    onClick: () => props.onStartFeatureCreation('helicalSweep')
                }
            ]
        },
        {
            label: 'Boolean',
            actions: [
                {
                    id: 'booleanFuse',
                    label: 'Boolean Fuse',
                    icon: 'codicon-nuke-cad-boolean-fuse',
                    disabled: !hasBodies,
                    onClick: () => props.onStartFeatureCreation('booleanFuse')
                },
                {
                    id: 'booleanCut',
                    label: 'Boolean Cut',
                    icon: 'codicon-nuke-cad-boolean-cut',
                    disabled: !hasBodies,
                    onClick: () => props.onStartFeatureCreation('booleanCut')
                },
                {
                    id: 'booleanCommon',
                    label: 'Boolean Common',
                    icon: 'codicon-nuke-cad-boolean-common',
                    disabled: !hasBodies,
                    onClick: () => props.onStartFeatureCreation('booleanCommon')
                }
            ]
        },
        {
            label: 'Dress-up',
            actions: [
                {
                    id: 'fillet',
                    label: 'Fillet',
                    icon: 'codicon-nuke-cad-fillet',
                    disabled: !hasBodies,
                    onClick: () => props.onStartFeatureCreation('fillet')
                },
                {
                    id: 'chamfer',
                    label: 'Chamfer',
                    icon: 'codicon-nuke-cad-chamfer',
                    disabled: !hasBodies,
                    onClick: () => props.onStartFeatureCreation('chamfer')
                },
                {
                    id: 'draft',
                    label: 'Draft',
                    icon: 'codicon-nuke-cad-draft',
                    disabled: !hasBodies,
                    onClick: () => props.onStartFeatureCreation('draft')
                },
                {
                    id: 'shell',
                    label: 'Shell',
                    icon: 'codicon-nuke-cad-shell',
                    disabled: !hasBodies,
                    onClick: () => props.onStartFeatureCreation('shell')
                }
            ]
        },
        {
            label: 'Pattern',
            actions: [
                {
                    id: 'linearPattern',
                    label: 'Linear Pattern',
                    icon: 'codicon-nuke-cad-linear-pattern',
                    disabled: !hasBodies || !hasSolidProducers,
                    onClick: () => props.onStartFeatureCreation('linearPattern')
                },
                {
                    id: 'circularPattern',
                    label: 'Circular Pattern',
                    icon: 'codicon-nuke-cad-circular-pattern',
                    disabled: !hasBodies || !hasSolidProducers,
                    onClick: () => props.onStartFeatureCreation('circularPattern')
                },
                {
                    id: 'mirror',
                    label: 'Mirror',
                    icon: 'codicon-nuke-cad-mirror',
                    disabled: !hasBodies || !hasSolidProducers,
                    onClick: () => props.onStartFeatureCreation('mirror')
                },
                {
                    id: 'hole',
                    label: 'Hole',
                    icon: 'codicon-nuke-cad-hole',
                    disabled: !hasBodies,
                    onClick: () => props.onStartFeatureCreation('hole')
                }
            ]
        },
        {
            label: 'Inspect',
            actions: [
                {
                    id: 'measure',
                    label: 'Measure (distance, angle, radius)',
                    icon: 'codicon-nuke-cad-measure',
                    disabled: false,
                    active: props.measureActive,
                    onClick: () => props.onToggleMeasure?.()
                },
                {
                    id: 'measureList',
                    label: `Measurements${props.measureCount ? ` (${props.measureCount})` : ''}`,
                    icon: 'codicon-list-unordered',
                    disabled: false,
                    active: props.measureListOpen,
                    onClick: () => props.onToggleMeasureList?.()
                }
            ]
        }
    ];

    return (
        <div className="cad-document-toolbar">
            <div className="cad-document-toolbar-info">
                <span className="codicon codicon-file cad-document-toolbar-icon" />
                <div className="cad-document-toolbar-title">
                    <span className="cad-document-toolbar-name">{doc?.name ?? 'Untitled'}</span>
                    {props.documentStore.dirty && <span className="cad-document-toolbar-dirty" title="Unsaved changes" />}
                </div>
                <Tooltip content={SET_UNITS_TOOLTIP} position="bottom">
                    <select
                        className="theia-select cad-document-toolbar-units"
                        aria-label="Document units"
                        value={doc?.units ?? ''}
                        onChange={(e) => {
                            const next = e.target.value === '' ? undefined : (e.target.value as DocumentUnits);
                            props.documentStore.setUnits(next);
                        }}
                    >
                        <option value="">Unitless</option>
                        <option value="mm">mm</option>
                        <option value="cm">cm</option>
                        <option value="m">m</option>
                    </select>
                </Tooltip>
            </div>
            <div className="cad-document-toolbar-actions">
                <NukeToolbar>
                    {groups.map((group) => (
                        <NukeToolbarGroup key={group.label} label={group.label} className="cad-document-toolbar-group">
                            {group.actions.map((action) => (
                                <Tooltip key={action.id} content={action.label} position="bottom">
                                    <button
                                        className={`theia-button secondary cad-document-toolbar-action ${action.active ? 'active' : ''}`}
                                        disabled={action.disabled}
                                        onClick={action.onClick}
                                    >
                                        <span className={`codicon ${action.icon}`} />
                                    </button>
                                </Tooltip>
                            ))}
                        </NukeToolbarGroup>
                    ))}
                </NukeToolbar>
            </div>
        </div>
    );
}

interface SketchToolbarProps {
    readonly controller: SketchModeController;
    readonly tool: SketchTool;
    readonly construction: boolean;
    readonly paramsOpen: boolean;
    readonly setParamsOpen: (value: boolean) => void;
    readonly shortcutsDrag: DraggablePanelApi;
    readonly externalGeometryTarget?: { readonly id: string };
    readonly facePickMode?: 'sketchDatum' | 'externalGeometry';
    readonly onStartExternalGeometryPick: (featureId: string) => void;
    readonly onCancelFacePick: () => void;
    readonly measureActive?: boolean;
    readonly measureCount?: number;
    readonly measureListOpen?: boolean;
    readonly onToggleMeasure?: () => void;
    readonly onToggleMeasureList?: () => void;
    /** Document store: the carbon-copy button reads the Feature-Tree-selected sketch from its selection. */
    readonly documentStore: CadDocumentStore;
    readonly messageService: MessageService;
}

function SketchToolbar(props: SketchToolbarProps): React.ReactElement {
    const [collapsed, setCollapsed] = React.useState(false);
    const [menuOpen, setMenuOpen] = React.useState(false);
    const [shortcutsOpen, setShortcutsOpen] = React.useState(false);
    const {
        controller,
        tool,
        construction,
        paramsOpen,
        setParamsOpen,
        shortcutsDrag,
        externalGeometryTarget,
        facePickMode,
        onStartExternalGeometryPick,
        onCancelFacePick,
        measureActive,
        measureCount,
        measureListOpen,
        onToggleMeasure,
        onToggleMeasureList,
        documentStore,
        messageService
    } = props;
    const drag = useDraggablePanel({ canDrag: TOOLBAR_DRAG_TARGET, canResetFrom: TOOLBAR_RESET_TARGET, resetOnContextMenu: false });

    const snapEnabled = controller.isSnapEnabled();
    const snapPresetIndex = SNAP_RADIUS_PRESETS.findIndex((p) => p.px === controller.getSnapRadiusPx());
    const snapPreset = SNAP_RADIUS_PRESETS[snapPresetIndex === -1 ? 1 : snapPresetIndex];
    const cycleSnapRadius = (): void => {
        const next = SNAP_RADIUS_PRESETS[(SNAP_RADIUS_PRESETS.indexOf(snapPreset) + 1) % SNAP_RADIUS_PRESETS.length];
        controller.setSnapRadius(next.px);
    };

    const selectedSketchId = documentStore.selection.selectedSketchId;

    const handleCarbonCopy = async (): Promise<void> => {
        const session = controller.getSession();
        if (session === undefined) {
            return;
        }
        if (selectedSketchId === undefined) {
            messageService?.warn('Select a sketch in the Feature Tree to carbon-copy it into this sketch.');
            return;
        }
        const source = documentStore.document?.sketches.find((sketch) => sketch.id === selectedSketchId);
        if (source === undefined) {
            messageService?.warn(`Selected sketch '${selectedSketchId}' no longer exists in the document.`);
            return;
        }
        const result = await session.carbonCopyFrom(source);
        if (result.error !== undefined) {
            messageService?.warn(result.error);
        }
    };

    const resetPosition = (): void => {
        drag.resetPosition();
        setMenuOpen(false);
    };

    const openContextMenu = (e: React.MouseEvent): void => {
        e.preventDefault();
        setMenuOpen(true);
    };

    React.useEffect(() => {
        if (!menuOpen) {
            return undefined;
        }
        const close = (): void => setMenuOpen(false);
        window.addEventListener('pointerdown', close);
        return () => window.removeEventListener('pointerdown', close);
    }, [menuOpen]);

    React.useEffect(() => {
        if (!shortcutsOpen) {
            return undefined;
        }
        const close = (): void => {
            if (!shortcutsDrag.isDragging()) {
                setShortcutsOpen(false);
            }
        };
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                close();
            }
        };
        window.addEventListener('pointerdown', close);
        window.addEventListener('keydown', onKey, true);
        return () => {
            window.removeEventListener('pointerdown', close);
            window.removeEventListener('keydown', onKey, true);
        };
    }, [shortcutsOpen, shortcutsDrag]);

    if (collapsed) {
        return (
            <>
                <div
                    ref={drag.panelRef}
                    {...drag.handleProps}
                    className="cad-sketch-toolbar-toggle-anchor"
                    style={drag.style}
                    onContextMenu={openContextMenu}
                >
                    <Tooltip content="Show Sketch Tools" position="bottom">
                        <button
                            className="theia-button secondary cad-sketch-toolbar-toggle"
                            onClick={() => {
                                if (!drag.dragMovedRef.current) {
                                    setCollapsed(false);
                                }
                                drag.dragMovedRef.current = false;
                            }}
                        >
                            <span className="codicon codicon-menu" />
                        </button>
                    </Tooltip>
                </div>
                {menuOpen && (
                    <div className="cad-sketch-toolbar-context-menu" onPointerDown={(e) => e.stopPropagation()}>
                        <button className="cad-sketch-toolbar-context-item" onClick={resetPosition}>
                            <span className="codicon codicon-discard" /> Reset Position
                        </button>
                    </div>
                )}
            </>
        );
    }

    return (
        <>
            <div
                ref={drag.panelRef}
                {...drag.handleProps}
                className="cad-sketch-toolbar"
                style={drag.style}
                onContextMenu={openContextMenu}
            >
                <div className="cad-sketch-toolbar-header">
                    <span className="cad-sketch-toolbar-title">Sketch</span>
                    <Tooltip content="Keyboard Shortcuts" position="top">
                        <button
                            className={`theia-button secondary cad-sketch-tool-button ${shortcutsOpen ? 'active' : ''}`}
                            onClick={() => setShortcutsOpen(!shortcutsOpen)}
                        >
                            <span className="codicon codicon-nuke-cad-keyboard" />
                        </button>
                    </Tooltip>
                    <Tooltip content="Collapse Sketch Tools" position="top">
                        <button className="theia-button secondary cad-sketch-toolbar-collapse" onClick={() => setCollapsed(true)}>
                            <span className="codicon codicon-chevron-left" />
                        </button>
                    </Tooltip>
                </div>
                <div className="cad-sketch-toolbar-body">
                    <div className="cad-sketch-toolbar-group">
                        {TOOLS.map(({ tool: t, label, icon, key }) => (
                            <Tooltip key={t} content={`${label} (${key})`} position="bottom">
                                <button
                                    className={`theia-button secondary cad-sketch-tool-button ${tool === t ? 'active' : ''}`}
                                    onClick={() => controller.setTool(t)}
                                >
                                    <span className={`codicon ${icon}`} />
                                </button>
                            </Tooltip>
                        ))}
                    </div>
                    <div className="cad-sketch-toolbar-separator" />
                    <div className="cad-sketch-toolbar-group">
                        <Tooltip content="Construction Geometry" position="bottom">
                            <button
                                className={`theia-button secondary cad-sketch-tool-button ${construction ? 'active' : ''}`}
                                onClick={() => controller.setConstruction(!construction)}
                            >
                                <span className="codicon codicon-nuke-cad-construction" />
                            </button>
                        </Tooltip>
                        <Tooltip content="Toggle Construction on Selection" position="bottom">
                            <button
                                className="theia-button secondary cad-sketch-tool-button"
                                onClick={() => void controller.toggleConstructionForSelection()}
                            >
                                <span className="codicon codicon-edit" />
                            </button>
                        </Tooltip>
                        <Tooltip content="External Geometry" position="bottom">
                            <button
                                className={`theia-button secondary cad-sketch-tool-button ${facePickMode === 'externalGeometry' ? 'active' : ''}`}
                                disabled={externalGeometryTarget === undefined}
                                onClick={() => {
                                    if (facePickMode === 'externalGeometry') {
                                        onCancelFacePick();
                                    } else if (externalGeometryTarget !== undefined) {
                                        onStartExternalGeometryPick(externalGeometryTarget.id);
                                    }
                                }}
                            >
                                <span className="codicon codicon-nuke-cad-external-ref" />
                            </button>
                        </Tooltip>
                        <Tooltip content="Carbon Copy (import the Feature-Tree-selected sketch)" position="bottom">
                            <button className="theia-button secondary cad-sketch-tool-button" onClick={() => void handleCarbonCopy()}>
                                <span className="codicon codicon-copy" />
                            </button>
                        </Tooltip>
                        <Tooltip content={snapEnabled ? 'Disable Snapping' : 'Enable Snapping'} position="bottom">
                            <button
                                className={`theia-button secondary cad-sketch-tool-button ${snapEnabled ? 'active' : ''}`}
                                onClick={() => controller.setSnapEnabled(!snapEnabled)}
                            >
                                <span className="codicon codicon-nuke-cad-snap" />
                            </button>
                        </Tooltip>
                        <Tooltip content={`Snap Radius: ${snapPreset.px}px (click to change)`} position="bottom">
                            <button className="theia-button secondary cad-sketch-tool-button" onClick={cycleSnapRadius}>
                                {snapPreset.label}
                            </button>
                        </Tooltip>
                    </div>
                    <div className="cad-sketch-toolbar-separator" />
                    <div className="cad-sketch-toolbar-group">
                        <Tooltip content="Parameters" position="bottom">
                            <button
                                className={`theia-button secondary cad-sketch-tool-button ${paramsOpen ? 'active' : ''}`}
                                onClick={() => setParamsOpen(!paramsOpen)}
                            >
                                <span className="codicon codicon-symbol-variable" />
                            </button>
                        </Tooltip>
                        <Tooltip content="Measure (click two points)" position="bottom">
                            <button
                                className={`theia-button secondary cad-sketch-tool-button ${measureActive ? 'active' : ''}`}
                                onClick={() => onToggleMeasure?.()}
                            >
                                <span className="codicon codicon-nuke-cad-measure" />
                            </button>
                        </Tooltip>
                        <Tooltip content={`Measurements${measureCount ? ` (${measureCount})` : ''}`} position="bottom">
                            <button
                                className={`theia-button secondary cad-sketch-tool-button ${measureListOpen ? 'active' : ''}`}
                                onClick={() => onToggleMeasureList?.()}
                            >
                                <span className="codicon codicon-list-unordered" />
                            </button>
                        </Tooltip>
                    </div>
                    <TransformActions controller={controller} tool={tool} messageService={messageService} />
                </div>
                {menuOpen && (
                    <div className="cad-sketch-toolbar-context-menu" onPointerDown={(e) => e.stopPropagation()}>
                        <button className="cad-sketch-toolbar-context-item" onClick={resetPosition}>
                            <span className="codicon codicon-discard" /> Reset Position
                        </button>
                    </div>
                )}
            </div>
            {shortcutsOpen && <SketchShortcutsPopover drag={shortcutsDrag} onClose={() => setShortcutsOpen(false)} />}
        </>
    );
}

/** Warn (carbon-copy precedent) unless the selection is non-empty. */
function ensureSelection(controller: SketchModeController, messageService: MessageService): string[] | undefined {
    const ids = [...controller.getSelection()];
    if (ids.length === 0) {
        messageService?.warn('Select at least one sketch entity first.');
        return undefined;
    }
    return ids;
}

/**
 * Mirror axis guard: the selection must contain exactly one line. Warns and
 * returns undefined otherwise (never guesses an axis).
 */
function ensureMirrorAxis(session: SketchSession, ids: readonly string[], messageService: MessageService): string | undefined {
    const axes = ids.filter((id) => session.getPrimitive(id)?.type === 'line');
    if (axes.length !== 1) {
        messageService?.warn('Mirror needs exactly one selected line as the axis.');
        return undefined;
    }
    return axes[0];
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

interface SelectionBounds {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

/**
 * Bounding box of the selected primitives in sketch coordinates, resolved
 * through the session's solved geometry (lines via endpoints, circles/arcs
 * via center ± radius, ellipses via center/focus expanded by radmin,
 * B-splines via poles).
 */
function selectionBounds(session: SketchSession, ids: readonly string[]): SelectionBounds | undefined {
    let bounds: SelectionBounds | undefined;
    const extend = (x: number, y: number): void => {
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return;
        }
        if (bounds === undefined) {
            bounds = { minX: x, minY: y, maxX: x, maxY: y };
        } else {
            bounds.minX = Math.min(bounds.minX, x);
            bounds.minY = Math.min(bounds.minY, y);
            bounds.maxX = Math.max(bounds.maxX, x);
            bounds.maxY = Math.max(bounds.maxY, y);
        }
    };
    const extendPoint = (id: string): void => {
        const point = session.getPrimitive(id);
        if (point !== undefined && point.type === 'point') {
            extend(point.x, point.y);
        }
    };
    for (const id of ids) {
        const primitive = session.getPrimitive(id);
        if (primitive === undefined) {
            continue;
        }
        switch (primitive.type) {
            case 'point':
                extend(primitive.x, primitive.y);
                break;
            case 'line':
                extendPoint(primitive.p1Id);
                extendPoint(primitive.p2Id);
                break;
            case 'circle':
            case 'arc': {
                const center = session.getPrimitive(primitive.centerId);
                if (center !== undefined && center.type === 'point') {
                    extend(center.x - primitive.radius, center.y - primitive.radius);
                    extend(center.x + primitive.radius, center.y + primitive.radius);
                }
                break;
            }
            case 'ellipse': {
                const center = session.getPrimitive(primitive.centerId);
                const focus = session.getPrimitive(primitive.focus1Id);
                if (center !== undefined && center.type === 'point') {
                    extend(center.x - primitive.radmin, center.y - primitive.radmin);
                    extend(center.x + primitive.radmin, center.y + primitive.radmin);
                }
                if (focus !== undefined && focus.type === 'point') {
                    extend(focus.x - primitive.radmin, focus.y - primitive.radmin);
                    extend(focus.x + primitive.radmin, focus.y + primitive.radmin);
                }
                break;
            }
            case 'bspline':
                for (const poleId of primitive.poleIds) {
                    extendPoint(poleId);
                }
                break;
        }
    }
    return bounds;
}

/** Selection bbox center (the scale popover's center default). */
function selectionBBoxCenter(session: SketchSession, ids: readonly string[]): { x: number; y: number } | undefined {
    const bounds = selectionBounds(session, ids);
    if (bounds === undefined) {
        return undefined;
    }
    return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
}

interface TransformPopoverProps {
    readonly controller: SketchModeController;
    readonly messageService: MessageService;
    readonly onClose: () => void;
}

/** Shared Apply/Cancel shell reusing the dimension-popover styling pattern. */
function TransformPopoverShell(props: {
    readonly title: string;
    readonly error: string | undefined;
    readonly onApply: () => void;
    readonly onClose: () => void;
    readonly children: React.ReactNode;
}): React.ReactElement {
    const { title, error, onApply, onClose, children } = props;
    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
        if (e.key === 'Enter') {
            onApply();
        } else if (e.key === 'Escape') {
            onClose();
        }
    };
    return (
        <div className="cad-sketch-dimension-popover">
            <div className="cad-sketch-dimension-popover-title">{title}</div>
            {React.Children.map(children, (child) => {
                if (React.isValidElement<{ onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void }>(child)) {
                    return React.cloneElement(child, { onKeyDown });
                }
                return child;
            })}
            {error !== undefined && <div className="cad-feature-dialog-error">{error}</div>}
            <div className="cad-sketch-dimension-popover-actions">
                <button className="theia-button secondary" onClick={onApply}>
                    <span className="codicon codicon-check" /> Apply
                </button>
                <button className="theia-button secondary" onClick={onClose}>
                    <span className="codicon codicon-close" /> Cancel
                </button>
            </div>
        </div>
    );
}

function TransformTextRow(props: {
    readonly label: string;
    readonly value: string;
    readonly placeholder: string;
    readonly onValueChange: (value: string) => void;
    readonly onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}): React.ReactElement {
    return (
        <label className="cad-sketch-dimension-popover-row">
            {props.label}
            <input
                type="text"
                value={props.value}
                placeholder={props.placeholder}
                onChange={(e) => props.onValueChange(e.target.value)}
                onKeyDown={props.onKeyDown}
                autoFocus
            />
        </label>
    );
}

function ScalePopover(props: TransformPopoverProps): React.ReactElement {
    const { controller, messageService, onClose } = props;
    const session = controller.getSession();
    const defaultCenter = session !== undefined ? selectionBBoxCenter(session, [...controller.getSelection()]) : undefined;
    const [factorText, setFactorText] = React.useState('');
    const [cxText, setCxText] = React.useState(defaultCenter !== undefined ? String(defaultCenter.x) : '');
    const [cyText, setCyText] = React.useState(defaultCenter !== undefined ? String(defaultCenter.y) : '');
    const [error, setError] = React.useState<string | undefined>();

    const apply = async (): Promise<void> => {
        const live = controller.getSession();
        if (live === undefined) {
            messageService?.warn('No active sketch session.');
            return;
        }
        const ids = ensureSelection(controller, messageService);
        if (ids === undefined) {
            return;
        }
        const factor = Number(factorText);
        if (!Number.isFinite(factor) || factor === 0) {
            setError('Factor must be a finite, non-zero number.');
            return;
        }
        const cx = Number(cxText);
        const cy = Number(cyText);
        if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
            setError('Center X and Y must be finite numbers.');
            return;
        }
        setError(undefined);
        try {
            const result = await live.scalePrimitives(ids, { x: cx, y: cy }, factor);
            if (!result.success) {
                setError(result.error ?? 'Scale failed.');
                return;
            }
            onClose();
        } catch (failure) {
            messageService?.warn(`Scale failed: ${errorMessage(failure)}`);
        }
    };

    return (
        <TransformPopoverShell title="Scale" error={error} onApply={apply} onClose={onClose}>
            <TransformTextRow label="Factor" value={factorText} placeholder="e.g. 2" onValueChange={setFactorText} />
            <TransformTextRow label="Center X" value={cxText} placeholder="selection center" onValueChange={setCxText} />
            <TransformTextRow label="Center Y" value={cyText} placeholder="selection center" onValueChange={setCyText} />
        </TransformPopoverShell>
    );
}

function ArrayPopover(props: TransformPopoverProps): React.ReactElement {
    const { controller, messageService, onClose } = props;
    const [rowsText, setRowsText] = React.useState('');
    const [colsText, setColsText] = React.useState('');
    const [dxText, setDxText] = React.useState('');
    const [dyText, setDyText] = React.useState('');
    const [error, setError] = React.useState<string | undefined>();

    const apply = async (): Promise<void> => {
        const live = controller.getSession();
        if (live === undefined) {
            messageService?.warn('No active sketch session.');
            return;
        }
        const ids = ensureSelection(controller, messageService);
        if (ids === undefined) {
            return;
        }
        const rows = Number(rowsText);
        const cols = Number(colsText);
        if (!Number.isInteger(rows) || rows < 1 || !Number.isInteger(cols) || cols < 1) {
            setError('Rows and columns must be integers of at least 1.');
            return;
        }
        const dx = Number(dxText);
        const dy = Number(dyText);
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
            setError('dX and dY must be finite numbers.');
            return;
        }
        setError(undefined);
        try {
            const result = await live.rectangularArray(ids, dx, dy, rows, cols);
            if (!result.success) {
                setError(result.error ?? 'Rectangular array failed.');
                return;
            }
            onClose();
        } catch (failure) {
            messageService?.warn(`Rectangular array failed: ${errorMessage(failure)}`);
        }
    };

    return (
        <TransformPopoverShell title="Rectangular Array" error={error} onApply={apply} onClose={onClose}>
            <TransformTextRow label="Rows" value={rowsText} placeholder="e.g. 2" onValueChange={setRowsText} />
            <TransformTextRow label="Columns" value={colsText} placeholder="e.g. 3" onValueChange={setColsText} />
            <TransformTextRow label="dX" value={dxText} placeholder="e.g. 10" onValueChange={setDxText} />
            <TransformTextRow label="dY" value={dyText} placeholder="e.g. 0" onValueChange={setDyText} />
        </TransformPopoverShell>
    );
}

function OffsetPopover(props: TransformPopoverProps): React.ReactElement {
    const { controller, messageService, onClose } = props;
    const [distanceText, setDistanceText] = React.useState('');
    // Auto-trim defaults on, mirroring the backend contract (`autoTrim` field).
    const [autoTrim, setAutoTrim] = React.useState(true);
    const [error, setError] = React.useState<string | undefined>();

    const apply = async (): Promise<void> => {
        const live = controller.getSession();
        if (live === undefined) {
            messageService?.warn('No active sketch session.');
            return;
        }
        const ids = ensureSelection(controller, messageService);
        if (ids === undefined) {
            return;
        }
        const distance = Number(distanceText);
        if (!Number.isFinite(distance) || distance === 0) {
            setError('Distance must be a finite, non-zero number.');
            return;
        }
        setError(undefined);
        try {
            const result = await live.offsetWire(ids, distance, { autoTrim });
            if (!result.success) {
                setError(result.error ?? 'Offset failed.');
                return;
            }
            onClose();
        } catch (failure) {
            messageService?.warn(`Offset failed: ${errorMessage(failure)}`);
        }
    };

    return (
        <TransformPopoverShell title="Offset" error={error} onApply={apply} onClose={onClose}>
            <TransformTextRow label="Distance" value={distanceText} placeholder="e.g. 1" onValueChange={setDistanceText} />
            <label className="cad-sketch-dimension-popover-row">
                <input type="checkbox" checked={autoTrim} onChange={(e) => setAutoTrim(e.target.checked)} />
                Auto-trim overlaps
            </label>
        </TransformPopoverShell>
    );
}

interface TransformActionsProps {
    readonly controller: SketchModeController;
    readonly tool: SketchTool;
    readonly messageService: MessageService;
}

/** Transform op buttons (scale/array/offset popovers, immediate join). */
function TransformActions(props: TransformActionsProps): React.ReactElement {
    const { controller, tool, messageService } = props;
    const [open, setOpen] = React.useState<'scale' | 'array' | 'offset' | undefined>(undefined);

    // Mirror activation guard: the TOOLS button routes straight through
    // controller.setTool, so the axis check runs here on entry and only warns.
    const prevToolRef = React.useRef<string | undefined>(undefined);
    React.useEffect(() => {
        const current = tool as string;
        const prev = prevToolRef.current;
        prevToolRef.current = current;
        if (current !== 'mirrorTool' || prev === 'mirrorTool') {
            return;
        }
        const session = controller.getSession();
        if (session === undefined) {
            return;
        }
        ensureMirrorAxis(session, [...controller.getSelection()], messageService);
    }, [tool, controller, messageService]);

    const togglePopover = (which: 'scale' | 'array' | 'offset'): void => {
        if (open !== which && ensureSelection(controller, messageService) === undefined) {
            return;
        }
        setOpen(open === which ? undefined : which);
    };

    const runJoin = async (): Promise<void> => {
        const session = controller.getSession();
        if (session === undefined) {
            messageService?.warn('No active sketch session.');
            return;
        }
        try {
            const result = await session.joinOpenEnds();
            if (!result.success) {
                messageService?.warn(result.error ?? 'Join open ends failed.');
            }
        } catch (failure) {
            messageService?.warn(`Join open ends failed: ${errorMessage(failure)}`);
        }
    };

    return (
        <>
            <div className="cad-sketch-toolbar-separator" />
            <div className="cad-sketch-toolbar-group">
                <Tooltip content="Scale selection…" position="bottom">
                    <button
                        className={`theia-button secondary cad-sketch-tool-button ${open === 'scale' ? 'active' : ''}`}
                        onClick={() => togglePopover('scale')}
                    >
                        <span className="codicon codicon-nuke-cad-scale" />
                    </button>
                </Tooltip>
                <Tooltip content="Rectangular array…" position="bottom">
                    <button
                        className={`theia-button secondary cad-sketch-tool-button ${open === 'array' ? 'active' : ''}`}
                        onClick={() => togglePopover('array')}
                    >
                        <span className="codicon codicon-nuke-cad-array" />
                    </button>
                </Tooltip>
                <Tooltip content="Offset wire…" position="bottom">
                    <button
                        className={`theia-button secondary cad-sketch-tool-button ${open === 'offset' ? 'active' : ''}`}
                        onClick={() => togglePopover('offset')}
                    >
                        <span className="codicon codicon-nuke-cad-offset" />
                    </button>
                </Tooltip>
                <Tooltip content="Join open ends" position="bottom">
                    <button className="theia-button secondary cad-sketch-tool-button" onClick={runJoin}>
                        <span className="codicon codicon-nuke-cad-join" />
                    </button>
                </Tooltip>
            </div>
            {open === 'scale' && (
                <ScalePopover controller={controller} messageService={messageService} onClose={() => setOpen(undefined)} />
            )}
            {open === 'array' && (
                <ArrayPopover controller={controller} messageService={messageService} onClose={() => setOpen(undefined)} />
            )}
            {open === 'offset' && (
                <OffsetPopover controller={controller} messageService={messageService} onClose={() => setOpen(undefined)} />
            )}
        </>
    );
}

/** Cheat-sheet key for a transform gesture tool ('' until the session registers it). */
function transformKey(toolId: string): string {
    const entry = TOOLS.find((candidate) => (candidate.tool as string) === toolId);
    return entry !== undefined && entry.key !== '' ? entry.key : '—';
}

/** Cheat-sheet rows for all eight sketch transform operations. */
const TRANSFORM_CHEAT_SHEET_ROWS: ReadonlyArray<{ label: string; key: string; detail: string }> = [
    { label: 'Move', key: transformKey('move'), detail: 'Gesture tool: reposition the selection' },
    { label: 'Copy', key: transformKey('copy'), detail: 'Gesture tool: duplicate the selection' },
    { label: 'Rotate', key: transformKey('rotate'), detail: 'Gesture tool: rotate the selection' },
    { label: 'Mirror', key: transformKey('mirrorTool'), detail: 'Gesture tool: mirror across the one selected line axis' },
    { label: 'Scale', key: 'Toolbar', detail: 'Popover: factor about the selection bbox center' },
    { label: 'Array', key: 'Toolbar', detail: 'Popover: rows / cols with dX / dY offsets' },
    { label: 'Offset', key: 'Toolbar', detail: 'Popover: offset wires by distance' },
    { label: 'Join', key: 'Toolbar', detail: 'Button: join open ends immediately' }
];

interface SketchShortcutsPopoverProps {
    readonly drag: DraggablePanelApi;
    readonly onClose: () => void;
}

function SketchShortcutsPopover(props: SketchShortcutsPopoverProps): React.ReactElement {
    return (
        <DraggableNukePanel
            drag={props.drag}
            className="cad-sketch-shortcuts-popover"
            haltPointerPropagation
            title="Keyboard Shortcuts"
            onClose={props.onClose}
        >
            <div className="cad-sketch-shortcuts-section">
                <div className="cad-sketch-shortcuts-title">Tools</div>
                {TOOLS.map(({ label, key }) => (
                    <div key={label} className="cad-sketch-shortcuts-row">
                        <span className="cad-sketch-shortcuts-key">{key}</span>
                        <span>{label}</span>
                    </div>
                ))}
            </div>
            <div className="cad-sketch-shortcuts-section">
                <div className="cad-sketch-shortcuts-title">Tool modes (M key)</div>
                <div className="cad-sketch-shortcuts-row">
                    <span className="cad-sketch-shortcuts-key">M</span>
                    <span>Cycle mode inside the active tool: rectangle corner/center/rounded, polyline line/arc, polygon sides 3–12</span>
                </div>
            </div>
            <div className="cad-sketch-shortcuts-section">
                <div className="cad-sketch-shortcuts-title">Transform</div>
                {TRANSFORM_CHEAT_SHEET_ROWS.map(({ label, key, detail }) => (
                    <div key={label} className="cad-sketch-shortcuts-row">
                        <span className="cad-sketch-shortcuts-key">{key}</span>
                        <span>
                            {label} — {detail}
                        </span>
                    </div>
                ))}
            </div>
            <div className="cad-sketch-shortcuts-section">
                <div className="cad-sketch-shortcuts-title">Select tool</div>
                <div className="cad-sketch-shortcuts-row">
                    <span className="cad-sketch-shortcuts-key">Click</span>
                    <span>Select entity</span>
                </div>
                <div className="cad-sketch-shortcuts-row">
                    <span className="cad-sketch-shortcuts-key">Ctrl+Click</span>
                    <span>Multi-select; two entities opens relation popover</span>
                </div>
                <div className="cad-sketch-shortcuts-row">
                    <span className="cad-sketch-shortcuts-key">Drag</span>
                    <span>Move point</span>
                </div>
                <div className="cad-sketch-shortcuts-row">
                    <span className="cad-sketch-shortcuts-key">Del</span>
                    <span>Delete selection</span>
                </div>
                <div className="cad-sketch-shortcuts-row">
                    <span className="cad-sketch-shortcuts-key">Esc</span>
                    <span>Cancel · clear · back to Select</span>
                </div>
            </div>
            <div className="cad-sketch-shortcuts-section">
                <div className="cad-sketch-shortcuts-title">Snapping</div>
                <div className="cad-sketch-shortcuts-row">
                    <span className="cad-sketch-shortcuts-key">Magnet</span>
                    <span>Toggle snapping</span>
                </div>
                <div className="cad-sketch-shortcuts-row">
                    <span className="cad-sketch-shortcuts-key">S / M / L</span>
                    <span>Snap radius 6 / 12 / 24 px</span>
                </div>
            </div>
            <div className="cad-sketch-shortcuts-section">
                <div className="cad-sketch-shortcuts-title">Context shortcut bar</div>
                <div className="cad-sketch-shortcuts-row">
                    <span className="cad-sketch-shortcuts-key">Q</span>
                    <span>Open context shortcut bar at cursor (document / sketch)</span>
                </div>
            </div>
            <div className="cad-sketch-shortcuts-section">
                <div className="cad-sketch-shortcuts-title">Sketch mode</div>
                <div className="cad-sketch-shortcuts-row">
                    <span className="cad-sketch-shortcuts-key">Tab</span>
                    <span>Enter / exit sketch mode</span>
                </div>
                <div className="cad-sketch-shortcuts-row">
                    <span className="cad-sketch-shortcuts-key">Carbon copy</span>
                    <span>Import the Feature-Tree-selected sketch into this sketch</span>
                </div>
                <div className="cad-sketch-shortcuts-row">
                    <span className="cad-sketch-shortcuts-key">Finish Sketch</span>
                    <span>Exit and merge into the document</span>
                </div>
            </div>
        </DraggableNukePanel>
    );
}

interface FeatureCreationDialogProps {
    readonly type: FeatureType;
    readonly editFeature?: FeatureDef;
    readonly sketchId?: string;
    readonly documentStore: CadDocumentStore;
    readonly dressUpPickMode?: { readonly type: FeatureType; readonly selecting: 'edge' | 'face' };
    readonly holePickMode?: boolean;
    readonly onCancel: () => void;
    readonly onConfirm: (type: FeatureType, params: FeatureParams) => void;
    readonly onEditFeature?: (id: string, params: FeatureParams) => void;
    readonly onStartDressUpPick: (type: FeatureType, selecting: 'edge' | 'face', callback: (ref: TopologyRef) => void) => void;
    readonly onDressUpPickCancel: () => void;
    readonly onStartHolePick: (callback: (ref: TopologyRef, uv: [number, number]) => void) => void;
    readonly onHolePickCancel: () => void;
    readonly curvePickMode?: boolean;
    readonly onStartCurvePick: (callback: (curveId: string) => void) => void;
    readonly onCurvePickCancel: () => void;
    readonly onPreviewChange?: (request: FeaturePreviewRequest | undefined) => void;
}

const NEW_BODY_SENTINEL = '__new_body__';

type ChamferMode = 'symmetric' | 'twoDistance' | 'distanceAngle';

function FeatureCreationDialog(props: FeatureCreationDialogProps): React.ReactElement {
    const type = props.type;
    const isExtrude = type === 'pad' || type === 'pocket';
    const isRevolve = type === 'revolve' || type === 'groove';
    const isBoolean = type === 'booleanFuse' || type === 'booleanCut' || type === 'booleanCommon';
    const isDressUp = type === 'fillet' || type === 'chamfer' || type === 'draft' || type === 'shell';
    const isPattern = type === 'linearPattern' || type === 'circularPattern' || type === 'mirror';
    const isHole = type === 'hole';
    const isSweep = type === 'sweep';
    const isPipe = type === 'pipe';
    const isCurveSweep = isSweep || isPipe;
    const isLoft = type === 'loft';
    const isHelicalSweep = type === 'helicalSweep';
    // Newer feature types compare as strings; params flow as
    // Record<string, unknown> through the existing finish() path.
    const typeName = type as string;
    const isPrimitive = typeName === 'primitive';
    const isMultiTransform = typeName === 'multiTransform';
    const isDefeature = typeName === 'defeature';
    const doc = props.documentStore.document;
    const bodies = doc?.bodies ?? [];
    const [length, setLength] = React.useState('1');
    const [axis, setAxis] = React.useState<'x' | 'y' | 'z'>('z');
    const [symmetric, setSymmetric] = React.useState(false);
    const [angle, setAngle] = React.useState('90');
    const [label, setLabel] = React.useState(`${type}_1`);
    const [bodyId, setBodyId] = React.useState<string>(bodies.length > 0 ? bodies[0].id : NEW_BODY_SENTINEL);
    const [targetBody, setTargetBody] = React.useState<string>(bodies.length > 0 ? bodies[0].id : '');
    const [toolBodies, setToolBodies] = React.useState<string[]>([]);
    const [keepTools, setKeepTools] = React.useState(false);
    const [error, setError] = React.useState<string | undefined>();

    // Dress-up state.
    const [dressUpBodyId, setDressUpBodyId] = React.useState<string>(bodies.length > 0 ? bodies[0].id : '');
    const [refs, setRefs] = React.useState<TopologyRef[]>([]);
    const [filletRadius, setFilletRadius] = React.useState('1');
    const [chamferMode, setChamferMode] = React.useState<ChamferMode>('symmetric');
    const [chamferDistance, setChamferDistance] = React.useState('1');
    const [chamferDistance2, setChamferDistance2] = React.useState('1');
    const [chamferAngle, setChamferAngle] = React.useState('45');
    const [draftAngle, setDraftAngle] = React.useState('5');
    const [pullDirection, setPullDirection] = React.useState<[string, string, string]>(['0', '0', '1']);
    const [shellThickness, setShellThickness] = React.useState('1');
    const [shellAllFaces, setShellAllFaces] = React.useState(false);

    // Pattern/mirror state.
    const sourceFeatures = doc?.features.filter((f) => SOLID_PRODUCERS.includes(f.type) && !f.suppressed) ?? [];
    const datumOptions = doc?.datums ?? [];
    const [patternSource, setPatternSource] = React.useState(sourceFeatures.length > 0 ? sourceFeatures[0].id : '');
    const [patternCount, setPatternCount] = React.useState('2');
    const [patternSpacing, setPatternSpacing] = React.useState('1');
    const [patternAngle, setPatternAngle] = React.useState('360');
    const [patternAxis, setPatternAxis] = React.useState<'x' | 'y' | 'z'>('z');
    const [patternAxisDatumId, setPatternAxisDatumId] = React.useState('');
    const [mirrorPlane, setMirrorPlane] = React.useState<'XY' | 'YZ' | 'XZ'>('XY');
    const [mirrorPlaneDatumId, setMirrorPlaneDatumId] = React.useState('');

    // Hole state.
    const [holeBodyId, setHoleBodyId] = React.useState<string>(bodies.length > 0 ? bodies[0].id : '');
    const [holeFaceRef, setHoleFaceRef] = React.useState<TopologyRef | undefined>();
    const [holeCenterUv, setHoleCenterUv] = React.useState<[number, number] | undefined>();
    const [holeDiameter, setHoleDiameter] = React.useState('1');
    const [holeDepth, setHoleDepth] = React.useState('');
    const [holeType, setHoleType] = React.useState<'simple' | 'counterbore' | 'countersink' | 'counterdrill'>('simple');
    const [holeCounterboreDiameter, setHoleCounterboreDiameter] = React.useState('1.5');
    const [holeCounterboreDepth, setHoleCounterboreDepth] = React.useState('0.5');
    const [holeCountersinkDiameter, setHoleCountersinkDiameter] = React.useState('1.5');
    const [holeCountersinkAngle, setHoleCountersinkAngle] = React.useState('82');
    // Hole expansion: stepped counterdrill seat, conical taper,
    // drill-point cone tip (blank = flat bottom, today's behavior), and a
    // thread preset (default 'none'; 'modeled' is gated to simple blind holes).
    const [holeCounterdrillDiameter, setHoleCounterdrillDiameter] = React.useState('1.5');
    const [holeCounterdrillDepth, setHoleCounterdrillDepth] = React.useState('0.5');
    const [holeTaperAngle, setHoleTaperAngle] = React.useState('');
    const [holeDrillPointAngle, setHoleDrillPointAngle] = React.useState('');
    const [holeThread, setHoleThread] = React.useState<'none' | 'cosmetic' | 'modeled'>('none');

    // Sweep/pipe state.
    const curves = doc?.curves ?? [];
    const [pathCurveId, setPathCurveId] = React.useState('');
    const [sweepOrientation, setSweepOrientation] = React.useState<'frenet' | 'fixedBinormal'>('frenet');
    const [sweepBinormal, setSweepBinormal] = React.useState<[string, string, string]>(['0', '0', '1']);
    const [pipeRadius, setPipeRadius] = React.useState('1');

    // Loft state: ordered section sketch ids picked in-dialog (the feature
    // does not consume the selected sketch).
    const sketches = doc?.sketches ?? [];
    const [loftSections, setLoftSections] = React.useState<string[]>([]);
    const [loftRuled, setLoftRuled] = React.useState(false);

    // Helical sweep state: the helix is derived from params (no document curve).
    const [helixAxis, setHelixAxis] = React.useState<HelixAxis>('Z');
    const [helixStartRadius, setHelixStartRadius] = React.useState('1');
    const [helixPitch, setHelixPitch] = React.useState('1');
    const [helixTurns, setHelixTurns] = React.useState('3');
    const [helixLeftHanded, setHelixLeftHanded] = React.useState(false);
    const [helixOrientation, setHelixOrientation] = React.useState<'frenet' | 'fixedBinormal'>('fixedBinormal');
    const [helixBinormal, setHelixBinormal] = React.useState<[string, string, string]>(['0', '0', '1']);
    const [previewEnabled, setPreviewEnabled] = React.useState(false);

    // Extrude end-conditions (pad/pocket take the full set; revolve/groove
    // take blind/throughAll). `upToBody` names another body as the extrusion
    // limit (blank = none).
    const [extrudeEnd, setExtrudeEnd] = React.useState<'blind' | 'upToFirst' | 'upToLast' | 'upToFace' | 'throughAll'>('blind');
    const [twoSided, setTwoSided] = React.useState(false);
    const [upToFaceRef, setUpToFaceRef] = React.useState<TopologyRef | undefined>();
    const [upToBody, setUpToBody] = React.useState('');
    const [revolveEnd, setRevolveEnd] = React.useState<'blind' | 'throughAll'>('blind');

    // Pattern scale (blank/1 = unscaled, exactly today's behavior).
    const [patternScale, setPatternScale] = React.useState('1');

    // Additive primitive (datum-xy default; datumId names a datum).
    // `subtractive` cuts the primitive from the target body instead.
    const [primitiveShape, setPrimitiveShape] = React.useState<'box' | 'cylinder' | 'sphere' | 'cone' | 'torus'>('box');
    const [primitiveDims, setPrimitiveDims] = React.useState<[string, string, string]>(['1', '1', '1']);
    const [primitiveDatumId, setPrimitiveDatumId] = React.useState('');
    const [primitiveSubtractive, setPrimitiveSubtractive] = React.useState(false);
    // Helical sweep `subtractive` cuts the swept tool from the target body.
    const [helixSubtractive, setHelixSubtractive] = React.useState(false);
    // Linear-pattern datum axis (blank = coordinate axis, like circular).
    const [linearAxisDatumId, setLinearAxisDatumId] = React.useState('');

    // Multi-transform: two pattern/mirror source features.
    const patternLikeSources =
        doc?.features.filter((f) => ['linearPattern', 'circularPattern', 'mirror'].includes(f.type as string) && !f.suppressed) ?? [];
    const [multiFirst, setMultiFirst] = React.useState('');
    const [multiSecond, setMultiSecond] = React.useState('');

    // Draft neutral plane (optional face ref; pull direction unchanged).
    const [neutralPlaneRef, setNeutralPlaneRef] = React.useState<TopologyRef | undefined>();
    const [neutralPlanePicking, setNeutralPlanePicking] = React.useState(false);

    // Prefill the dialog when editing an existing feature.
    React.useEffect(() => {
        const feature = props.editFeature;
        if (feature === undefined) {
            return;
        }
        const p = feature.params as Record<string, unknown>;
        const body = doc?.bodies.find((b) => b.id === feature.body);
        setLabel(body?.label ?? body?.name ?? `${type}_1`);
        setBodyId(feature.body);
        setDressUpBodyId(feature.body);
        setHoleBodyId(feature.body);
        if (isExtrude) {
            setLength(p.length !== undefined ? String(p.length) : '1');
            setAxis((p.axis as 'x' | 'y' | 'z') ?? 'z');
            setSymmetric(Boolean(p.symmetric));
            const end = p.end as string | undefined;
            setExtrudeEnd(end === 'upToFirst' || end === 'upToLast' || end === 'upToFace' || end === 'throughAll' ? end : 'blind');
            setTwoSided(Boolean(p.twoSided));
            setUpToFaceRef(p.upToFace as TopologyRef | undefined);
            setUpToBody(typeof p.upToBody === 'string' ? p.upToBody : '');
        }
        if (isRevolve) {
            setAngle(p.angle !== undefined ? String(p.angle) : '90');
            setAxis((p.axis as 'x' | 'y' | 'z') ?? 'z');
            setRevolveEnd(p.end === 'throughAll' ? 'throughAll' : 'blind');
        }
        if (isBoolean) {
            setTargetBody(typeof p.targetBody === 'string' ? p.targetBody : feature.body);
            setToolBodies(Array.isArray(p.toolBodies) ? (p.toolBodies as string[]) : []);
            setKeepTools(Boolean(p.keepTools));
        }
        if (isDressUp) {
            const pickedRefs = (p.edges as TopologyRef[] | undefined) ?? (p.faces as TopologyRef[] | undefined) ?? [];
            setRefs(pickedRefs);
            if (type === 'fillet') {
                setFilletRadius(p.radius !== undefined ? String(p.radius) : '1');
            }
            if (type === 'chamfer') {
                if (Array.isArray(p.distances)) {
                    setChamferMode('twoDistance');
                    setChamferDistance(String((p.distances as number[])[0] ?? 1));
                    setChamferDistance2(String((p.distances as number[])[1] ?? 1));
                } else if (p.angle !== undefined) {
                    setChamferMode('distanceAngle');
                    setChamferDistance(p.distance !== undefined ? String(p.distance) : '1');
                    setChamferAngle(String(p.angle));
                } else {
                    setChamferMode('symmetric');
                    setChamferDistance(p.distance !== undefined ? String(p.distance) : '1');
                }
            }
            if (type === 'draft') {
                setDraftAngle(p.angle !== undefined ? String(p.angle) : '5');
                const dir = p.pullDirection as [number, number, number] | undefined;
                setPullDirection(dir !== undefined ? [String(dir[0]), String(dir[1]), String(dir[2])] : ['0', '0', '1']);
                setNeutralPlaneRef(p.neutralPlane as TopologyRef | undefined);
                setNeutralPlanePicking(false);
            }
            if (type === 'shell') {
                const faces = (p.faces as TopologyRef[] | undefined) ?? [];
                setShellAllFaces(faces.length === 0);
                setShellThickness(p.thickness !== undefined ? String(p.thickness) : '1');
            }
        }
        if (isPattern || isHole) {
            if (isPattern) {
                setPatternSource(typeof p.source === 'string' ? p.source : '');
                setPatternScale(p.scale !== undefined ? String(p.scale) : '1');
            }
            if (type === 'linearPattern') {
                setPatternCount(p.count !== undefined ? String(p.count) : '2');
                setPatternSpacing(p.spacing !== undefined ? String(p.spacing) : '1');
                if (typeof p.axisDatumId === 'string') {
                    setLinearAxisDatumId(p.axisDatumId);
                } else {
                    setPatternAxis((p.axis as 'x' | 'y' | 'z') ?? 'z');
                    setLinearAxisDatumId('');
                }
            }
            if (type === 'circularPattern') {
                setPatternCount(p.count !== undefined ? String(p.count) : '2');
                setPatternAngle(p.angle !== undefined ? String(p.angle) : '360');
                if (typeof p.axisDatumId === 'string') {
                    setPatternAxisDatumId(p.axisDatumId);
                } else {
                    setPatternAxis((p.axis as 'x' | 'y' | 'z') ?? 'z');
                    setPatternAxisDatumId('');
                }
            }
            if (type === 'mirror') {
                if (typeof p.planeDatumId === 'string') {
                    setMirrorPlaneDatumId(p.planeDatumId);
                } else {
                    setMirrorPlane((p.plane as 'XY' | 'YZ' | 'XZ') ?? 'XY');
                    setMirrorPlaneDatumId('');
                }
            }
        }
        if (isHole) {
            setHoleFaceRef(p.face as TopologyRef | undefined);
            setHoleCenterUv(p.center as [number, number] | undefined);
            setHoleDiameter(p.diameter !== undefined ? String(p.diameter) : '1');
            setHoleDepth(p.depth !== undefined ? String(p.depth) : '');
            if (p.counterboreDiameter !== undefined || p.counterboreDepth !== undefined) {
                setHoleType('counterbore');
                setHoleCounterboreDiameter(String(p.counterboreDiameter ?? 1.5));
                setHoleCounterboreDepth(String(p.counterboreDepth ?? 0.5));
            } else if (p.countersinkDiameter !== undefined || p.countersinkAngle !== undefined) {
                setHoleType('countersink');
                setHoleCountersinkDiameter(String(p.countersinkDiameter ?? 1.5));
                setHoleCountersinkAngle(String(p.countersinkAngle ?? 82));
            } else if (p.counterdrillDiameter !== undefined || p.counterdrillDepth !== undefined) {
                setHoleType('counterdrill');
                setHoleCounterdrillDiameter(String(p.counterdrillDiameter ?? 1.5));
                setHoleCounterdrillDepth(String(p.counterdrillDepth ?? 0.5));
            } else {
                setHoleType('simple');
            }
            setHoleTaperAngle(p.taperAngle !== undefined ? String(p.taperAngle) : '');
            setHoleDrillPointAngle(p.drillPointAngle !== undefined ? String(p.drillPointAngle) : '');
            setHoleThread(p.thread === 'modeled' ? 'modeled' : p.thread === 'cosmetic' ? 'cosmetic' : 'none');
        }
        if (isCurveSweep) {
            setPathCurveId(typeof p.pathCurveId === 'string' ? p.pathCurveId : '');
            setSweepOrientation(p.orientation === 'fixedBinormal' ? 'fixedBinormal' : 'frenet');
            const binormal = p.binormal as [number, number, number] | undefined;
            setSweepBinormal(binormal !== undefined ? [String(binormal[0]), String(binormal[1]), String(binormal[2])] : ['0', '0', '1']);
            setPipeRadius(p.radius !== undefined ? String(p.radius) : '1');
        }
        if (isLoft) {
            const draft = loftDraftFromParams(p);
            setLoftSections([...draft.sectionSketchIds]);
            setLoftRuled(draft.ruled);
        }
        if (isHelicalSweep) {
            const draft = helicalSweepDraftFromParams(p);
            setHelixAxis(draft.axis);
            setHelixStartRadius(draft.startRadius);
            setHelixPitch(draft.pitch);
            setHelixTurns(draft.turns);
            setHelixLeftHanded(draft.leftHanded);
            setHelixOrientation(draft.orientation);
            setHelixBinormal([draft.binormal[0], draft.binormal[1], draft.binormal[2]]);
            setHelixSubtractive(p.subtractive === true);
        }
        if (isPrimitive) {
            const shape = p.shape as string | undefined;
            setPrimitiveShape(shape === 'cylinder' || shape === 'sphere' || shape === 'cone' || shape === 'torus' ? shape : 'box');
            const dims = Array.isArray(p.dimensions) ? (p.dimensions as unknown[]) : [];
            setPrimitiveDims([
                dims[0] !== undefined ? String(dims[0]) : '1',
                dims[1] !== undefined ? String(dims[1]) : '1',
                dims[2] !== undefined ? String(dims[2]) : '1'
            ]);
            setPrimitiveDatumId(typeof p.datumId === 'string' ? p.datumId : '');
            setPrimitiveSubtractive(p.subtractive === true);
        }
        if (isMultiTransform) {
            setMultiFirst(typeof p.first === 'string' ? p.first : '');
            setMultiSecond(typeof p.second === 'string' ? p.second : '');
        }
        if (isDefeature) {
            setRefs(Array.isArray(p.faces) ? (p.faces as TopologyRef[]) : []);
        }
        setError(undefined);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.editFeature]);

    // Hole wizard inputs shared by the submit path and the ghosted preview so
    // the two never drift apart (validation itself lives in the helper below).
    // Like `curves`/`sketches` above it is derived per render; the preview
    // effect lists the raw hole fields as deps.
    const holeInputs: HoleDialogInputs = {
        face: holeFaceRef,
        center: holeCenterUv,
        diameterText: holeDiameter,
        depthText: holeDepth,
        holeType,
        counterboreDiameterText: holeCounterboreDiameter,
        counterboreDepthText: holeCounterboreDepth,
        countersinkDiameterText: holeCountersinkDiameter,
        countersinkAngleText: holeCountersinkAngle,
        counterdrillDiameterText: holeCounterdrillDiameter,
        counterdrillDepthText: holeCounterdrillDepth,
        taperAngleText: holeTaperAngle,
        drillPointAngleText: holeDrillPointAngle,
        thread: holeThread
    };

    // Ghosted preview: a valid draft is debounced into a preview request the
    // widget builds through the normal geometry-service path; any invalid or
    // disabled state clears the preview.
    React.useEffect(() => {
        if (!previewEnabled || props.onPreviewChange === undefined) {
            props.onPreviewChange?.(undefined);
            return;
        }
        let request: FeaturePreviewRequest | undefined;
        if (isCurveSweep) {
            const validation = validateSweepPipeDraft(
                {
                    type: isPipe ? 'pipe' : 'sweep',
                    pathCurveId,
                    orientation: sweepOrientation,
                    binormal: sweepBinormal,
                    radius: pipeRadius
                },
                curves
            );
            if (validation.ok) {
                request = { type: isPipe ? 'pipe' : 'sweep', sketchId: props.sketchId, params: validation.params };
            }
        } else if (isLoft) {
            const validation = validateLoftDraft({ sectionSketchIds: loftSections, ruled: loftRuled }, sketches);
            if (validation.ok) {
                request = { type: 'loft', params: validation.params };
            }
        } else if (isHelicalSweep) {
            // Subtractive helix drafts need the live target body: no preview,
            // hint text in the dialog (same convention as non-blind ends).
            if (!helixSubtractive) {
                const validation = validateHelicalSweepDraft({
                    axis: helixAxis,
                    startRadius: helixStartRadius,
                    pitch: helixPitch,
                    turns: helixTurns,
                    leftHanded: helixLeftHanded,
                    orientation: helixOrientation,
                    binormal: helixBinormal
                });
                if (validation.ok) {
                    request = { type: 'helicalSweep', sketchId: props.sketchId, params: validation.params };
                }
            }
        } else if (isExtrude) {
            // Non-blind ends and up-to-body drafts are intentionally
            // un-previewable: they need the live body state no mini-document
            // can resolve, so the dialog surfaces hint text instead.
            if (extrudeEnd === 'blind' && upToBody === '') {
                const validation = validateExtrudeDraft({
                    type: type === 'pocket' ? 'pocket' : 'pad',
                    length,
                    axis,
                    symmetric,
                    twoSided,
                    end: extrudeEnd
                });
                if (validation.ok) {
                    // Subtractive drafts preview against their target body (the
                    // builder retargets onto it); additive pads preview standalone.
                    const previewBodyId = type === 'pocket' && bodyId !== NEW_BODY_SENTINEL ? bodyId : undefined;
                    request = {
                        type: type === 'pocket' ? 'pocket' : 'pad',
                        sketchId: props.sketchId,
                        params: validation.params,
                        ...(previewBodyId !== undefined ? { bodyId: previewBodyId } : {})
                    };
                }
            }
        } else if (isRevolve) {
            // Through-all ends need the live body state: no preview, hint
            // text in the dialog (same convention as non-blind extrude ends).
            if (revolveEnd === 'blind') {
                const validation = validateRevolveDraft({ angle, axis });
                if (validation.ok) {
                    const previewBodyId = type === 'groove' && bodyId !== NEW_BODY_SENTINEL ? bodyId : undefined;
                    request = {
                        type: type === 'groove' ? 'groove' : 'revolve',
                        sketchId: props.sketchId,
                        params: validation.params,
                        ...(previewBodyId !== undefined ? { bodyId: previewBodyId } : {})
                    };
                }
            }
        } else if (isPrimitive) {
            // Subtractive primitives cut the live target body: no preview,
            // hint text in the dialog (same convention as non-blind ends).
            if (!primitiveSubtractive) {
                const validation = validatePrimitiveDraft(
                    { shape: primitiveShape, dimensions: primitiveDims, datumId: primitiveDatumId },
                    doc?.datums
                );
                if (validation.ok) {
                    request = { type: 'primitive', params: validation.params };
                }
            }
        } else if (isDressUp) {
            // Dress-up refs resolve against the target body's history inside
            // the preview build; the refs themselves pass through opaquely.
            if (dressUpBodyId !== '') {
                if (type === 'fillet') {
                    const result = validateFilletDialogInputs(filletRadius, refs);
                    if (result.ok) {
                        request = { type: 'fillet', params: result.params, bodyId: dressUpBodyId };
                    }
                } else if (type === 'chamfer') {
                    const result = validateChamferDialogInputs(chamferMode, chamferDistance, chamferDistance2, chamferAngle, refs);
                    if (result.ok) {
                        request = { type: 'chamfer', params: result.params, bodyId: dressUpBodyId };
                    }
                } else if (type === 'draft') {
                    const result = validateDraftDialogInputs(draftAngle, pullDirection, refs, neutralPlaneRef);
                    if (result.ok) {
                        request = { type: 'draft', params: result.params, bodyId: dressUpBodyId };
                    }
                } else if (type === 'shell') {
                    const result = validateShellDialogInputs(shellThickness, refs, shellAllFaces);
                    if (result.ok) {
                        request = { type: 'shell', params: result.params, bodyId: dressUpBodyId };
                    }
                }
            }
        } else if (isHole) {
            if (holeBodyId !== '') {
                const result = validateHoleDialogInputs(holeInputs);
                if (result.ok) {
                    request = { type: 'hole', params: result.params, bodyId: holeBodyId };
                }
            }
        } else if (isBoolean) {
            const result = validateBooleanDialogInputs(targetBody, toolBodies);
            if (result.ok) {
                const booleanType = type === 'booleanCut' ? 'booleanCut' : type === 'booleanCommon' ? 'booleanCommon' : 'booleanFuse';
                request = { type: booleanType, params: { ...result.params, keepTools } };
            }
        }
        if (request === undefined) {
            props.onPreviewChange?.(undefined);
            return;
        }
        const timer = setTimeout(() => {
            props.onPreviewChange?.(request);
        }, 300);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        previewEnabled,
        pathCurveId,
        sweepOrientation,
        sweepBinormal,
        pipeRadius,
        loftSections,
        loftRuled,
        helixAxis,
        helixStartRadius,
        helixPitch,
        helixTurns,
        helixLeftHanded,
        helixOrientation,
        helixBinormal,
        helixSubtractive,
        length,
        axis,
        symmetric,
        twoSided,
        extrudeEnd,
        upToBody,
        bodyId,
        angle,
        revolveEnd,
        primitiveShape,
        primitiveDims,
        primitiveDatumId,
        primitiveSubtractive,
        dressUpBodyId,
        refs,
        filletRadius,
        chamferMode,
        chamferDistance,
        chamferDistance2,
        chamferAngle,
        draftAngle,
        pullDirection,
        neutralPlaneRef,
        shellThickness,
        shellAllFaces,
        holeBodyId,
        holeFaceRef,
        holeCenterUv,
        holeDiameter,
        holeDepth,
        holeType,
        holeCounterboreDiameter,
        holeCounterboreDepth,
        holeCountersinkDiameter,
        holeCountersinkAngle,
        holeCounterdrillDiameter,
        holeCounterdrillDepth,
        holeTaperAngle,
        holeDrillPointAngle,
        holeThread,
        targetBody,
        toolBodies,
        keepTools,
        props.sketchId,
        type
    ]);

    React.useEffect(() => {
        return () => props.onPreviewChange?.(undefined);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const addRef = React.useCallback((ref: TopologyRef) => {
        setRefs((prev) => [...prev, ref]);
    }, []);

    const setPrimitiveDim = React.useCallback((index: number, value: string) => {
        setPrimitiveDims((prev) => {
            const next: [string, string, string] = [prev[0], prev[1], prev[2]];
            if (index === 0) {
                next[0] = value;
            } else if (index === 1) {
                next[1] = value;
            } else {
                next[2] = value;
            }
            return next;
        });
    }, []);

    const primitiveDimLabels =
        primitiveShape === 'box'
            ? ['dx', 'dy', 'dz']
            : primitiveShape === 'sphere'
              ? ['Radius']
              : primitiveShape === 'torus'
                ? ['Major radius R', 'Minor radius r']
                : ['Radius', 'Height'];

    const selecting = type === 'fillet' || type === 'chamfer' ? 'edge' : 'face';
    const isPicking =
        props.dressUpPickMode !== undefined && props.dressUpPickMode.type === type && props.dressUpPickMode.selecting === selecting;

    // The dress-up face channel is shared between the draft faces list and the
    // neutral-plane slot; a pick that ends anywhere (viewport pick or
    // Escape-cancel) releases the neutral-plane slot.
    React.useEffect(() => {
        if (!isPicking) {
            setNeutralPlanePicking(false);
        }
    }, [isPicking]);

    const finish = (params: Record<string, unknown>): void => {
        if (props.editFeature !== undefined && props.onEditFeature !== undefined) {
            const { bodyId: _bodyId, label: _label, ...featureParams } = params;
            void _bodyId;
            void _label;
            props.onEditFeature(props.editFeature.id, featureParams as FeatureParams);
        } else {
            props.onConfirm(type, params as FeatureParams);
        }
    };

    const submit = (): void => {
        // Primitives sit on a datum, multiTransforms on pattern sources, and
        // defeatures on picked faces — none of them consume the selected sketch.
        if (
            !isBoolean &&
            !isDressUp &&
            !isPipe &&
            !isLoft &&
            !isPrimitive &&
            !isMultiTransform &&
            !isDefeature &&
            props.sketchId === undefined
        ) {
            setError('No sketch is selected.');
            return;
        }
        if (isBoolean) {
            const result = validateBooleanDialogInputs(targetBody, toolBodies);
            if (!result.ok) {
                setError(result.error);
                return;
            }
            finish({ targetBody: result.params.targetBody, toolBodies: result.params.toolBodies, keepTools });
            return;
        }
        if (isDressUp) {
            if (!dressUpBodyId) {
                setError('Select a target body.');
                return;
            }
            const params: Record<string, unknown> = { bodyId: dressUpBodyId, label };
            if (type === 'fillet') {
                const result = validateFilletDialogInputs(filletRadius, refs);
                if (!result.ok) {
                    setError(result.error);
                    return;
                }
                params.edges = result.params.edges;
                params.radius = result.params.radius;
            } else if (type === 'chamfer') {
                const result = validateChamferDialogInputs(chamferMode, chamferDistance, chamferDistance2, chamferAngle, refs);
                if (!result.ok) {
                    setError(result.error);
                    return;
                }
                params.edges = result.params.edges;
                if (result.params.distance !== undefined) {
                    params.distance = result.params.distance;
                }
                if (result.params.distances !== undefined) {
                    params.distances = result.params.distances;
                }
                if (result.params.angle !== undefined) {
                    params.angle = result.params.angle;
                }
            } else if (type === 'draft') {
                const result = validateDraftDialogInputs(draftAngle, pullDirection, refs, neutralPlaneRef);
                if (!result.ok) {
                    setError(result.error);
                    return;
                }
                params.faces = result.params.faces;
                params.angle = result.params.angle;
                params.pullDirection = result.params.pullDirection;
                // Optional neutral plane; omitted when unpicked.
                if (result.params.neutralPlane !== undefined) {
                    params.neutralPlane = result.params.neutralPlane;
                }
            } else if (type === 'shell') {
                const result = validateShellDialogInputs(shellThickness, refs, shellAllFaces);
                if (!result.ok) {
                    setError(result.error);
                    return;
                }
                params.faces = result.params.faces;
                params.thickness = result.params.thickness;
            }
            finish(params);
            return;
        }
        if (isPattern) {
            if (!patternSource) {
                setError('Select a source feature.');
                return;
            }
            const count = Number(patternCount);
            if (!Number.isInteger(count) || count < 1) {
                setError('Count must be a positive integer.');
                return;
            }
            const params: Record<string, unknown> = { source: patternSource, bodyId, label };
            // Per-instance scale about each instance's bbox center.
            const scaleText = patternScale.trim();
            if (scaleText !== '') {
                const scale = Number(scaleText);
                if (!Number.isFinite(scale) || scale <= 0) {
                    setError('Scale must be a positive finite number.');
                    return;
                }
                // 1 (the default) is today's behavior exactly — omit it.
                if (scale !== 1) {
                    params.scale = scale;
                }
            }
            if (type === 'linearPattern') {
                const spacing = Number(patternSpacing);
                if (!Number.isFinite(spacing) || spacing === 0) {
                    setError('Spacing must be a non-zero finite number.');
                    return;
                }
                params.count = count;
                params.spacing = spacing;
                // Datum axis mirrors the circular-pattern contract: the two
                // are mutually exclusive, blank means the coordinate axis.
                if (linearAxisDatumId) {
                    params.axisDatumId = linearAxisDatumId;
                } else {
                    params.axis = patternAxis;
                }
            } else if (type === 'circularPattern') {
                const angle = Number(patternAngle);
                if (!Number.isFinite(angle) || angle <= 0 || angle > 360) {
                    setError('Angle must be in (0, 360] degrees.');
                    return;
                }
                params.count = count;
                params.angle = angle;
                if (patternAxisDatumId) {
                    params.axisDatumId = patternAxisDatumId;
                } else {
                    params.axis = patternAxis;
                }
            } else {
                // mirror
                if (mirrorPlaneDatumId) {
                    params.planeDatumId = mirrorPlaneDatumId;
                } else {
                    params.plane = mirrorPlane;
                }
            }
            finish(params);
            return;
        }
        if (isHole) {
            if (!holeBodyId) {
                setError('Select a target body.');
                return;
            }
            const holeResult = validateHoleDialogInputs(holeInputs);
            if (!holeResult.ok) {
                setError(holeResult.error);
                return;
            }
            // Omitted drill point = flat bottom = today's behavior exactly.
            // Thread presets are none/cosmetic/modeled (modeled gated to
            // simple blind holes in the shared validator above).
            finish({ ...holeResult.params, bodyId: holeBodyId, label });
            return;
        }
        if (isCurveSweep) {
            const result = validateSweepPipeDraft(
                {
                    type: isPipe ? 'pipe' : 'sweep',
                    pathCurveId,
                    orientation: sweepOrientation,
                    binormal: sweepBinormal,
                    radius: pipeRadius
                },
                curves
            );
            if (!result.ok) {
                setError(result.error);
                return;
            }
            const effectiveBodyId = bodyId === NEW_BODY_SENTINEL ? undefined : bodyId;
            finish({ ...result.params, bodyId: effectiveBodyId, label });
            return;
        }
        if (isLoft) {
            const result = validateLoftDraft({ sectionSketchIds: loftSections, ruled: loftRuled }, sketches);
            if (!result.ok) {
                setError(result.error);
                return;
            }
            const effectiveBodyId = bodyId === NEW_BODY_SENTINEL ? undefined : bodyId;
            finish({ ...result.params, bodyId: effectiveBodyId, label });
            return;
        }
        if (isHelicalSweep) {
            const result = validateHelicalSweepDraft({
                axis: helixAxis,
                startRadius: helixStartRadius,
                pitch: helixPitch,
                turns: helixTurns,
                leftHanded: helixLeftHanded,
                orientation: helixOrientation,
                binormal: helixBinormal
            });
            if (!result.ok) {
                setError(result.error);
                return;
            }
            const effectiveBodyId = bodyId === NEW_BODY_SENTINEL ? undefined : bodyId;
            // A subtractive helix cuts the target body, so it needs one.
            if (helixSubtractive && effectiveBodyId === undefined) {
                setError('A subtractive helical sweep needs an existing target body.');
                return;
            }
            const helixParams: Record<string, unknown> = { ...result.params };
            if (helixSubtractive) {
                helixParams.subtractive = true;
            }
            finish({ ...helixParams, bodyId: effectiveBodyId, label });
            return;
        }
        if (isPrimitive) {
            const arity = primitiveShape === 'box' ? 3 : primitiveShape === 'sphere' ? 1 : 2;
            const dims = primitiveDims.slice(0, arity).map((d) => Number(d));
            if (dims.some((d) => !Number.isFinite(d) || d <= 0)) {
                setError('Dimensions must be positive finite numbers.');
                return;
            }
            const datumId = primitiveDatumId.trim();
            if (datumId !== '' && (doc?.datums ?? []).every((d) => d.id !== datumId)) {
                setError(`Unknown datum '${datumId}'.`);
                return;
            }
            const effectiveBodyId = bodyId === NEW_BODY_SENTINEL ? undefined : bodyId;
            const params: Record<string, unknown> = {
                shape: primitiveShape,
                dimensions: dims,
                bodyId: effectiveBodyId,
                label
            };
            // Omitted datumId = datum-xy default.
            if (datumId !== '') {
                params.datumId = datumId;
            }
            // A subtractive primitive cuts the target body, so it needs one.
            if (primitiveSubtractive) {
                if (effectiveBodyId === undefined) {
                    setError('A subtractive primitive needs an existing target body.');
                    return;
                }
                params.subtractive = true;
            }
            finish(params);
            return;
        }
        if (isMultiTransform) {
            if (multiFirst === '' || multiSecond === '') {
                setError('Select two source pattern features.');
                return;
            }
            if (multiFirst === multiSecond) {
                setError('The two multiTransform sources must be different features.');
                return;
            }
            const features = doc?.features ?? [];
            const first = features.find((f) => f.id === multiFirst);
            const second = features.find((f) => f.id === multiSecond);
            if (first === undefined || second === undefined) {
                setError('Select two source pattern features.');
                return;
            }
            if (first.body !== second.body) {
                setError('Both multiTransform sources must be on the same body.');
                return;
            }
            if (features.indexOf(first) > features.indexOf(second)) {
                setError('The first source must come earlier in document order than the second.');
                return;
            }
            const effectiveBodyId = bodyId === NEW_BODY_SENTINEL ? undefined : bodyId;
            if (effectiveBodyId !== undefined && effectiveBodyId !== first.body) {
                setError('The multiTransform body must match the body of its sources.');
                return;
            }
            finish({ first: multiFirst, second: multiSecond, bodyId: effectiveBodyId ?? first.body, label });
            return;
        }
        if (isDefeature) {
            if (!dressUpBodyId) {
                setError('Select a target body.');
                return;
            }
            if (refs.length === 0) {
                setError('Select at least one face for Defeature.');
                return;
            }
            finish({ faces: refs, bodyId: dressUpBodyId, label });
            return;
        }
        if (isExtrude) {
            // Length is required iff blind; symmetric/twoSided split
            // it equally both ways and are blind-only.
            if (extrudeEnd !== 'blind' && symmetric) {
                setError('Symmetric is only valid with a blind end.');
                return;
            }
            if (extrudeEnd !== 'blind' && twoSided) {
                setError('Two-sided is only valid with a blind end.');
                return;
            }
            const effectiveBodyId = bodyId === NEW_BODY_SENTINEL ? undefined : bodyId;
            const params: Record<string, unknown> = { axis, symmetric, bodyId: effectiveBodyId, label };
            if (extrudeEnd !== 'blind') {
                params.end = extrudeEnd;
            } else {
                const value = Number(length);
                if (!Number.isFinite(value) || value <= 0) {
                    setError('Length must be a positive number.');
                    return;
                }
                params.length = value;
            }
            if (twoSided) {
                params.twoSided = true;
            }
            // Optional up-to-body limit (blank = none); the backend resolves
            // the named body against the live document. Mutually exclusive
            // with the Up to Face end per the schema contract.
            if (upToBody !== '') {
                if (extrudeEnd === 'upToFace') {
                    setError('Up-to body and Up to Face are mutually exclusive.');
                    return;
                }
                params.upToBody = upToBody;
            }
            if (extrudeEnd === 'upToFace') {
                if (upToFaceRef === undefined) {
                    setError('Pick a face in the viewport for Up to Face.');
                    return;
                }
                params.upToFace = upToFaceRef;
            }
            finish(params);
        } else if (isRevolve) {
            const value = Number(angle);
            if (!Number.isFinite(value) || value <= 0 || value > 360) {
                setError('Angle must be in (0, 360].');
                return;
            }
            const effectiveBodyId = bodyId === NEW_BODY_SENTINEL ? undefined : bodyId;
            // Blind stays omitted (today's behavior exactly); throughAll
            // spans the body like the pad end of the same name.
            finish({
                axis,
                angle: value,
                ...(revolveEnd !== 'blind' ? { end: revolveEnd } : {}),
                bodyId: effectiveBodyId,
                label
            });
        }
    };

    const bodySelector = (
        <NukeFormRow label="Body" className="cad-feature-dialog-row">
            <select value={bodyId} onChange={(e) => setBodyId(e.target.value)}>
                {type === 'pad' ||
                type === 'revolve' ||
                type === 'sweep' ||
                type === 'pipe' ||
                type === 'loft' ||
                type === 'helicalSweep' ||
                isPrimitive ? (
                    <option value={NEW_BODY_SENTINEL}>New body</option>
                ) : null}
                {bodies.map((b) => (
                    <option key={b.id} value={b.id}>
                        {b.name}
                    </option>
                ))}
            </select>
        </NukeFormRow>
    );

    const dressUpBodySelector = (
        <label className="cad-feature-dialog-row">
            Body
            <select value={dressUpBodyId} onChange={(e) => setDressUpBodyId(e.target.value)}>
                {bodies.map((b) => (
                    <option key={b.id} value={b.id}>
                        {b.name}
                    </option>
                ))}
            </select>
        </label>
    );

    const labelInput = (
        <NukeFormRow label="Label" className="cad-feature-dialog-row">
            <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} />
        </NukeFormRow>
    );

    const booleanBodySelectors = (
        <>
            <label className="cad-feature-dialog-row">
                Target body
                <select value={targetBody} onChange={(e) => setTargetBody(e.target.value)}>
                    {bodies.map((b) => (
                        <option key={b.id} value={b.id}>
                            {b.name}
                        </option>
                    ))}
                </select>
            </label>
            <label className="cad-feature-dialog-row">
                Tool bodies
                <select
                    multiple
                    value={toolBodies}
                    onChange={(e) => {
                        const options = Array.from(e.target.selectedOptions).map((o) => o.value);
                        setToolBodies(options);
                    }}
                >
                    {bodies
                        .filter((b) => b.id !== targetBody)
                        .map((b) => (
                            <option key={b.id} value={b.id}>
                                {b.name}
                            </option>
                        ))}
                </select>
            </label>
            <label className="cad-feature-dialog-row check">
                <input type="checkbox" checked={keepTools} onChange={(e) => setKeepTools(e.target.checked)} />
                Keep tool bodies
            </label>
        </>
    );

    const refList = (
        <div className="cad-feature-dialog-row vertical">
            <span className="cad-feature-dialog-label">
                {selecting === 'edge' ? 'Edges' : 'Faces'} ({refs.length})
            </span>
            <div className="cad-feature-dialog-refs">
                {refs.map((ref, index) => (
                    <div key={index} className="cad-feature-dialog-ref-row">
                        <span className="cad-feature-dialog-ref-kind">{ref.kind}</span>
                        <span className="cad-feature-dialog-ref-feature">{ref.featureId}</span>
                        <button className="theia-button secondary" onClick={() => setRefs((prev) => prev.filter((_, i) => i !== index))}>
                            <span className="codicon codicon-close" />
                        </button>
                    </div>
                ))}
            </div>
            <div className="cad-feature-dialog-actions">
                <button
                    className={`theia-button secondary ${isPicking ? 'active' : ''}`}
                    onClick={() => {
                        if (isPicking) {
                            props.onDressUpPickCancel();
                        } else {
                            props.onStartDressUpPick(type, selecting, addRef);
                        }
                    }}
                >
                    <span className="codicon codicon-target" /> {isPicking ? 'Cancel pick' : `Pick ${selecting}`}
                </button>
            </div>
        </div>
    );

    // A viewport pick (dress-up edges/faces, hole placement face, sweep path
    // curve) needs clicks and Escape to reach the viewport, so the dialog drops
    // its modal backdrop while a pick is active.
    const pickActive = isPicking || props.holePickMode === true || props.curvePickMode === true;

    // Extrude preview hint: the validator's reason when no preview builds
    // (non-blind ends, or blind ends with invalid numerics).
    const extrudePreviewValidation = isExtrude
        ? validateExtrudeDraft({
              type: type === 'pocket' ? 'pocket' : 'pad',
              length,
              axis,
              symmetric,
              twoSided,
              end: extrudeEnd
          })
        : undefined;

    // The dialog floats like the sketch chrome: drag by the header, double-click
    // or right-click the header to reset; clamping to the viewport comes free
    // because the backdrop's positioned ancestor is the viewport root.
    const drag = useDraggablePanel({ canDrag: NUKE_DIALOG_HEADER_TARGET, canResetFrom: NUKE_DIALOG_HEADER_TARGET });

    return (
        <NukeDialog
            title={props.editFeature !== undefined ? `Edit ${capitalize(type)}` : capitalize(type)}
            onClose={props.onCancel}
            modal={!pickActive}
            closeOnEscape={!pickActive}
            className={drag.position !== undefined ? 'nuke-dialog-dragged' : undefined}
            style={drag.style}
            rootProps={{ ref: drag.panelRef, ...drag.handleProps }}
            footer={
                <>
                    <button className="theia-button" onClick={submit}>
                        <span className="codicon codicon-check" /> {props.editFeature !== undefined ? 'Save' : 'Create'}
                    </button>
                    <button className="theia-button secondary" onClick={props.onCancel}>
                        <span className="codicon codicon-close" /> Cancel
                    </button>
                </>
            }
        >
            {error !== undefined && <div className="cad-feature-dialog-error">{error}</div>}
            {!isBoolean && !isDressUp && !isHole && bodySelector}
            {isDressUp && dressUpBodySelector}
            {isDressUp && type === 'fillet' && (
                <>
                    <label className="cad-feature-dialog-row">
                        Radius
                        <input type="number" value={filletRadius} onChange={(e) => setFilletRadius(e.target.value)} autoFocus />
                    </label>
                    {refList}
                    {props.onPreviewChange !== undefined && (
                        <label className="cad-feature-dialog-row check">
                            <input type="checkbox" checked={previewEnabled} onChange={(e) => setPreviewEnabled(e.target.checked)} />
                            Preview (ghosted build)
                        </label>
                    )}
                </>
            )}
            {isDressUp && type === 'chamfer' && (
                <>
                    <label className="cad-feature-dialog-row">
                        Mode
                        <select value={chamferMode} onChange={(e) => setChamferMode(e.target.value as ChamferMode)}>
                            <option value="symmetric">Symmetric distance</option>
                            <option value="twoDistance">Two distances</option>
                            <option value="distanceAngle">Distance + angle</option>
                        </select>
                    </label>
                    {chamferMode === 'symmetric' && (
                        <label className="cad-feature-dialog-row">
                            Distance
                            <input type="number" value={chamferDistance} onChange={(e) => setChamferDistance(e.target.value)} autoFocus />
                        </label>
                    )}
                    {chamferMode === 'twoDistance' && (
                        <>
                            <label className="cad-feature-dialog-row">
                                Distance 1
                                <input
                                    type="number"
                                    value={chamferDistance}
                                    onChange={(e) => setChamferDistance(e.target.value)}
                                    autoFocus
                                />
                            </label>
                            <label className="cad-feature-dialog-row">
                                Distance 2
                                <input type="number" value={chamferDistance2} onChange={(e) => setChamferDistance2(e.target.value)} />
                            </label>
                        </>
                    )}
                    {chamferMode === 'distanceAngle' && (
                        <>
                            <label className="cad-feature-dialog-row">
                                Distance
                                <input
                                    type="number"
                                    value={chamferDistance}
                                    onChange={(e) => setChamferDistance(e.target.value)}
                                    autoFocus
                                />
                            </label>
                            <label className="cad-feature-dialog-row">
                                Angle (°)
                                <input type="number" value={chamferAngle} onChange={(e) => setChamferAngle(e.target.value)} />
                            </label>
                        </>
                    )}
                    {refList}
                    {props.onPreviewChange !== undefined && (
                        <label className="cad-feature-dialog-row check">
                            <input type="checkbox" checked={previewEnabled} onChange={(e) => setPreviewEnabled(e.target.checked)} />
                            Preview (ghosted build)
                        </label>
                    )}
                </>
            )}
            {isDressUp && type === 'draft' && (
                <>
                    <label className="cad-feature-dialog-row">
                        Angle (°)
                        <input type="number" value={draftAngle} onChange={(e) => setDraftAngle(e.target.value)} autoFocus />
                    </label>
                    <label className="cad-feature-dialog-row">
                        Pull direction X
                        <input
                            type="number"
                            value={pullDirection[0]}
                            onChange={(e) => setPullDirection(([_, y, z]) => [e.target.value, y, z])}
                        />
                    </label>
                    <label className="cad-feature-dialog-row">
                        Pull direction Y
                        <input
                            type="number"
                            value={pullDirection[1]}
                            onChange={(e) => setPullDirection(([x, _, z]) => [x, e.target.value, z])}
                        />
                    </label>
                    <label className="cad-feature-dialog-row">
                        Pull direction Z
                        <input
                            type="number"
                            value={pullDirection[2]}
                            onChange={(e) => setPullDirection(([x, y, _]) => [x, y, e.target.value])}
                        />
                    </label>
                    <div className="cad-feature-dialog-row vertical">
                        <span className="cad-feature-dialog-label">
                            Neutral plane{' '}
                            {neutralPlaneRef !== undefined ? `(${neutralPlaneRef.featureId})` : '(none — pull direction only)'}
                        </span>
                        <div className="cad-feature-dialog-actions">
                            <button
                                className={`theia-button secondary ${isPicking && neutralPlanePicking ? 'active' : ''}`}
                                onClick={() => {
                                    if (isPicking && neutralPlanePicking) {
                                        props.onDressUpPickCancel();
                                    } else {
                                        setNeutralPlanePicking(true);
                                        props.onStartDressUpPick(type, 'face', (ref) => setNeutralPlaneRef(ref));
                                    }
                                }}
                            >
                                <span className="codicon codicon-target" />{' '}
                                {isPicking && neutralPlanePicking ? 'Cancel pick' : 'Pick neutral plane'}
                            </button>
                            {neutralPlaneRef !== undefined && (
                                <button className="theia-button secondary" onClick={() => setNeutralPlaneRef(undefined)}>
                                    <span className="codicon codicon-close" /> Clear
                                </button>
                            )}
                        </div>
                    </div>
                    {refList}
                    {props.onPreviewChange !== undefined && (
                        <label className="cad-feature-dialog-row check">
                            <input type="checkbox" checked={previewEnabled} onChange={(e) => setPreviewEnabled(e.target.checked)} />
                            Preview (ghosted build)
                        </label>
                    )}
                </>
            )}
            {isDressUp && type === 'shell' && (
                <>
                    <label className="cad-feature-dialog-row">
                        Thickness
                        <input type="number" value={shellThickness} onChange={(e) => setShellThickness(e.target.value)} autoFocus />
                    </label>
                    <label className="cad-feature-dialog-row check">
                        <input type="checkbox" checked={shellAllFaces} onChange={(e) => setShellAllFaces(e.target.checked)} />
                        Hollow all faces (closed shell)
                    </label>
                    {!shellAllFaces && refList}
                    {props.onPreviewChange !== undefined && (
                        <label className="cad-feature-dialog-row check">
                            <input type="checkbox" checked={previewEnabled} onChange={(e) => setPreviewEnabled(e.target.checked)} />
                            Preview (ghosted build)
                        </label>
                    )}
                </>
            )}
            {isExtrude && (
                <>
                    <NukeSection title="Dimensions">
                        <NukeFormRow
                            label="Length"
                            hint={extrudeEnd === 'blind' ? 'Model units' : 'Blind ends only'}
                            className="cad-feature-dialog-row"
                        >
                            <input
                                type="number"
                                value={length}
                                disabled={extrudeEnd !== 'blind'}
                                onChange={(e) => setLength(e.target.value)}
                                autoFocus
                            />
                        </NukeFormRow>
                        <NukeFormRow label="Direction" className="cad-feature-dialog-row">
                            <select value={axis} onChange={(e) => setAxis(e.target.value as 'x' | 'y' | 'z')}>
                                <option value="x">X</option>
                                <option value="y">Y</option>
                                <option value="z">Z</option>
                            </select>
                        </NukeFormRow>
                    </NukeSection>
                    <NukeSection title="End condition">
                        <NukeFormRow
                            label="End"
                            hint="First/Last span the body's intersections along the direction"
                            className="cad-feature-dialog-row"
                        >
                            <select
                                value={extrudeEnd}
                                onChange={(e) =>
                                    setExtrudeEnd(e.target.value as 'blind' | 'upToFirst' | 'upToLast' | 'upToFace' | 'throughAll')
                                }
                            >
                                <option value="blind">Blind</option>
                                <option value="upToFirst">Up to first</option>
                                <option value="upToLast">Up to last</option>
                                <option value="upToFace">Up to face</option>
                                <option value="throughAll">Through all</option>
                            </select>
                        </NukeFormRow>
                        {extrudeEnd === 'upToFace' && (
                            <div className="cad-feature-dialog-row vertical">
                                <span className="cad-feature-dialog-label">
                                    Limit face {upToFaceRef !== undefined ? `(${upToFaceRef.featureId})` : '(none)'}
                                </span>
                                <div className="cad-feature-dialog-actions">
                                    <button
                                        className={`theia-button secondary ${isPicking && isExtrude ? 'active' : ''}`}
                                        onClick={() => {
                                            if (isPicking) {
                                                props.onDressUpPickCancel();
                                            } else {
                                                props.onStartDressUpPick(type, 'face', (ref) => setUpToFaceRef(ref));
                                            }
                                        }}
                                    >
                                        <span className="codicon codicon-target" /> {isPicking && isExtrude ? 'Cancel pick' : 'Pick face'}
                                    </button>
                                    {upToFaceRef !== undefined && (
                                        <button className="theia-button secondary" onClick={() => setUpToFaceRef(undefined)}>
                                            <span className="codicon codicon-close" /> Clear
                                        </button>
                                    )}
                                </div>
                            </div>
                        )}
                    </NukeSection>
                    <NukeSection title="Options">
                        <NukeFormRow
                            label="Symmetric"
                            hint="Extends equally in both directions"
                            checkbox
                            className="cad-feature-dialog-row check"
                        >
                            <input type="checkbox" checked={symmetric} onChange={(e) => setSymmetric(e.target.checked)} />
                        </NukeFormRow>
                        <NukeFormRow
                            label="Two-sided"
                            hint="Splits a blind length equally both ways"
                            checkbox
                            className="cad-feature-dialog-row check"
                        >
                            <input type="checkbox" checked={twoSided} onChange={(e) => setTwoSided(e.target.checked)} />
                        </NukeFormRow>
                        <NukeFormRow label="Up-to body" hint="Blank = none" className="cad-feature-dialog-row">
                            <select value={upToBody} onChange={(e) => setUpToBody(e.target.value)}>
                                <option value="">None</option>
                                {bodies.map((b) => (
                                    <option key={b.id} value={b.id}>
                                        {b.name}
                                    </option>
                                ))}
                            </select>
                        </NukeFormRow>
                    </NukeSection>
                    {props.onPreviewChange !== undefined && (
                        <label className="cad-feature-dialog-row check">
                            <input
                                type="checkbox"
                                checked={previewEnabled}
                                disabled={extrudeEnd !== 'blind' || upToBody !== ''}
                                onChange={(e) => setPreviewEnabled(e.target.checked)}
                            />
                            Preview (ghosted build)
                        </label>
                    )}
                    {extrudePreviewValidation !== undefined && !extrudePreviewValidation.ok && (
                        <span className="cad-feature-dialog-label">{extrudePreviewValidation.error}</span>
                    )}
                    {extrudeEnd !== 'blind' && <span className="cad-feature-dialog-label">Preview is only available for blind ends.</span>}
                    {upToBody !== '' && (
                        <span className="cad-feature-dialog-label">
                            Up-to-body drafts need the live body state and cannot be previewed.
                        </span>
                    )}
                </>
            )}
            {isRevolve && (
                <>
                    <label className="cad-feature-dialog-row">
                        Axis
                        <select value={axis} onChange={(e) => setAxis(e.target.value as 'x' | 'y' | 'z')}>
                            <option value="x">X</option>
                            <option value="y">Y</option>
                            <option value="z">Z</option>
                        </select>
                    </label>
                    <label className="cad-feature-dialog-row">
                        Angle (°)
                        <input type="number" value={angle} onChange={(e) => setAngle(e.target.value)} autoFocus />
                    </label>
                    <label className="cad-feature-dialog-row">
                        End
                        <select value={revolveEnd} onChange={(e) => setRevolveEnd(e.target.value as 'blind' | 'throughAll')}>
                            <option value="blind">Blind</option>
                            <option value="throughAll">Through all</option>
                        </select>
                    </label>
                    {props.onPreviewChange !== undefined && (
                        <label className="cad-feature-dialog-row check">
                            <input
                                type="checkbox"
                                checked={previewEnabled}
                                disabled={revolveEnd !== 'blind'}
                                onChange={(e) => setPreviewEnabled(e.target.checked)}
                            />
                            Preview (ghosted build)
                        </label>
                    )}
                    {revolveEnd !== 'blind' && (
                        <span className="cad-feature-dialog-label">Through-all ends need the live body state and cannot be previewed.</span>
                    )}
                </>
            )}
            {isCurveSweep && (
                <>
                    <div className="cad-feature-dialog-row vertical">
                        {' '}
                        <span className="cad-feature-dialog-label">
                            Path curve{' '}
                            {pathCurveId !== '' ? `(${curves.find((c) => c.id === pathCurveId)?.name ?? pathCurveId})` : '(none)'}
                        </span>
                        <div className="cad-feature-dialog-actions">
                            <select value={pathCurveId} onChange={(e) => setPathCurveId(e.target.value)}>
                                <option value="">Select a curve…</option>
                                {curves.map((c) => (
                                    <option key={c.id} value={c.id}>
                                        {c.name}
                                    </option>
                                ))}
                            </select>
                            <button
                                className={`theia-button secondary ${props.curvePickMode === true ? 'active' : ''}`}
                                onClick={() => {
                                    if (props.curvePickMode === true) {
                                        props.onCurvePickCancel();
                                    } else {
                                        props.onStartCurvePick((curveId) => setPathCurveId(curveId));
                                    }
                                }}
                            >
                                <span className="codicon codicon-target" />{' '}
                                {props.curvePickMode === true ? 'Cancel pick' : 'Pick in viewport'}
                            </button>
                        </div>
                    </div>
                    <label className="cad-feature-dialog-row">
                        Orientation
                        <select
                            value={sweepOrientation}
                            onChange={(e) => setSweepOrientation(e.target.value as 'frenet' | 'fixedBinormal')}
                        >
                            <option value="frenet">Frenet (follow path)</option>
                            <option value="fixedBinormal">Fixed binormal</option>
                        </select>
                    </label>
                    {sweepOrientation === 'fixedBinormal' && (
                        <>
                            <label className="cad-feature-dialog-row">
                                Binormal X
                                <input
                                    type="number"
                                    value={sweepBinormal[0]}
                                    onChange={(e) => setSweepBinormal(([_, y, z]) => [e.target.value, y, z])}
                                />
                            </label>
                            <label className="cad-feature-dialog-row">
                                Binormal Y
                                <input
                                    type="number"
                                    value={sweepBinormal[1]}
                                    onChange={(e) => setSweepBinormal(([x, _, z]) => [x, e.target.value, z])}
                                />
                            </label>
                            <label className="cad-feature-dialog-row">
                                Binormal Z
                                <input
                                    type="number"
                                    value={sweepBinormal[2]}
                                    onChange={(e) => setSweepBinormal(([x, y, _]) => [x, y, e.target.value])}
                                />
                            </label>
                        </>
                    )}
                    {isPipe && (
                        <label className="cad-feature-dialog-row">
                            Radius
                            <input type="number" value={pipeRadius} onChange={(e) => setPipeRadius(e.target.value)} autoFocus />
                        </label>
                    )}
                    {props.onPreviewChange !== undefined && (
                        <label className="cad-feature-dialog-row check">
                            <input type="checkbox" checked={previewEnabled} onChange={(e) => setPreviewEnabled(e.target.checked)} />
                            Preview (ghosted build)
                        </label>
                    )}
                </>
            )}
            {isLoft && (
                <>
                    <div className="cad-feature-dialog-row vertical">
                        <span className="cad-feature-dialog-label">Sections ({loftSections.length})</span>
                        <div className="cad-feature-dialog-refs">
                            {loftSections.map((sectionSketchId, index) => (
                                <div key={sectionSketchId} className="cad-feature-dialog-section-row">
                                    <span className="cad-feature-dialog-section-index">{index + 1}</span>
                                    <span className="cad-feature-dialog-ref-feature">
                                        {sketches.find((s) => s.id === sectionSketchId)?.name ?? sectionSketchId}
                                    </span>
                                    <Tooltip content="Move up" position="left">
                                        <button
                                            className="theia-button secondary"
                                            disabled={index === 0}
                                            onClick={() => setLoftSections((prev) => [...moveLoftSection(prev, index, 'up')])}
                                        >
                                            <span className="codicon codicon-arrow-up" />
                                        </button>
                                    </Tooltip>
                                    <Tooltip content="Move down" position="left">
                                        <button
                                            className="theia-button secondary"
                                            disabled={index === loftSections.length - 1}
                                            onClick={() => setLoftSections((prev) => [...moveLoftSection(prev, index, 'down')])}
                                        >
                                            <span className="codicon codicon-arrow-down" />
                                        </button>
                                    </Tooltip>
                                    <Tooltip content="Remove section" position="left">
                                        <button
                                            className="theia-button secondary"
                                            onClick={() => setLoftSections((prev) => prev.filter((sid) => sid !== sectionSketchId))}
                                        >
                                            <span className="codicon codicon-close" />
                                        </button>
                                    </Tooltip>
                                </div>
                            ))}
                            {loftSections.length === 0 && <span className="cad-feature-dialog-label">No sections yet.</span>}
                        </div>
                        <div className="cad-feature-dialog-actions">
                            <select
                                value=""
                                onChange={(e) => {
                                    const value = e.target.value;
                                    if (value.length > 0 && !loftSections.includes(value)) {
                                        setLoftSections((prev) => [...prev, value]);
                                    }
                                }}
                            >
                                <option value="">Add section…</option>
                                {sketches
                                    .filter((s) => !loftSections.includes(s.id))
                                    .map((s) => (
                                        <option key={s.id} value={s.id}>
                                            {s.name}
                                        </option>
                                    ))}
                            </select>
                        </div>
                    </div>
                    <label className="cad-feature-dialog-row check">
                        <input type="checkbox" checked={loftRuled} onChange={(e) => setLoftRuled(e.target.checked)} />
                        Ruled (straight skin between sections; unchecked = smooth)
                    </label>
                    {props.onPreviewChange !== undefined && (
                        <label className="cad-feature-dialog-row check">
                            <input type="checkbox" checked={previewEnabled} onChange={(e) => setPreviewEnabled(e.target.checked)} />
                            Preview (ghosted build)
                        </label>
                    )}
                </>
            )}
            {isHelicalSweep && (
                <>
                    <label className="cad-feature-dialog-row">
                        Axis
                        <select
                            value={helixAxis}
                            onChange={(e) => {
                                const axis = e.target.value as HelixAxis;
                                setHelixAxis(axis);
                                // Prefill the fixed-binormal vector with the new axis unit.
                                setHelixBinormal(helixAxisUnit(axis).map((v) => String(v)) as [string, string, string]);
                            }}
                        >
                            <option value="X">X</option>
                            <option value="Y">Y</option>
                            <option value="Z">Z</option>
                        </select>
                    </label>
                    <label className="cad-feature-dialog-row">
                        Start radius
                        <input type="number" value={helixStartRadius} onChange={(e) => setHelixStartRadius(e.target.value)} autoFocus />
                    </label>
                    <label className="cad-feature-dialog-row">
                        Pitch
                        <input type="number" value={helixPitch} onChange={(e) => setHelixPitch(e.target.value)} />
                    </label>
                    <label className="cad-feature-dialog-row">
                        Turns
                        <input type="number" value={helixTurns} onChange={(e) => setHelixTurns(e.target.value)} />
                    </label>
                    <label className="cad-feature-dialog-row check">
                        <input type="checkbox" checked={helixLeftHanded} onChange={(e) => setHelixLeftHanded(e.target.checked)} />
                        Left-handed
                    </label>
                    <label className="cad-feature-dialog-row">
                        Orientation
                        <select
                            value={helixOrientation}
                            onChange={(e) => setHelixOrientation(e.target.value as 'frenet' | 'fixedBinormal')}
                        >
                            <option value="fixedBinormal">Fixed binormal (no roll)</option>
                            <option value="frenet">Frenet (follow path)</option>
                        </select>
                    </label>
                    {helixOrientation === 'fixedBinormal' && (
                        <>
                            <label className="cad-feature-dialog-row">
                                Binormal X
                                <input
                                    type="number"
                                    value={helixBinormal[0]}
                                    onChange={(e) => setHelixBinormal(([_, y, z]) => [e.target.value, y, z])}
                                />
                            </label>
                            <label className="cad-feature-dialog-row">
                                Binormal Y
                                <input
                                    type="number"
                                    value={helixBinormal[1]}
                                    onChange={(e) => setHelixBinormal(([x, _, z]) => [x, e.target.value, z])}
                                />
                            </label>
                            <label className="cad-feature-dialog-row">
                                Binormal Z
                                <input
                                    type="number"
                                    value={helixBinormal[2]}
                                    onChange={(e) => setHelixBinormal(([x, y, _]) => [x, y, e.target.value])}
                                />
                            </label>
                        </>
                    )}
                    <label className="cad-feature-dialog-row check">
                        <input type="checkbox" checked={helixSubtractive} onChange={(e) => setHelixSubtractive(e.target.checked)} />
                        Subtractive (cut from the target body)
                    </label>
                    {props.onPreviewChange !== undefined && (
                        <label className="cad-feature-dialog-row check">
                            <input
                                type="checkbox"
                                checked={previewEnabled}
                                disabled={helixSubtractive}
                                onChange={(e) => setPreviewEnabled(e.target.checked)}
                            />
                            Preview (ghosted build)
                        </label>
                    )}
                    {helixSubtractive && (
                        <span className="cad-feature-dialog-label">
                            Subtractive helix drafts need the live target body and cannot be previewed.
                        </span>
                    )}
                </>
            )}
            {isPattern && (
                <>
                    <label className="cad-feature-dialog-row">
                        Source feature
                        <select value={patternSource} onChange={(e) => setPatternSource(e.target.value)}>
                            {sourceFeatures.map((f) => (
                                <option key={f.id} value={f.id}>
                                    {f.name}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="cad-feature-dialog-row">
                        Scale (blank/1 = unscaled)
                        <input type="number" value={patternScale} onChange={(e) => setPatternScale(e.target.value)} />
                    </label>
                    {type !== 'mirror' && (
                        <label className="cad-feature-dialog-row">
                            Count
                            <input type="number" value={patternCount} onChange={(e) => setPatternCount(e.target.value)} autoFocus />
                        </label>
                    )}
                    {type === 'linearPattern' && (
                        <>
                            <label className="cad-feature-dialog-row">
                                Spacing
                                <input type="number" value={patternSpacing} onChange={(e) => setPatternSpacing(e.target.value)} />
                            </label>
                            <label className="cad-feature-dialog-row">
                                Axis
                                <select value={patternAxis} onChange={(e) => setPatternAxis(e.target.value as 'x' | 'y' | 'z')}>
                                    <option value="x">X</option>
                                    <option value="y">Y</option>
                                    <option value="z">Z</option>
                                </select>
                            </label>
                            <label className="cad-feature-dialog-row">
                                Axis datum (optional)
                                <select value={linearAxisDatumId} onChange={(e) => setLinearAxisDatumId(e.target.value)}>
                                    <option value="">Coordinate axis</option>
                                    {datumOptions.map((d) => (
                                        <option key={d.id} value={d.id}>
                                            {d.name}
                                        </option>
                                    ))}
                                </select>
                            </label>
                        </>
                    )}
                    {type === 'circularPattern' && (
                        <>
                            <label className="cad-feature-dialog-row">
                                Angle (°)
                                <input type="number" value={patternAngle} onChange={(e) => setPatternAngle(e.target.value)} />
                            </label>
                            <label className="cad-feature-dialog-row">
                                Axis
                                <select value={patternAxis} onChange={(e) => setPatternAxis(e.target.value as 'x' | 'y' | 'z')}>
                                    <option value="x">X</option>
                                    <option value="y">Y</option>
                                    <option value="z">Z</option>
                                </select>
                            </label>
                            <label className="cad-feature-dialog-row">
                                Axis datum (optional)
                                <select value={patternAxisDatumId} onChange={(e) => setPatternAxisDatumId(e.target.value)}>
                                    <option value="">Coordinate axis</option>
                                    {datumOptions.map((d) => (
                                        <option key={d.id} value={d.id}>
                                            {d.name}
                                        </option>
                                    ))}
                                </select>
                            </label>
                        </>
                    )}
                    {type === 'mirror' && (
                        <>
                            <label className="cad-feature-dialog-row">
                                Plane
                                <select value={mirrorPlane} onChange={(e) => setMirrorPlane(e.target.value as 'XY' | 'YZ' | 'XZ')}>
                                    <option value="XY">XY</option>
                                    <option value="YZ">YZ</option>
                                    <option value="XZ">XZ</option>
                                </select>
                            </label>
                            <label className="cad-feature-dialog-row">
                                Plane datum (optional)
                                <select value={mirrorPlaneDatumId} onChange={(e) => setMirrorPlaneDatumId(e.target.value)}>
                                    <option value="">Coordinate plane</option>
                                    {datumOptions.map((d) => (
                                        <option key={d.id} value={d.id}>
                                            {d.name}
                                        </option>
                                    ))}
                                </select>
                            </label>
                        </>
                    )}
                </>
            )}
            {isHole && (
                <>
                    <label className="cad-feature-dialog-row">
                        Body
                        <select value={holeBodyId} onChange={(e) => setHoleBodyId(e.target.value)}>
                            {bodies.map((b) => (
                                <option key={b.id} value={b.id}>
                                    {b.name}
                                </option>
                            ))}
                        </select>
                    </label>
                    <div className="cad-feature-dialog-row vertical">
                        <span className="cad-feature-dialog-label">
                            Placement face {holeFaceRef !== undefined ? `(${holeFaceRef.featureId})` : '(none)'}
                        </span>
                        <div className="cad-feature-dialog-actions">
                            <button
                                className={`theia-button secondary ${props.holePickMode ? 'active' : ''}`}
                                onClick={() => {
                                    if (props.holePickMode) {
                                        props.onHolePickCancel();
                                    } else {
                                        props.onStartHolePick((ref, uv) => {
                                            setHoleFaceRef(ref);
                                            setHoleCenterUv(uv);
                                        });
                                    }
                                }}
                            >
                                <span className="codicon codicon-target" /> {props.holePickMode ? 'Cancel pick' : 'Pick face'}
                            </button>
                        </div>
                    </div>
                    <label className="cad-feature-dialog-row">
                        Diameter
                        <input type="number" value={holeDiameter} onChange={(e) => setHoleDiameter(e.target.value)} autoFocus />
                    </label>
                    <label className="cad-feature-dialog-row">
                        Type
                        <select
                            value={holeType}
                            onChange={(e) => setHoleType(e.target.value as 'simple' | 'counterbore' | 'countersink' | 'counterdrill')}
                        >
                            <option value="simple">Simple / through</option>
                            <option value="counterbore">Counterbore</option>
                            <option value="countersink">Countersink</option>
                            <option value="counterdrill">Counterdrill (stepped)</option>
                        </select>
                    </label>
                    {holeType === 'simple' && (
                        <label className="cad-feature-dialog-row">
                            Depth (blank = through)
                            <input type="number" value={holeDepth} onChange={(e) => setHoleDepth(e.target.value)} />
                        </label>
                    )}
                    {holeType === 'counterbore' && (
                        <>
                            <label className="cad-feature-dialog-row">
                                Counterbore diameter
                                <input
                                    type="number"
                                    value={holeCounterboreDiameter}
                                    onChange={(e) => setHoleCounterboreDiameter(e.target.value)}
                                />
                            </label>
                            <label className="cad-feature-dialog-row">
                                Counterbore depth
                                <input
                                    type="number"
                                    value={holeCounterboreDepth}
                                    onChange={(e) => setHoleCounterboreDepth(e.target.value)}
                                />
                            </label>
                        </>
                    )}
                    {holeType === 'countersink' && (
                        <>
                            <label className="cad-feature-dialog-row">
                                Countersink diameter
                                <input
                                    type="number"
                                    value={holeCountersinkDiameter}
                                    onChange={(e) => setHoleCountersinkDiameter(e.target.value)}
                                />
                            </label>
                            <label className="cad-feature-dialog-row">
                                Countersink angle (°)
                                <input
                                    type="number"
                                    value={holeCountersinkAngle}
                                    onChange={(e) => setHoleCountersinkAngle(e.target.value)}
                                />
                            </label>
                        </>
                    )}
                    {holeType === 'counterdrill' && (
                        <>
                            <label className="cad-feature-dialog-row">
                                Counterdrill diameter
                                <input
                                    type="number"
                                    value={holeCounterdrillDiameter}
                                    onChange={(e) => setHoleCounterdrillDiameter(e.target.value)}
                                />
                            </label>
                            <label className="cad-feature-dialog-row">
                                Counterdrill depth
                                <input
                                    type="number"
                                    value={holeCounterdrillDepth}
                                    onChange={(e) => setHoleCounterdrillDepth(e.target.value)}
                                />
                            </label>
                        </>
                    )}
                    <label className="cad-feature-dialog-row">
                        Taper angle ° (blank = straight)
                        <input type="number" value={holeTaperAngle} onChange={(e) => setHoleTaperAngle(e.target.value)} />
                    </label>
                    <label className="cad-feature-dialog-row">
                        Drill point ° (blank = flat)
                        <input type="number" value={holeDrillPointAngle} onChange={(e) => setHoleDrillPointAngle(e.target.value)} />
                    </label>
                    <label className="cad-feature-dialog-row">
                        Thread
                        <select value={holeThread} onChange={(e) => setHoleThread(e.target.value as 'none' | 'cosmetic' | 'modeled')}>
                            <option value="none">None</option>
                            <option value="cosmetic">Cosmetic</option>
                            <option value="modeled">Modeled</option>
                        </select>
                    </label>
                    {holeThread === 'modeled' && (holeType !== 'simple' || holeDepth.trim() === '' || holeTaperAngle.trim() !== '') && (
                        <span className="cad-feature-dialog-label">
                            Modeled threads require a simple blind hole (set a depth, no taper).
                        </span>
                    )}
                    {props.onPreviewChange !== undefined && (
                        <label className="cad-feature-dialog-row check">
                            <input type="checkbox" checked={previewEnabled} onChange={(e) => setPreviewEnabled(e.target.checked)} />
                            Preview (ghosted build)
                        </label>
                    )}
                </>
            )}
            {isDefeature && dressUpBodySelector}
            {isDefeature && refList}
            {isPrimitive && (
                <>
                    <NukeFormRow label="Shape" className="cad-feature-dialog-row">
                        <select
                            value={primitiveShape}
                            onChange={(e) => setPrimitiveShape(e.target.value as 'box' | 'cylinder' | 'sphere' | 'cone' | 'torus')}
                            autoFocus
                        >
                            <option value="box">Box (dx, dy, dz about datum origin)</option>
                            <option value="cylinder">Cylinder (radius, height along normal)</option>
                            <option value="sphere">Sphere (radius at origin)</option>
                            <option value="cone">Cone (radius, height along normal)</option>
                            <option value="torus">Torus (major R, minor r in plane)</option>
                        </select>
                    </NukeFormRow>
                    {primitiveDimLabels.map((dimLabel, index) => (
                        <NukeFormRow key={dimLabel} label={dimLabel} hint="Model units" className="cad-feature-dialog-row">
                            <input type="number" value={primitiveDims[index]} onChange={(e) => setPrimitiveDim(index, e.target.value)} />
                        </NukeFormRow>
                    ))}
                    <NukeFormRow label="Datum" hint="Blank = datum-xy" className="cad-feature-dialog-row">
                        <select value={primitiveDatumId} onChange={(e) => setPrimitiveDatumId(e.target.value)}>
                            <option value="">datum-xy (default)</option>
                            {datumOptions.map((d) => (
                                <option key={d.id} value={d.id}>
                                    {d.name}
                                </option>
                            ))}
                        </select>
                    </NukeFormRow>
                    <label className="cad-feature-dialog-row check">
                        <input type="checkbox" checked={primitiveSubtractive} onChange={(e) => setPrimitiveSubtractive(e.target.checked)} />
                        Subtractive (cut from the target body)
                    </label>
                    {props.onPreviewChange !== undefined && (
                        <label className="cad-feature-dialog-row check">
                            <input
                                type="checkbox"
                                checked={previewEnabled}
                                disabled={primitiveSubtractive}
                                onChange={(e) => setPreviewEnabled(e.target.checked)}
                            />
                            Preview (ghosted build)
                        </label>
                    )}
                    {primitiveSubtractive && (
                        <span className="cad-feature-dialog-label">
                            Subtractive primitives need the live target body and cannot be previewed.
                        </span>
                    )}
                </>
            )}
            {isMultiTransform && (
                <>
                    <label className="cad-feature-dialog-row">
                        First source (earlier)
                        <select value={multiFirst} onChange={(e) => setMultiFirst(e.target.value)} autoFocus>
                            <option value="">Select a pattern…</option>
                            {patternLikeSources.map((f) => (
                                <option key={f.id} value={f.id}>
                                    {f.name}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="cad-feature-dialog-row">
                        Second source (later)
                        <select value={multiSecond} onChange={(e) => setMultiSecond(e.target.value)}>
                            <option value="">Select a pattern…</option>
                            {patternLikeSources.map((f) => (
                                <option key={f.id} value={f.id}>
                                    {f.name}
                                </option>
                            ))}
                        </select>
                    </label>
                </>
            )}
            {isBoolean && booleanBodySelectors}
            {isBoolean && props.onPreviewChange !== undefined && (
                <label className="cad-feature-dialog-row check">
                    <input type="checkbox" checked={previewEnabled} onChange={(e) => setPreviewEnabled(e.target.checked)} />
                    Preview (ghosted build)
                </label>
            )}
            {!isBoolean && labelInput}
        </NukeDialog>
    );
}

function capitalize(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Validated dialog inputs shared by a submit path and its ghosted preview. */
type DialogValidation<T> = { readonly ok: true; readonly params: T } | { readonly ok: false; readonly error: string };

/** Fillet numerics plus the picked edges (refs pass through opaquely). */
function validateFilletDialogInputs(radiusText: string, refs: TopologyRef[]): DialogValidation<FilletParams> {
    if (refs.length === 0) {
        return { ok: false, error: 'Select at least one edge for Fillet.' };
    }
    const radius = Number(radiusText);
    if (!Number.isFinite(radius) || radius <= 0) {
        return { ok: false, error: 'Radius must be a positive number.' };
    }
    return { ok: true, params: { edges: refs, radius } };
}

/** Chamfer numerics plus the picked edges (refs pass through opaquely). */
function validateChamferDialogInputs(
    mode: ChamferMode,
    distanceText: string,
    distance2Text: string,
    angleText: string,
    refs: TopologyRef[]
): DialogValidation<FilletParams> {
    if (refs.length === 0) {
        return { ok: false, error: 'Select at least one edge for Chamfer.' };
    }
    if (mode === 'symmetric') {
        const distance = Number(distanceText);
        if (!Number.isFinite(distance) || distance <= 0) {
            return { ok: false, error: 'Distance must be a positive number.' };
        }
        return { ok: true, params: { edges: refs, distance } };
    }
    if (mode === 'twoDistance') {
        const d1 = Number(distanceText);
        const d2 = Number(distance2Text);
        if (!Number.isFinite(d1) || d1 <= 0 || !Number.isFinite(d2) || d2 <= 0) {
            return { ok: false, error: 'Both distances must be positive numbers.' };
        }
        return { ok: true, params: { edges: refs, distances: [d1, d2] } };
    }
    const distance = Number(distanceText);
    const angle = Number(angleText);
    if (!Number.isFinite(distance) || distance <= 0) {
        return { ok: false, error: 'Distance must be a positive number.' };
    }
    if (!Number.isFinite(angle) || angle <= 0 || angle >= 90) {
        return { ok: false, error: 'Angle must be in (0, 90) degrees.' };
    }
    return { ok: true, params: { edges: refs, distance, angle } };
}

/** Draft numerics plus the picked faces (refs pass through opaquely). */
function validateDraftDialogInputs(
    angleText: string,
    pullDirection: readonly [string, string, string],
    refs: TopologyRef[],
    neutralPlaneRef: TopologyRef | undefined
): DialogValidation<DraftParams> {
    if (refs.length === 0) {
        return { ok: false, error: 'Select at least one face for Draft.' };
    }
    const angle = Number(angleText);
    if (!Number.isFinite(angle) || angle <= -90 || angle >= 90) {
        return { ok: false, error: 'Draft angle must be in (-90, 90) degrees.' };
    }
    const dir: [number, number, number] = [Number(pullDirection[0]), Number(pullDirection[1]), Number(pullDirection[2])];
    if (!dir.every((v) => Number.isFinite(v)) || (dir[0] === 0 && dir[1] === 0 && dir[2] === 0)) {
        return { ok: false, error: 'Pull direction must be a non-zero [x, y, z] vector.' };
    }
    return {
        ok: true,
        params: { faces: refs, angle, pullDirection: dir, ...(neutralPlaneRef !== undefined ? { neutralPlane: neutralPlaneRef } : {}) }
    };
}

/** Shell numerics plus the picked faces (refs pass through opaquely). */
function validateShellDialogInputs(thicknessText: string, refs: TopologyRef[], allFaces: boolean): DialogValidation<ShellParams> {
    const thickness = Number(thicknessText);
    if (!Number.isFinite(thickness) || thickness <= 0) {
        return { ok: false, error: 'Thickness must be a positive number.' };
    }
    return { ok: true, params: { faces: allFaces ? [] : refs, thickness } };
}

/** String-state inputs of the hole wizard dialog. */
interface HoleDialogInputs {
    readonly face: TopologyRef | undefined;
    readonly center: [number, number] | undefined;
    readonly diameterText: string;
    readonly depthText: string;
    readonly holeType: 'simple' | 'counterbore' | 'countersink' | 'counterdrill';
    readonly counterboreDiameterText: string;
    readonly counterboreDepthText: string;
    readonly countersinkDiameterText: string;
    readonly countersinkAngleText: string;
    readonly counterdrillDiameterText: string;
    readonly counterdrillDepthText: string;
    readonly taperAngleText: string;
    readonly drillPointAngleText: string;
    readonly thread: 'none' | 'cosmetic' | 'modeled';
}

/**
 * Hole wizard validation shared by the submit path and the ghosted preview.
 *
 * Returns the feature params without `bodyId`/`label` (the submit path adds
 * those); the preview carries the target body's history instead.
 */
function validateHoleDialogInputs(inputs: HoleDialogInputs): DialogValidation<HoleParams> {
    if (inputs.face === undefined || inputs.center === undefined) {
        return { ok: false, error: 'Pick a planar face in the viewport to place the hole.' };
    }
    const diameter = Number(inputs.diameterText);
    if (!Number.isFinite(diameter) || diameter <= 0) {
        return { ok: false, error: 'Diameter must be a positive number.' };
    }
    const params: HoleParams = { face: inputs.face, center: inputs.center, diameter };
    const depth = inputs.depthText.trim() === '' ? undefined : Number(inputs.depthText);
    if (depth !== undefined && (!Number.isFinite(depth) || depth <= 0)) {
        return { ok: false, error: 'Depth must be a positive number when provided.' };
    }
    if (inputs.holeType === 'simple' && depth !== undefined) {
        params.depth = depth;
    }
    if (inputs.holeType === 'counterbore') {
        const cbDiameter = Number(inputs.counterboreDiameterText);
        const cbDepth = Number(inputs.counterboreDepthText);
        if (!Number.isFinite(cbDiameter) || cbDiameter <= 0 || !Number.isFinite(cbDepth) || cbDepth <= 0) {
            return { ok: false, error: 'Counterbore diameter and depth must be positive numbers.' };
        }
        params.counterboreDiameter = cbDiameter;
        params.counterboreDepth = cbDepth;
    }
    if (inputs.holeType === 'countersink') {
        const csDiameter = Number(inputs.countersinkDiameterText);
        const csAngle = Number(inputs.countersinkAngleText);
        if (!Number.isFinite(csDiameter) || csDiameter <= 0) {
            return { ok: false, error: 'Countersink diameter must be a positive number.' };
        }
        if (!Number.isFinite(csAngle) || csAngle <= 0 || csAngle >= 90) {
            return { ok: false, error: 'Countersink angle must be in (0, 90) degrees.' };
        }
        params.countersinkDiameter = csDiameter;
        params.countersinkAngle = csAngle;
    }
    if (inputs.holeType === 'counterdrill') {
        const cdDiameter = Number(inputs.counterdrillDiameterText);
        const cdDepth = Number(inputs.counterdrillDepthText);
        if (!Number.isFinite(cdDiameter) || cdDiameter <= 0 || !Number.isFinite(cdDepth) || cdDepth <= 0) {
            return { ok: false, error: 'Counterdrill diameter and depth must be positive numbers.' };
        }
        params.counterdrillDiameter = cdDiameter;
        params.counterdrillDepth = cdDepth;
    }
    const taperText = inputs.taperAngleText.trim();
    if (taperText !== '') {
        const taper = Number(taperText);
        if (!Number.isFinite(taper) || taper <= 0 || taper > 45) {
            return { ok: false, error: 'Taper angle must be in (0, 45] degrees.' };
        }
        params.taperAngle = taper;
    }
    const drillPointText = inputs.drillPointAngleText.trim();
    if (drillPointText !== '') {
        const drillPoint = Number(drillPointText);
        if (!Number.isFinite(drillPoint) || drillPoint <= 0 || drillPoint >= 180) {
            return { ok: false, error: 'Drill point angle must be in (0, 180) degrees.' };
        }
        params.drillPointAngle = drillPoint;
    }
    if (inputs.thread === 'modeled') {
        // Modeled threads sweep the ISO profile as a helical cut: simple
        // blind holes only (a set depth, no taper/counterbore family).
        const modeledEligible = inputs.holeType === 'simple' && inputs.depthText.trim() !== '' && inputs.taperAngleText.trim() === '';
        if (!modeledEligible) {
            return { ok: false, error: 'Modeled threads require a simple blind hole (set a depth, no taper).' };
        }
    }
    if (inputs.thread !== 'none') {
        // 'modeled' lands with the schema wave (agent A2); the field name is
        // already contractual, so emit it through the untyped channel.
        (params as unknown as Record<string, unknown>).thread = inputs.thread;
    }
    return { ok: true, params };
}

/** Boolean body selection shared by the submit path and the ghosted preview. */
function validateBooleanDialogInputs(
    targetBody: string,
    toolBodies: readonly string[]
): DialogValidation<Pick<BooleanParams, 'targetBody' | 'toolBodies'>> {
    if (!targetBody) {
        return { ok: false, error: 'Select a target body.' };
    }
    if (toolBodies.length === 0) {
        return { ok: false, error: 'Select at least one tool body.' };
    }
    return { ok: true, params: { targetBody, toolBodies: [...toolBodies] } };
}

interface DimensionEditPopoverProps {
    dimension: SketchDimension;
    units: DocumentUnits | undefined;
    value: string;
    driving: boolean;
    onValueChange: (value: string) => void;
    onDrivingChange: (driving: boolean) => void;
    onApply: () => void;
    onDelete: () => void;
    onClose: () => void;
}

function DimensionEditPopover(props: DimensionEditPopoverProps): React.ReactElement {
    const { dimension, units, value, driving, onValueChange, onDrivingChange, onApply, onDelete, onClose } = props;
    return (
        <div className="cad-sketch-dimension-popover">
            <div className="cad-sketch-dimension-popover-title">{formatDimensionWithUnits(dimensionLabel(dimension.kind), units)}</div>
            <label className="cad-sketch-dimension-popover-row">
                Value
                <input
                    type="text"
                    value={value}
                    placeholder="value or param"
                    onChange={(e) => onValueChange(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                            onApply();
                        } else if (e.key === 'Escape') {
                            onClose();
                        }
                    }}
                    autoFocus
                />
            </label>
            <label className="cad-sketch-dimension-popover-row">
                <input type="checkbox" checked={driving} onChange={(e) => onDrivingChange(e.target.checked)} />
                Driving
            </label>
            <div className="cad-sketch-dimension-popover-actions">
                <button className="theia-button secondary" onClick={onApply}>
                    <span className="codicon codicon-check" /> Apply
                </button>
                <button className="theia-button secondary" onClick={onDelete}>
                    <span className="codicon codicon-trash" /> Delete
                </button>
                <button className="theia-button secondary" onClick={onClose}>
                    <span className="codicon codicon-close" /> Cancel
                </button>
            </div>
        </div>
    );
}

interface ParametersPanelProps {
    drag: DraggablePanelApi;
    parameters: Record<string, number>;
    dimensions: SketchDimension[];
    errors: Record<string, string>;
    onAdd: (name: string, value: number) => void;
    onRename: (oldName: string, newName: string) => void;
    onSet: (name: string, value: number) => void;
    onRemove: (name: string) => void;
    onClose: () => void;
}

function ParametersPanel(props: ParametersPanelProps): React.ReactElement {
    const { parameters, dimensions, errors, onAdd, onSet, onRemove, onClose } = props;
    const [newName, setNewName] = React.useState('');
    const [newValue, setNewValue] = React.useState('');
    const [editingName, setEditingName] = React.useState<string | undefined>();
    const [editValue, setEditValue] = React.useState('');

    const boundCount = (name: string): number => dimensions.filter((d) => d.parameter === name).length;

    const submitNew = (): void => {
        const name = newName.trim();
        const value = Number(newValue);
        if (name.length > 0 && Number.isFinite(value)) {
            onAdd(name, value);
            setNewName('');
            setNewValue('');
        }
    };

    const startEdit = (name: string): void => {
        setEditingName(name);
        setEditValue(String(parameters[name]));
    };

    const submitEdit = (): void => {
        if (editingName === undefined) {
            return;
        }
        const value = Number(editValue);
        if (Number.isFinite(value)) {
            onSet(editingName, value);
            setEditingName(undefined);
        }
    };

    return (
        <DraggableNukePanel drag={props.drag} className="cad-sketch-parameters-panel" title="Parameters" onClose={onClose}>
            <div className="cad-sketch-parameters-list">
                {Object.entries(parameters).map(([name, value]) => (
                    <div key={name} className="cad-sketch-parameter-row">
                        {editingName === name ? (
                            <>
                                <span className="cad-sketch-parameter-name">{name}</span>
                                <input
                                    type="number"
                                    value={editValue}
                                    onChange={(e) => setEditValue(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            submitEdit();
                                        } else if (e.key === 'Escape') {
                                            setEditingName(undefined);
                                        }
                                    }}
                                    autoFocus
                                />
                            </>
                        ) : (
                            <>
                                <span className="cad-sketch-parameter-name">{name}</span>
                                <span className="cad-sketch-parameter-value">{value}</span>
                            </>
                        )}
                        <span className="cad-sketch-parameter-hint">{boundCount(name)} bound</span>
                        <div className="cad-sketch-parameter-actions">
                            <Tooltip content="Edit value" position="left">
                                <button className="theia-button secondary" onClick={() => startEdit(name)}>
                                    <span className="codicon codicon-edit" />
                                </button>
                            </Tooltip>
                            <Tooltip content="Delete" position="left">
                                <button className="theia-button secondary" onClick={() => onRemove(name)}>
                                    <span className="codicon codicon-trash" />
                                </button>
                            </Tooltip>
                        </div>
                        {errors[name] !== undefined && errors[name].length > 0 && (
                            <div className="cad-sketch-parameter-error">{errors[name]}</div>
                        )}
                    </div>
                ))}
            </div>
            <div className="cad-sketch-parameters-new">
                <input
                    type="text"
                    placeholder="name"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                            submitNew();
                        }
                    }}
                />
                <input
                    type="number"
                    placeholder="value"
                    value={newValue}
                    onChange={(e) => setNewValue(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                            submitNew();
                        }
                    }}
                />
                <button className="theia-button secondary" onClick={submitNew}>
                    <span className="codicon codicon-add" /> Add
                </button>
            </div>
        </DraggableNukePanel>
    );
}

interface DiagnosticsPopoverProps {
    drag: DraggablePanelApi;
    status: SketchStatus;
    constraints: Array<{ id: string; kind: ConstraintKind; targetIds: string[] }>;
    referenceResults: import('../../../common/nuke-cad-protocol').ReferenceResolutionResult[];
    onHighlight: (kind: 'conflicting' | 'redundant') => void;
    onRemoveRedundant: () => void;
    onClose: () => void;
}

function DiagnosticsPopover(props: DiagnosticsPopoverProps): React.ReactElement {
    const { status, constraints, referenceResults, onHighlight, onRemoveRedundant, onClose } = props;
    const findConstraint = (id: string) => constraints.find((c) => c.id === id);
    const refCounts = countReferenceResults(referenceResults);

    return (
        <DraggableNukePanel drag={props.drag} className="cad-sketch-diagnostics-popover" title="Solver Diagnostics" onClose={onClose}>
            {(refCounts.matched > 0 || refCounts.ambiguous > 0 || refCounts.unmatched > 0) && (
                <div className="cad-sketch-diagnostics-section">
                    <div className="cad-sketch-diagnostics-title">References</div>
                    {refCounts.matched > 0 && (
                        <div className="cad-sketch-diagnostics-row">
                            <span className="cad-sketch-diagnostics-id">matched</span>
                            <span className="cad-sketch-diagnostics-kind">{refCounts.matched}</span>
                        </div>
                    )}
                    {refCounts.ambiguous > 0 && (
                        <div className="cad-sketch-diagnostics-row">
                            <span className="cad-sketch-diagnostics-id">ambiguous</span>
                            <span className="cad-sketch-diagnostics-kind">{refCounts.ambiguous}</span>
                        </div>
                    )}
                    {refCounts.unmatched > 0 && (
                        <div className="cad-sketch-diagnostics-row">
                            <span className="cad-sketch-diagnostics-id">unmatched</span>
                            <span className="cad-sketch-diagnostics-kind">{refCounts.unmatched}</span>
                        </div>
                    )}
                    {referenceResults
                        .filter((r) => r.status !== 'matched')
                        .map((r) => (
                            <div key={r.path} className="cad-sketch-diagnostics-row">
                                <span className="cad-sketch-diagnostics-id">{r.path}</span>
                                <span className="cad-sketch-diagnostics-kind">{r.status}</span>
                                <span className="cad-sketch-diagnostics-targets">
                                    {r.score !== undefined ? `score ${r.score.toFixed(3)}` : ''}
                                </span>
                            </div>
                        ))}
                </div>
            )}
            {status.conflicting.length > 0 && (
                <div className="cad-sketch-diagnostics-section">
                    <div className="cad-sketch-diagnostics-title">
                        Conflicting ({status.conflicting.length})
                        <button className="theia-button secondary" onClick={() => onHighlight('conflicting')}>
                            Highlight
                        </button>
                    </div>
                    {status.conflicting.map((id) => (
                        <DiagnosticRow key={id} id={id} constraint={findConstraint(id)} />
                    ))}
                </div>
            )}
            {status.redundant.length > 0 && (
                <div className="cad-sketch-diagnostics-section">
                    <div className="cad-sketch-diagnostics-title">
                        Redundant ({status.redundant.length})
                        <button className="theia-button secondary" onClick={() => onHighlight('redundant')}>
                            Highlight
                        </button>
                    </div>
                    {status.redundant.map((id) => (
                        <DiagnosticRow key={id} id={id} constraint={findConstraint(id)} />
                    ))}
                </div>
            )}
            {status.conflicting.length === 0 &&
                status.redundant.length === 0 &&
                refCounts.matched === 0 &&
                refCounts.ambiguous === 0 &&
                refCounts.unmatched === 0 && <div className="cad-sketch-diagnostics-empty">No diagnostics to report.</div>}
            <div className="cad-sketch-diagnostics-section">
                <Tooltip content="Delete every redundant constraint from the sketch" position="top">
                    <button className="theia-button secondary" onClick={onRemoveRedundant}>
                        Remove redundants ({status.redundant.length})
                    </button>
                </Tooltip>
            </div>
        </DraggableNukePanel>
    );
}

function DiagnosticRow(props: { id: string; constraint?: { kind: ConstraintKind; targetIds: string[] } }): React.ReactElement {
    const { id, constraint } = props;
    return (
        <div className="cad-sketch-diagnostics-row">
            <span className="cad-sketch-diagnostics-id">{id}</span>
            <span className="cad-sketch-diagnostics-kind">{constraint?.kind ?? 'unknown'}</span>
            <span className="cad-sketch-diagnostics-targets">{constraint?.targetIds.join(', ') ?? ''}</span>
        </div>
    );
}

function arityFor(kind: ConstraintKind): number {
    const map: Record<ConstraintKind, number> = {
        coincident: 2,
        fix: 1,
        horizontal: 1,
        vertical: 1,
        parallel: 2,
        perpendicular: 2,
        tangent: 2,
        equal: 2,
        concentric: 2,
        distance: 2,
        angle: 2,
        radius: 1,
        symmetry: 3,
        pointOnObject: 2
    };
    return map[kind];
}

function labelForValue(kind: ConstraintKind): string {
    switch (kind) {
        case 'distance':
            return 'Distance';
        case 'radius':
            return 'Radius / Diameter';
        case 'angle':
            return 'Angle (rad)';
        default:
            return 'Value';
    }
}

function dimensionLabel(kind: DimensionKind): string {
    switch (kind) {
        case 'distance':
            return 'Distance';
        case 'distanceH':
            return 'Horizontal Distance';
        case 'distanceV':
            return 'Vertical Distance';
        case 'angle':
            return 'Angle';
        case 'radius':
            return 'Radius';
        case 'diameter':
            return 'Diameter';
    }
}

/**
 * Append the document-unit suffix to a dimension text when the document
 * declares units; unitless documents render the text unchanged.
 */
export function formatDimensionWithUnits(text: string, units: DocumentUnits | undefined): string {
    return units === undefined ? text : `${text} ${units}`;
}

function buildStatusText(status: SketchStatus, referenceCounts?: ReferenceCounts, snapSummary?: string, selectHint?: string): string {
    const parts: string[] = [];
    if (selectHint !== undefined) {
        parts.push(selectHint);
    }
    if (referenceCounts !== undefined) {
        if (referenceCounts.ambiguous > 0) {
            parts.push(`${referenceCounts.ambiguous} ambiguous ref${referenceCounts.ambiguous === 1 ? '' : 's'}`);
        }
        if (referenceCounts.unmatched > 0) {
            parts.push(`${referenceCounts.unmatched} unmatched ref${referenceCounts.unmatched === 1 ? '' : 's'}`);
        }
    }
    if (status.conflicting.length > 0) {
        parts.push(`${status.conflicting.length} conflicting`);
    }
    if (status.redundant.length > 0) {
        parts.push(`${status.redundant.length} redundant`);
    }
    if (status.fullyConstrained) {
        parts.push('Fully constrained');
    } else {
        parts.push(`${status.dof} degrees of freedom`);
    }
    if (snapSummary !== undefined) {
        parts.push(snapSummary);
    }
    if (status.lastAutoConstraints.length > 0) {
        const kinds = status.lastAutoConstraints.map((a) => a.kind).join(', ');
        parts.push(`Auto: ${kinds}`);
    }
    if (status.hint !== undefined) {
        parts.push(status.hint);
    }
    return parts.join(' · ');
}

interface ReferenceCounts {
    matched: number;
    ambiguous: number;
    unmatched: number;
}

function countReferenceResults(results: import('../../../common/nuke-cad-protocol').ReferenceResolutionResult[]): ReferenceCounts {
    return results.reduce(
        (acc, r) => {
            acc[r.status]++;
            return acc;
        },
        { matched: 0, ambiguous: 0, unmatched: 0 }
    );
}

function findConsumingFeature(
    document: import('../../../common/cad-document').NukeCadDocument | undefined,
    sketchId: string
): import('../../../common/cad-document').FeatureDef | undefined {
    // A feature consumes a sketch through sketchId or a loft's ordered
    // section list — mirror the backend's `_feature_sketch_ids`.
    return document?.features.find(
        (f) =>
            f.sketchId === sketchId ||
            (Array.isArray((f.params as Record<string, unknown>).sectionSketchIds) &&
                ((f.params as Record<string, unknown>).sectionSketchIds as unknown[]).includes(sketchId))
    );
}

function findExternalGeometryTargetFeature(
    document: import('../../../common/cad-document').NukeCadDocument
): import('../../../common/cad-document').FeatureDef | undefined {
    const solidFeatures: FeatureType[] = [
        ...SOLID_PRODUCERS,
        'fillet',
        'chamfer',
        'draft',
        'shell',
        'booleanFuse',
        'booleanCut',
        'booleanCommon'
    ];
    for (let i = document.features.length - 1; i >= 0; i--) {
        const feature = document.features[i];
        if (!feature.suppressed && solidFeatures.includes(feature.type)) {
            return feature;
        }
    }
    return undefined;
}

interface AutoDimensionInputProps {
    readonly controller: SketchModeController;
}

function AutoDimensionInput(props: AutoDimensionInputProps): React.ReactElement | null {
    const { controller } = props;
    const [value, setValue] = React.useState('');
    const inputRef = React.useRef<HTMLInputElement>(null);
    const inputState = controller.getAutoDimensionInput();

    React.useEffect(() => {
        setValue('');
    }, [inputState?.primitiveId]);

    React.useEffect(() => {
        if (inputState !== undefined) {
            inputRef.current?.focus();
            inputRef.current?.select();
        }
    }, [inputState]);

    if (inputState === undefined) {
        return null;
    }

    const label = inputState.kind === 'line' ? 'Length' : 'Radius';
    const apply = (): void => {
        const trimmed = value.trim();
        if (trimmed === '') {
            return;
        }
        const num = Number(trimmed);
        const effective = Number.isFinite(num) ? num : trimmed;
        void controller.applyAutoDimension(effective);
    };
    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
        if (e.key === 'Enter') {
            apply();
        } else if (e.key === 'Escape') {
            controller.cancelAutoDimension();
        }
    };

    return (
        <div
            className="cad-sketch-auto-dimension"
            style={{ left: inputState.screenX, top: inputState.screenY }}
            onPointerDown={(e) => e.stopPropagation()}
        >
            <label>
                {label}
                <input
                    ref={inputRef}
                    type="text"
                    value={value}
                    placeholder="value or param"
                    onChange={(e) => setValue(e.target.value)}
                    onKeyDown={onKeyDown}
                    autoFocus
                />
            </label>
            <button className="theia-button secondary" onClick={apply}>
                <span className="codicon codicon-check" />
            </button>
            <button className="theia-button secondary" onClick={() => controller.cancelAutoDimension()}>
                <span className="codicon codicon-close" />
            </button>
        </div>
    );
}

interface ConstraintContextPopoverProps {
    readonly controller: SketchModeController;
}

function ConstraintContextPopover(props: ConstraintContextPopoverProps): React.ReactElement | null {
    const { controller } = props;
    const popover = controller.getConstraintPopover();
    const session = controller.getSession();

    if (popover === undefined || session === undefined) {
        return null;
    }

    const primitiveA = session.getPrimitive(popover.idA);
    const primitiveB = session.getPrimitive(popover.idB);
    if (primitiveA === undefined || primitiveB === undefined) {
        return null;
    }

    const typeA = primitiveTypeToEntityType(primitiveA.type);
    const typeB = primitiveTypeToEntityType(primitiveB.type);
    if (typeA === undefined || typeB === undefined) {
        return null;
    }

    const relations = validRelations(typeA, typeB);
    if (relations.length === 0) {
        return null;
    }

    const relationLabels: Record<ConstraintKind, string> = {
        coincident: 'Coincident',
        fix: 'Fix',
        horizontal: 'Horizontal',
        vertical: 'Vertical',
        parallel: 'Parallel',
        perpendicular: 'Perpendicular',
        tangent: 'Tangent',
        equal: 'Equal',
        concentric: 'Concentric',
        distance: 'Distance',
        angle: 'Angle',
        radius: 'Radius',
        symmetry: 'Symmetry',
        pointOnObject: 'Point on Object'
    };

    return (
        <div
            className="cad-sketch-constraint-popover"
            style={{ left: popover.screenX, top: popover.screenY }}
            onPointerDown={(e) => e.stopPropagation()}
        >
            {relations.map((kind) => (
                <button
                    key={kind}
                    className="theia-button secondary cad-sketch-constraint-popover-item"
                    onClick={() => {
                        void controller.applyConstraintPopover(kind);
                    }}
                >
                    {relationLabels[kind]}
                </button>
            ))}
        </div>
    );
}

function primitiveTypeToEntityType(type: string): SketchEntityType | undefined {
    if (type === 'point') {
        return 'point';
    }
    if (type === 'line') {
        return 'line';
    }
    if (type === 'circle') {
        return 'circle';
    }
    if (type === 'arc') {
        return 'arc';
    }
    // Ellipses and B-splines relate to other entities only through their
    // point primitives (center, focus, poles); the curve itself has no
    // relations this phase.
    return undefined;
}

interface ContextShortcutBarProps {
    readonly mode: 'document' | 'sketch';
    readonly anchor: { readonly x: number; readonly y: number };
    readonly documentStore: CadDocumentStore;
    readonly controller: SketchModeController;
    readonly onNewDocument?: () => void;
    readonly onNewSketch: () => void;
    readonly onStartFeatureCreation: (type: FeatureType) => void;
    readonly onClose: () => void;
}

function ContextShortcutBar(props: ContextShortcutBarProps): React.ReactElement {
    const { mode, anchor, documentStore, controller, onNewDocument, onNewSketch, onStartFeatureCreation, onClose } = props;
    const barRef = React.useRef<HTMLDivElement>(null);
    const [position, setPosition] = React.useState<{ x: number; y: number }>(anchor);

    React.useEffect(() => {
        const bar = barRef.current;
        if (bar === null) {
            setPosition({ x: anchor.x, y: anchor.y });
            return;
        }
        const rect = bar.getBoundingClientRect();
        const parent =
            bar.offsetParent instanceof HTMLElement ? bar.offsetParent.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
        const parentWidth = parent.width > 0 ? parent.width : window.innerWidth;
        const parentHeight = parent.height > 0 ? parent.height : window.innerHeight;
        const clamped = clampPanelPosition(anchor.x, anchor.y, rect.width, rect.height, parentWidth, parentHeight, 24);
        setPosition({ x: clamped.left, y: clamped.top });
    }, [anchor]);

    React.useEffect(() => {
        const close = (): void => onClose();
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                close();
            }
        };
        window.addEventListener('pointerdown', close);
        window.addEventListener('keydown', onKey, true);
        return () => {
            window.removeEventListener('pointerdown', close);
            window.removeEventListener('keydown', onKey, true);
        };
    }, [onClose]);

    const active = controller.isActive;

    const execute = (action: () => void): void => {
        action();
        onClose();
    };

    const doc = documentStore.document;
    const selectedSketchId = documentStore.selection.selectedSketchId;
    const sketchSelected = selectedSketchId !== undefined;
    const hasBodies = doc !== undefined && doc.bodies.length > 0;
    const hasCurves = doc !== undefined && doc.curves.length > 0;

    const sketchEntries = (
        <>
            {TOOLS.map((t) => (
                <Tooltip key={t.tool} content={`${t.label} (${t.key})`} position="bottom">
                    <button
                        className={`theia-button secondary cad-shortcut-bar-button ${controller.getTool() === t.tool ? 'active' : ''}`}
                        onClick={() => execute(() => controller.setTool(t.tool))}
                    >
                        <span className={`codicon ${t.icon}`} />
                    </button>
                </Tooltip>
            ))}
            <span className="cad-shortcut-bar-divider" />
            <Tooltip content={`Construction geometry (${controller.getConstruction() ? 'on' : 'off'})`} position="bottom">
                <button
                    className={`theia-button secondary cad-shortcut-bar-button ${controller.getConstruction() ? 'active' : ''}`}
                    onClick={() => execute(() => controller.setConstruction(!controller.getConstruction()))}
                >
                    <span className="codicon codicon-nuke-cad-construction" />
                </button>
            </Tooltip>
        </>
    );

    const documentEntries = (
        <>
            <Tooltip content="New Document" position="bottom">
                <button
                    className="theia-button secondary cad-shortcut-bar-button"
                    disabled={onNewDocument === undefined || documentStore.hasDocument}
                    onClick={() => execute(() => onNewDocument?.())}
                >
                    <span className="codicon codicon-new-file" />
                </button>
            </Tooltip>
            <Tooltip content="New Sketch" position="bottom">
                <button className="theia-button secondary cad-shortcut-bar-button" onClick={() => execute(onNewSketch)}>
                    <span className="codicon codicon-nuke-cad-sketch" />
                </button>
            </Tooltip>
            <span className="cad-shortcut-bar-divider" />
            {(['pad', 'pocket', 'revolve', 'groove'] as FeatureType[]).map((type) => (
                <Tooltip key={type} content={capitalize(type)} position="bottom">
                    <button
                        className="theia-button secondary cad-shortcut-bar-button"
                        disabled={!sketchSelected || ((type === 'pocket' || type === 'groove') && !hasBodies)}
                        onClick={() => execute(() => onStartFeatureCreation(type))}
                    >
                        <span className={`codicon codicon-nuke-cad-${type}`} />
                    </button>
                </Tooltip>
            ))}
            {(['sweep', 'pipe'] as FeatureType[]).map((type) => (
                <Tooltip key={type} content={capitalize(type)} position="bottom">
                    <button
                        className="theia-button secondary cad-shortcut-bar-button"
                        disabled={!hasCurves || (type === 'sweep' && !sketchSelected)}
                        onClick={() => execute(() => onStartFeatureCreation(type))}
                    >
                        <span className={`codicon codicon-nuke-cad-${type}`} />
                    </button>
                </Tooltip>
            ))}
            <Tooltip content="Loft" position="bottom">
                <button
                    className="theia-button secondary cad-shortcut-bar-button"
                    disabled={(doc?.sketches.length ?? 0) < 2}
                    onClick={() => execute(() => onStartFeatureCreation('loft'))}
                >
                    <span className="codicon codicon-nuke-cad-loft" />
                </button>
            </Tooltip>
            <Tooltip content="Helical Sweep" position="bottom">
                <button
                    className="theia-button secondary cad-shortcut-bar-button"
                    disabled={!sketchSelected}
                    onClick={() => execute(() => onStartFeatureCreation('helicalSweep'))}
                >
                    <span className="codicon codicon-nuke-cad-helix" />
                </button>
            </Tooltip>
            <span className="cad-shortcut-bar-divider" />
            {(['fillet', 'chamfer', 'draft', 'shell'] as FeatureType[]).map((type) => (
                <Tooltip key={type} content={capitalize(type)} position="bottom">
                    <button
                        className="theia-button secondary cad-shortcut-bar-button"
                        disabled={!hasBodies}
                        onClick={() => execute(() => onStartFeatureCreation(type))}
                    >
                        <span className={`codicon codicon-nuke-cad-${type}`} />
                    </button>
                </Tooltip>
            ))}
            <span className="cad-shortcut-bar-divider" />
            {(['linearPattern', 'circularPattern', 'mirror', 'hole'] as FeatureType[]).map((type) => (
                <Tooltip key={type} content={capitalize(type)} position="bottom">
                    <button
                        className="theia-button secondary cad-shortcut-bar-button"
                        disabled={!hasBodies}
                        onClick={() => execute(() => onStartFeatureCreation(type))}
                    >
                        <span
                            className={`codicon codicon-nuke-cad-${type === 'hole' ? 'hole' : type.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}`}
                        />
                    </button>
                </Tooltip>
            ))}
        </>
    );

    return (
        <div
            ref={barRef}
            className="cad-shortcut-bar"
            style={{ left: position.x, top: position.y }}
            onPointerDown={(e) => e.stopPropagation()}
        >
            {active && mode === 'sketch' ? sketchEntries : documentEntries}
        </div>
    );
}

interface DocumentTemplatePickerProps {
    readonly templates: ReadonlyArray<DocumentTemplate>;
    readonly onSelect: (templateId: string) => void;
    readonly onCancel: () => void;
}

export function DocumentTemplatePicker(props: DocumentTemplatePickerProps): React.ReactElement {
    const { templates, onSelect, onCancel } = props;
    return (
        <NukeDialog title="New Document" onClose={onCancel}>
            <div className="cad-template-picker">
                <div className="cad-template-list">
                    {templates.map((template) => (
                        <button key={template.id} className="cad-template-item" onClick={() => onSelect(template.id)}>
                            <span className="cad-template-name">{template.name}</span>
                            <span className="cad-template-description">{template.description}</span>
                            {Object.keys(template.parameters).length > 0 && (
                                <span className="cad-template-params">
                                    {Object.entries(template.parameters)
                                        .map(([name, value]) => `${name}=${value}`)
                                        .join(', ')}
                                </span>
                            )}
                        </button>
                    ))}
                </div>
                <div className="cad-template-picker-actions">
                    <button className="theia-button secondary" onClick={onCancel}>
                        Cancel
                    </button>
                </div>
            </div>
        </NukeDialog>
    );
}
