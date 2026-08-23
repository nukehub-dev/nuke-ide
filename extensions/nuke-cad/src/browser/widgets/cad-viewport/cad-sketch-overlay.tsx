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
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components/tooltip';
import { NukeDialog, NukePanel, NukeToolbar, NukeToolbarGroup } from 'nuke-essentials/lib/theme/browser/components';
import { SketchModeController } from '../../sketch/sketch-mode-controller';
import { type SketchTool, type ConstraintKind, type SketchStatus } from '../../sketch/sketch-session';
import { type DatumKind } from '../../sketch/sketch-math';
import {
    type SketchDimension,
    type DimensionKind,
    type FeatureType,
    type FeatureParams,
    type FeatureDef
} from '../../../common/cad-document';
import { type TopologyRef } from '../../../common/topology-refs';
import { CadDocumentStore } from '../../document/cad-document-store';

interface CadSketchOverlayProps {
    readonly controller: SketchModeController;
    readonly documentStore: CadDocumentStore;
    readonly setupVisible: boolean;
    readonly featureCreationType?: FeatureType;
    readonly editFeature?: FeatureDef;
    readonly facePickMode?: 'sketchDatum' | 'externalGeometry';
    readonly dressUpPickMode?: { readonly type: FeatureType; readonly selecting: 'edge' | 'face' };
    readonly holePickMode?: boolean;
    readonly onEnterSketch: (kind: DatumKind, offset: number) => void;
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
}

const TOOLS: Array<{ tool: SketchTool; label: string; icon: string }> = [
    { tool: 'select', label: 'Select', icon: 'codicon-symbol-method' },
    { tool: 'point', label: 'Point', icon: 'codicon-add' },
    { tool: 'line', label: 'Line', icon: 'codicon-dash' },
    { tool: 'circle', label: 'Circle', icon: 'codicon-circle-outline' },
    { tool: 'arc3', label: '3-Point Arc', icon: 'codicon-git-commit' },
    { tool: 'rectangle', label: 'Rectangle', icon: 'codicon-checklist' }
];

const SOLID_PRODUCERS: FeatureType[] = ['pad', 'pocket', 'revolve', 'groove'];

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
        setupVisible,
        featureCreationType,
        editFeature,
        facePickMode,
        dressUpPickMode,
        holePickMode,
        onEnterSketch,
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
        onHolePickCancel
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

    const active = controller.isActive;
    const tool = controller.getTool();
    const construction = controller.getConstruction();
    const status = controller.getStatus();
    const constraintInput = controller.getConstraintInput();
    const dimensions = active ? controller.getDimensions() : [];
    const dimensionLabels = active ? controller.getDimensionLabels() : [];
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
    const statusText = buildStatusText(status, refCounts);
    const hasDiagnostics =
        status.conflicting.length > 0 || status.redundant.length > 0 || refCounts.ambiguous > 0 || refCounts.unmatched > 0;

    return (
        <div className="cad-sketch-overlay">
            {setupVisible && !active && (
                <DatumPicker
                    datumKind={datumKind}
                    offset={offset}
                    facePickMode={facePickMode}
                    onDatumKindChange={setDatumKind}
                    onOffsetChange={setOffset}
                    onEnter={() => onEnterSketch(datumKind, Number(offset))}
                    onCancel={() => void onExitSketch()}
                    onStartFacePick={() => onStartFacePick(Number(offset))}
                    onCancelFacePick={onCancelFacePick}
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
                />
            )}

            {active && (
                <>
                    <div className="cad-sketch-toolbar">
                        {TOOLS.map(({ tool: t, label, icon }) => (
                            <Tooltip key={t} content={label} position="right">
                                <button
                                    className={`theia-button secondary cad-sketch-tool-button ${tool === t ? 'active' : ''}`}
                                    onClick={() => controller.setTool(t)}
                                >
                                    <span className={`codicon ${icon}`} />
                                </button>
                            </Tooltip>
                        ))}
                        <Tooltip content="Construction Geometry" position="right">
                            <button
                                className={`theia-button secondary cad-sketch-tool-button ${construction ? 'active' : ''}`}
                                onClick={() => controller.setConstruction(!construction)}
                            >
                                <span className="codicon codicon-whole-word" />
                            </button>
                        </Tooltip>
                        <Tooltip content="Toggle Construction on Selection" position="right">
                            <button
                                className="theia-button secondary cad-sketch-tool-button"
                                onClick={() => void controller.toggleConstructionForSelection()}
                            >
                                <span className="codicon codicon-edit" />
                            </button>
                        </Tooltip>
                        <Tooltip content="Parameters" position="right">
                            <button
                                className={`theia-button secondary cad-sketch-tool-button ${paramsOpen ? 'active' : ''}`}
                                onClick={() => setParamsOpen(!paramsOpen)}
                            >
                                <span className="codicon codicon-symbol-variable" />
                            </button>
                        </Tooltip>
                        <Tooltip content="External Geometry" position="right">
                            <button
                                className={`theia-button secondary cad-sketch-tool-button ${facePickMode === 'externalGeometry' ? 'active' : ''}`}
                                disabled={externalGeometryTarget === undefined}
                                onClick={() => {
                                    if (externalGeometryTarget !== undefined) {
                                        onStartExternalGeometryPick(externalGeometryTarget.id);
                                    }
                                }}
                            >
                                <span className="codicon codicon-link-external" />
                            </button>
                        </Tooltip>
                        <Tooltip content="Exit Sketch" position="right">
                            <button className="theia-button secondary cad-sketch-tool-button" onClick={() => void onExitSketch()}>
                                <span className="codicon codicon-close" />
                            </button>
                        </Tooltip>
                    </div>

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

                    {dimensionLabels.map((label) => (
                        <div
                            key={label.id}
                            className={`cad-sketch-dimension-label ${label.selected ? 'selected' : ''}`}
                            style={{ left: label.x, top: label.y }}
                            onClick={(e) => {
                                e.stopPropagation();
                                const dimension = dimensions.find((d) => d.id === label.id);
                                if (dimension !== undefined) {
                                    openDimensionEdit(dimension);
                                }
                            }}
                        >
                            {label.text}
                        </div>
                    ))}

                    {editingDimension !== undefined && (
                        <DimensionEditPopover
                            dimension={editingDimension}
                            value={editDimValue}
                            driving={editDimDriving}
                            onValueChange={setEditDimValue}
                            onDrivingChange={setEditDimDriving}
                            onApply={applyDimensionEdit}
                            onDelete={deleteDimension}
                            onClose={closeDimensionEdit}
                        />
                    )}

                    {paramsOpen && session !== undefined && (
                        <ParametersPanel
                            parameters={session.getParameters()}
                            dimensions={dimensions}
                            errors={paramErrors}
                            onAdd={addParameter}
                            onRename={() => {
                                // Rename is intentionally not supported in Tier 1.
                            }}
                            onSet={setParameter}
                            onRemove={removeParameter}
                            onClose={() => setParamsOpen(false)}
                        />
                    )}

                    {diagnosticsOpen && (
                        <DiagnosticsPopover
                            status={status}
                            constraints={session?.getConstraints() ?? []}
                            referenceResults={relevantRefs}
                            onHighlight={(kind) => controller.highlightDiagnostics(kind)}
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

interface DatumPickerProps {
    datumKind: DatumKind;
    offset: string;
    facePickMode?: 'sketchDatum' | 'externalGeometry';
    onDatumKindChange: (kind: DatumKind) => void;
    onOffsetChange: (value: string) => void;
    onEnter: () => void;
    onCancel: () => void;
    onStartFacePick: () => void;
    onCancelFacePick: () => void;
}

function DatumPicker(props: DatumPickerProps): React.ReactElement {
    const picking = props.facePickMode === 'sketchDatum';
    return (
        <div className="cad-sketch-datum-picker">
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
                                className={`theia-button secondary ${props.datumKind === kind ? 'active' : ''}`}
                                onClick={() => props.onDatumKindChange(kind)}
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
                    <label className="cad-sketch-datum-offset">
                        Offset
                        <input
                            type="number"
                            value={props.offset}
                            onChange={(e) => props.onOffsetChange(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    props.onEnter();
                                } else if (e.key === 'Escape') {
                                    props.onCancel();
                                }
                            }}
                        />
                    </label>
                    <div className="cad-sketch-datum-actions">
                        <button className="theia-button secondary" onClick={props.onEnter}>
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
}

interface ExternalRefsPanelProps {
    readonly refs: readonly import('../../../common/topology-refs').TopologyRef[];
    readonly onRemove: (index: number) => void;
}

function ExternalRefsPanel(props: ExternalRefsPanelProps): React.ReactElement {
    return (
        <NukePanel title="External Geometry" className="cad-sketch-external-refs">
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
        </NukePanel>
    );
}

function DocumentModeToolbar(props: DocumentModeToolbarProps): React.ReactElement {
    const doc = props.documentStore.document;
    const selectedSketchId = props.documentStore.selection.selectedSketchId;
    const sketchSelected = selectedSketchId !== undefined;
    const hasBodies = doc !== undefined && doc.bodies.length > 0;
    const hasSolidProducers = doc !== undefined && doc.features.some((f) => SOLID_PRODUCERS.includes(f.type) && !f.suppressed);

    return (
        <NukeToolbar className="cad-document-toolbar">
            <NukeToolbarGroup label="Document">
                <Tooltip content="New Document" position="bottom">
                    <button
                        className="theia-button secondary"
                        disabled={props.onNewDocument === undefined}
                        onClick={() => props.onNewDocument?.()}
                    >
                        <span className="codicon codicon-new-file" /> New
                    </button>
                </Tooltip>
                <Tooltip content="Save Document" position="bottom">
                    <button
                        className="theia-button secondary"
                        disabled={props.onSaveDocument === undefined || !props.documentStore.dirty}
                        onClick={() => props.onSaveDocument?.()}
                    >
                        <span className="codicon codicon-save" /> Save
                    </button>
                </Tooltip>
                <Tooltip content="Rebuild Geometry" position="bottom">
                    <button
                        className="theia-button secondary"
                        disabled={props.onRebuildDocument === undefined}
                        onClick={() => props.onRebuildDocument?.()}
                    >
                        <span className="codicon codicon-refresh" /> Rebuild
                    </button>
                </Tooltip>
                <Tooltip content="Export as Python" position="bottom">
                    <button
                        className="theia-button secondary"
                        disabled={props.onExportPython === undefined}
                        onClick={() => props.onExportPython?.()}
                    >
                        <span className="codicon codicon-code" /> Export Python
                    </button>
                </Tooltip>
            </NukeToolbarGroup>
            <NukeToolbarGroup label="Sketch">
                <Tooltip content="New Sketch" position="bottom">
                    <button className="theia-button secondary" onClick={props.onNewSketch}>
                        <span className="codicon codicon-add" /> Sketch
                    </button>
                </Tooltip>
                {selectedSketchId !== undefined && (
                    <Tooltip content="Edit Selected Sketch" position="bottom">
                        <button className="theia-button secondary" onClick={() => props.onEditSketch(selectedSketchId)}>
                            <span className="codicon codicon-edit" /> Edit Sketch
                        </button>
                    </Tooltip>
                )}
            </NukeToolbarGroup>
            <NukeToolbarGroup label="Additive">
                <Tooltip content="Pad (extrude add)" position="bottom">
                    <button
                        className="theia-button secondary"
                        disabled={!sketchSelected}
                        onClick={() => props.onStartFeatureCreation('pad')}
                    >
                        <span className="codicon codicon-fold-up" /> Pad
                    </button>
                </Tooltip>
                <Tooltip content="Pocket (extrude cut)" position="bottom">
                    <button
                        className="theia-button secondary"
                        disabled={!sketchSelected || !hasBodies}
                        onClick={() => props.onStartFeatureCreation('pocket')}
                    >
                        <span className="codicon codicon-fold-down" /> Pocket
                    </button>
                </Tooltip>
                <Tooltip content="Revolve" position="bottom">
                    <button
                        className="theia-button secondary"
                        disabled={!sketchSelected}
                        onClick={() => props.onStartFeatureCreation('revolve')}
                    >
                        <span className="codicon codicon-sync" /> Revolve
                    </button>
                </Tooltip>
                <Tooltip content="Groove" position="bottom">
                    <button
                        className="theia-button secondary"
                        disabled={!sketchSelected || !hasBodies}
                        onClick={() => props.onStartFeatureCreation('groove')}
                    >
                        <span className="codicon codicon-discard" /> Groove
                    </button>
                </Tooltip>
            </NukeToolbarGroup>
            <NukeToolbarGroup label="Boolean">
                <Tooltip content="Boolean Fuse" position="bottom">
                    <button
                        className="theia-button secondary"
                        disabled={!hasBodies}
                        onClick={() => props.onStartFeatureCreation('booleanFuse')}
                    >
                        <span className="codicon codicon-type-hierarchy-sub" /> Fuse
                    </button>
                </Tooltip>
                <Tooltip content="Boolean Cut" position="bottom">
                    <button
                        className="theia-button secondary"
                        disabled={!hasBodies}
                        onClick={() => props.onStartFeatureCreation('booleanCut')}
                    >
                        <span className="codicon codicon-type-hierarchy-super" /> Cut
                    </button>
                </Tooltip>
                <Tooltip content="Boolean Common" position="bottom">
                    <button
                        className="theia-button secondary"
                        disabled={!hasBodies}
                        onClick={() => props.onStartFeatureCreation('booleanCommon')}
                    >
                        <span className="codicon codicon-intersect" /> Common
                    </button>
                </Tooltip>
            </NukeToolbarGroup>
            <NukeToolbarGroup label="Dress-up">
                <Tooltip content="Fillet" position="bottom">
                    <button className="theia-button secondary" disabled={!hasBodies} onClick={() => props.onStartFeatureCreation('fillet')}>
                        <span className="codicon codicon-circle" /> Fillet
                    </button>
                </Tooltip>
                <Tooltip content="Chamfer" position="bottom">
                    <button
                        className="theia-button secondary"
                        disabled={!hasBodies}
                        onClick={() => props.onStartFeatureCreation('chamfer')}
                    >
                        <span className="codicon codicon-chrome-minimize" /> Chamfer
                    </button>
                </Tooltip>
                <Tooltip content="Draft" position="bottom">
                    <button className="theia-button secondary" disabled={!hasBodies} onClick={() => props.onStartFeatureCreation('draft')}>
                        <span className="codicon codicon-triangle-down" /> Draft
                    </button>
                </Tooltip>
                <Tooltip content="Shell" position="bottom">
                    <button className="theia-button secondary" disabled={!hasBodies} onClick={() => props.onStartFeatureCreation('shell')}>
                        <span className="codicon codicon-layers" /> Shell
                    </button>
                </Tooltip>
            </NukeToolbarGroup>
            <NukeToolbarGroup label="Pattern">
                <Tooltip content="Linear Pattern" position="bottom">
                    <button
                        className="theia-button secondary"
                        disabled={!hasBodies || !hasSolidProducers}
                        onClick={() => props.onStartFeatureCreation('linearPattern')}
                    >
                        <span className="codicon codicon-copy" /> Linear Pattern
                    </button>
                </Tooltip>
                <Tooltip content="Circular Pattern" position="bottom">
                    <button
                        className="theia-button secondary"
                        disabled={!hasBodies || !hasSolidProducers}
                        onClick={() => props.onStartFeatureCreation('circularPattern')}
                    >
                        <span className="codicon codicon-issue-reopened" /> Circular Pattern
                    </button>
                </Tooltip>
                <Tooltip content="Mirror" position="bottom">
                    <button
                        className="theia-button secondary"
                        disabled={!hasBodies || !hasSolidProducers}
                        onClick={() => props.onStartFeatureCreation('mirror')}
                    >
                        <span className="codicon codicon-mirror" /> Mirror
                    </button>
                </Tooltip>
            </NukeToolbarGroup>
            <NukeToolbarGroup label="Hole">
                <Tooltip content="Hole" position="bottom">
                    <button className="theia-button secondary" disabled={!hasBodies} onClick={() => props.onStartFeatureCreation('hole')}>
                        <span className="codicon codicon-circle-slash" /> Hole
                    </button>
                </Tooltip>
            </NukeToolbarGroup>
            {doc !== undefined && (
                <span className="cad-document-name">
                    {doc.name}
                    {props.documentStore.dirty && <span className="cad-document-dirty" />}
                </span>
            )}
        </NukeToolbar>
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
    const [holeType, setHoleType] = React.useState<'simple' | 'counterbore' | 'countersink'>('simple');
    const [holeCounterboreDiameter, setHoleCounterboreDiameter] = React.useState('1.5');
    const [holeCounterboreDepth, setHoleCounterboreDepth] = React.useState('0.5');
    const [holeCountersinkDiameter, setHoleCountersinkDiameter] = React.useState('1.5');
    const [holeCountersinkAngle, setHoleCountersinkAngle] = React.useState('82');

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
        }
        if (isRevolve) {
            setAngle(p.angle !== undefined ? String(p.angle) : '90');
            setAxis((p.axis as 'x' | 'y' | 'z') ?? 'z');
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
            }
            if (type === 'linearPattern') {
                setPatternCount(p.count !== undefined ? String(p.count) : '2');
                setPatternSpacing(p.spacing !== undefined ? String(p.spacing) : '1');
                setPatternAxis((p.axis as 'x' | 'y' | 'z') ?? 'z');
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
            } else {
                setHoleType('simple');
            }
        }
        setError(undefined);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.editFeature]);

    const addRef = React.useCallback((ref: TopologyRef) => {
        setRefs((prev) => [...prev, ref]);
    }, []);

    const selecting = type === 'fillet' || type === 'chamfer' ? 'edge' : 'face';
    const isPicking =
        props.dressUpPickMode !== undefined && props.dressUpPickMode.type === type && props.dressUpPickMode.selecting === selecting;

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
        if (!isBoolean && !isDressUp && props.sketchId === undefined) {
            setError('No sketch is selected.');
            return;
        }
        if (isBoolean) {
            if (!targetBody) {
                setError('Select a target body.');
                return;
            }
            if (toolBodies.length === 0) {
                setError('Select at least one tool body.');
                return;
            }
            finish({ targetBody, toolBodies, keepTools });
            return;
        }
        if (isDressUp) {
            if (!dressUpBodyId) {
                setError('Select a target body.');
                return;
            }
            if (type !== 'shell' && refs.length === 0) {
                setError(`Select at least one ${selecting} for ${capitalize(type)}.`);
                return;
            }
            const params: Record<string, unknown> = { bodyId: dressUpBodyId, label };
            if (type === 'fillet') {
                const radius = Number(filletRadius);
                if (!Number.isFinite(radius) || radius <= 0) {
                    setError('Radius must be a positive number.');
                    return;
                }
                params.edges = refs;
                params.radius = radius;
            } else if (type === 'chamfer') {
                params.edges = refs;
                if (chamferMode === 'symmetric') {
                    const distance = Number(chamferDistance);
                    if (!Number.isFinite(distance) || distance <= 0) {
                        setError('Distance must be a positive number.');
                        return;
                    }
                    params.distance = distance;
                } else if (chamferMode === 'twoDistance') {
                    const d1 = Number(chamferDistance);
                    const d2 = Number(chamferDistance2);
                    if (!Number.isFinite(d1) || d1 <= 0 || !Number.isFinite(d2) || d2 <= 0) {
                        setError('Both distances must be positive numbers.');
                        return;
                    }
                    params.distances = [d1, d2];
                } else {
                    const distance = Number(chamferDistance);
                    const angle = Number(chamferAngle);
                    if (!Number.isFinite(distance) || distance <= 0) {
                        setError('Distance must be a positive number.');
                        return;
                    }
                    if (!Number.isFinite(angle) || angle <= 0 || angle >= 90) {
                        setError('Angle must be in (0, 90) degrees.');
                        return;
                    }
                    params.distance = distance;
                    params.angle = angle;
                }
            } else if (type === 'draft') {
                const angle = Number(draftAngle);
                if (!Number.isFinite(angle) || angle <= -90 || angle >= 90) {
                    setError('Draft angle must be in (-90, 90) degrees.');
                    return;
                }
                const dir: [number, number, number] = [Number(pullDirection[0]), Number(pullDirection[1]), Number(pullDirection[2])];
                if (!dir.every((v) => Number.isFinite(v)) || (dir[0] === 0 && dir[1] === 0 && dir[2] === 0)) {
                    setError('Pull direction must be a non-zero [x, y, z] vector.');
                    return;
                }
                params.faces = refs;
                params.angle = angle;
                params.pullDirection = dir;
            } else if (type === 'shell') {
                const thickness = Number(shellThickness);
                if (!Number.isFinite(thickness) || thickness <= 0) {
                    setError('Thickness must be a positive number.');
                    return;
                }
                params.faces = shellAllFaces ? [] : refs;
                params.thickness = thickness;
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
            if (type === 'linearPattern') {
                const spacing = Number(patternSpacing);
                if (!Number.isFinite(spacing) || spacing === 0) {
                    setError('Spacing must be a non-zero finite number.');
                    return;
                }
                params.count = count;
                params.spacing = spacing;
                params.axis = patternAxis;
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
            if (holeFaceRef === undefined || holeCenterUv === undefined) {
                setError('Pick a planar face in the viewport to place the hole.');
                return;
            }
            const diameter = Number(holeDiameter);
            if (!Number.isFinite(diameter) || diameter <= 0) {
                setError('Diameter must be a positive number.');
                return;
            }
            const params: Record<string, unknown> = {
                face: holeFaceRef,
                center: holeCenterUv,
                diameter,
                bodyId: holeBodyId,
                label
            };
            const depth = holeDepth.trim() === '' ? undefined : Number(holeDepth);
            if (depth !== undefined && (!Number.isFinite(depth) || depth <= 0)) {
                setError('Depth must be a positive number when provided.');
                return;
            }
            if (holeType === 'simple' && depth !== undefined) {
                params.depth = depth;
            }
            if (holeType === 'counterbore') {
                const cbDiameter = Number(holeCounterboreDiameter);
                const cbDepth = Number(holeCounterboreDepth);
                if (!Number.isFinite(cbDiameter) || cbDiameter <= 0 || !Number.isFinite(cbDepth) || cbDepth <= 0) {
                    setError('Counterbore diameter and depth must be positive numbers.');
                    return;
                }
                params.counterboreDiameter = cbDiameter;
                params.counterboreDepth = cbDepth;
            }
            if (holeType === 'countersink') {
                const csDiameter = Number(holeCountersinkDiameter);
                const csAngle = Number(holeCountersinkAngle);
                if (!Number.isFinite(csDiameter) || csDiameter <= 0) {
                    setError('Countersink diameter must be a positive number.');
                    return;
                }
                if (!Number.isFinite(csAngle) || csAngle <= 0 || csAngle >= 90) {
                    setError('Countersink angle must be in (0, 90) degrees.');
                    return;
                }
                params.countersinkDiameter = csDiameter;
                params.countersinkAngle = csAngle;
            }
            finish(params);
            return;
        }
        if (isExtrude) {
            const value = Number(length);
            if (!Number.isFinite(value) || value <= 0) {
                setError('Length must be a positive number.');
                return;
            }
            const effectiveBodyId = bodyId === NEW_BODY_SENTINEL ? undefined : bodyId;
            finish({ length: value, axis, symmetric, bodyId: effectiveBodyId, label });
        } else if (isRevolve) {
            const value = Number(angle);
            if (!Number.isFinite(value) || value <= 0 || value > 360) {
                setError('Angle must be in (0, 360].');
                return;
            }
            const effectiveBodyId = bodyId === NEW_BODY_SENTINEL ? undefined : bodyId;
            finish({ axis, angle: value, bodyId: effectiveBodyId, label });
        }
    };

    const bodySelector = (
        <label className="cad-feature-dialog-row">
            Body
            <select value={bodyId} onChange={(e) => setBodyId(e.target.value)}>
                {type === 'pad' || type === 'revolve' ? <option value={NEW_BODY_SENTINEL}>New body</option> : null}
                {bodies.map((b) => (
                    <option key={b.id} value={b.id}>
                        {b.name}
                    </option>
                ))}
            </select>
        </label>
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
        <label className="cad-feature-dialog-row">
            Label
            <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
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
            <label className="cad-feature-dialog-row">
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

    // A viewport pick (dress-up edges/faces, hole placement face) needs clicks
    // and Escape to reach the viewport, so the dialog drops its modal backdrop
    // while a pick is active.
    const pickActive = isPicking || props.holePickMode === true;

    return (
        <NukeDialog
            title={props.editFeature !== undefined ? `Edit ${capitalize(type)}` : capitalize(type)}
            onClose={props.onCancel}
            modal={!pickActive}
            closeOnEscape={!pickActive}
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
                    {refList}
                </>
            )}
            {isDressUp && type === 'shell' && (
                <>
                    <label className="cad-feature-dialog-row">
                        Thickness
                        <input type="number" value={shellThickness} onChange={(e) => setShellThickness(e.target.value)} autoFocus />
                    </label>
                    <label className="cad-feature-dialog-row">
                        <input type="checkbox" checked={shellAllFaces} onChange={(e) => setShellAllFaces(e.target.checked)} />
                        Hollow all faces (closed shell)
                    </label>
                    {!shellAllFaces && refList}
                </>
            )}
            {isExtrude && (
                <>
                    <label className="cad-feature-dialog-row">
                        Length
                        <input type="number" value={length} onChange={(e) => setLength(e.target.value)} autoFocus />
                    </label>
                    <label className="cad-feature-dialog-row">
                        Direction
                        <select value={axis} onChange={(e) => setAxis(e.target.value as 'x' | 'y' | 'z')}>
                            <option value="x">X</option>
                            <option value="y">Y</option>
                            <option value="z">Z</option>
                        </select>
                    </label>
                    <label className="cad-feature-dialog-row">
                        <input type="checkbox" checked={symmetric} onChange={(e) => setSymmetric(e.target.checked)} />
                        Symmetric
                    </label>
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
                        <select value={holeType} onChange={(e) => setHoleType(e.target.value as 'simple' | 'counterbore' | 'countersink')}>
                            <option value="simple">Simple / through</option>
                            <option value="counterbore">Counterbore</option>
                            <option value="countersink">Countersink</option>
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
                </>
            )}
            {isBoolean && booleanBodySelectors}
            {!isBoolean && labelInput}
        </NukeDialog>
    );
}

function capitalize(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
}

interface DimensionEditPopoverProps {
    dimension: SketchDimension;
    value: string;
    driving: boolean;
    onValueChange: (value: string) => void;
    onDrivingChange: (driving: boolean) => void;
    onApply: () => void;
    onDelete: () => void;
    onClose: () => void;
}

function DimensionEditPopover(props: DimensionEditPopoverProps): React.ReactElement {
    const { dimension, value, driving, onValueChange, onDrivingChange, onApply, onDelete, onClose } = props;
    return (
        <div className="cad-sketch-dimension-popover">
            <div className="cad-sketch-dimension-popover-title">{dimensionLabel(dimension.kind)}</div>
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
        <NukePanel title="Parameters" onClose={onClose} className="cad-sketch-parameters-panel">
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
        </NukePanel>
    );
}

interface DiagnosticsPopoverProps {
    status: SketchStatus;
    constraints: Array<{ id: string; kind: ConstraintKind; targetIds: string[] }>;
    referenceResults: import('../../../common/nuke-cad-protocol').ReferenceResolutionResult[];
    onHighlight: (kind: 'conflicting' | 'redundant') => void;
    onClose: () => void;
}

function DiagnosticsPopover(props: DiagnosticsPopoverProps): React.ReactElement {
    const { status, constraints, referenceResults, onHighlight, onClose } = props;
    const findConstraint = (id: string) => constraints.find((c) => c.id === id);
    const refCounts = countReferenceResults(referenceResults);

    return (
        <NukePanel title="Solver Diagnostics" onClose={onClose} className="cad-sketch-diagnostics-popover">
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
        </NukePanel>
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

function buildStatusText(status: SketchStatus, referenceCounts?: ReferenceCounts): string {
    const parts: string[] = [];
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
    if (status.lastAutoConstraints.length > 0) {
        const kinds = status.lastAutoConstraints.map((a) => a.kind).join(', ');
        parts.push(`Auto: ${kinds}`);
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
    return document?.features.find((f) => f.sketchId === sketchId);
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
