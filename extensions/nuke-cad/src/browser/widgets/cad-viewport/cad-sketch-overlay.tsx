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
import { SketchModeController } from '../../sketch/sketch-mode-controller';
import { type SketchTool, type ConstraintKind, type SketchStatus } from '../../sketch/sketch-session';
import { type DatumKind } from '../../sketch/sketch-math';
import { type SketchDimension, type DimensionKind, type FeatureType, type FeatureParams } from '../../../common/cad-document';
import { CadDocumentStore } from '../../document/cad-document-store';

interface CadSketchOverlayProps {
    readonly controller: SketchModeController;
    readonly documentStore: CadDocumentStore;
    readonly setupVisible: boolean;
    readonly featureCreationType?: FeatureType;
    readonly onEnterSketch: (kind: DatumKind, offset: number) => void;
    readonly onExitSketch: () => Promise<void>;
    readonly onStartFeatureCreation: (type: FeatureType) => void;
    readonly onAddFeature: (type: FeatureType, params: FeatureParams) => void;
    readonly onEditSketch: (sketchId: string) => void;
    readonly onCancelFeatureCreation: () => void;
}

const TOOLS: Array<{ tool: SketchTool; label: string; icon: string }> = [
    { tool: 'select', label: 'Select', icon: 'codicon-symbol-method' },
    { tool: 'point', label: 'Point', icon: 'codicon-add' },
    { tool: 'line', label: 'Line', icon: 'codicon-dash' },
    { tool: 'circle', label: 'Circle', icon: 'codicon-circle-outline' },
    { tool: 'arc3', label: '3-Point Arc', icon: 'codicon-git-commit' },
    { tool: 'rectangle', label: 'Rectangle', icon: 'codicon-checklist' }
];

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
        onEnterSketch,
        onExitSketch,
        onStartFeatureCreation,
        onAddFeature,
        onEditSketch,
        onCancelFeatureCreation
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
    }, [editingDimension?.id]);

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

    const statusText = buildStatusText(status);
    const hasDiagnostics = status.conflicting.length > 0 || status.redundant.length > 0;

    return (
        <div className="cad-sketch-overlay">
            {setupVisible && !active && (
                <DatumPicker
                    datumKind={datumKind}
                    offset={offset}
                    onDatumKindChange={setDatumKind}
                    onOffsetChange={setOffset}
                    onEnter={() => onEnterSketch(datumKind, Number(offset))}
                    onCancel={() => void onExitSketch()}
                />
            )}

            {!active && documentStore.hasDocument && !setupVisible && (
                <DocumentModeToolbar
                    documentStore={documentStore}
                    onNewSketch={() => onEnterSketch('XY', 0)}
                    onExitSketch={() => void onExitSketch()}
                    onEditSketch={onEditSketch}
                    onStartFeatureCreation={onStartFeatureCreation}
                />
            )}

            {featureCreationType !== undefined && !active && (
                <FeatureCreationDialog
                    type={featureCreationType}
                    sketchId={documentStore.selection.selectedSketchId}
                    onCancel={onCancelFeatureCreation}
                    onConfirm={(type, params) => {
                        onAddFeature(type, params);
                        onCancelFeatureCreation();
                    }}
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
    onDatumKindChange: (kind: DatumKind) => void;
    onOffsetChange: (value: string) => void;
    onEnter: () => void;
    onCancel: () => void;
}

function DatumPicker(props: DatumPickerProps): React.ReactElement {
    return (
        <div className="cad-sketch-datum-picker">
            <div className="cad-sketch-datum-title">Sketch Plane</div>
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
        </div>
    );
}

interface DocumentModeToolbarProps {
    readonly documentStore: CadDocumentStore;
    readonly onNewSketch: () => void;
    readonly onExitSketch: () => void;
    readonly onEditSketch: (sketchId: string) => void;
    readonly onStartFeatureCreation: (type: FeatureType) => void;
}

function DocumentModeToolbar(props: DocumentModeToolbarProps): React.ReactElement {
    const doc = props.documentStore.document;
    const selectedSketchId = props.documentStore.selection.selectedSketchId;
    const sketchSelected = selectedSketchId !== undefined;

    return (
        <div className="cad-document-toolbar">
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
            <Tooltip content="Pad (extrude add)" position="bottom">
                <button className="theia-button secondary" disabled={!sketchSelected} onClick={() => props.onStartFeatureCreation('pad')}>
                    <span className="codicon codicon-fold-up" /> Pad
                </button>
            </Tooltip>
            <Tooltip content="Pocket (extrude cut)" position="bottom">
                <button
                    className="theia-button secondary"
                    disabled={!sketchSelected}
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
                    disabled={!sketchSelected}
                    onClick={() => props.onStartFeatureCreation('groove')}
                >
                    <span className="codicon codicon-discard" /> Groove
                </button>
            </Tooltip>
            {doc !== undefined && (
                <span className="cad-document-name">
                    {doc.name}
                    {props.documentStore.dirty && <span className="cad-document-dirty" />}
                </span>
            )}
        </div>
    );
}

interface FeatureCreationDialogProps {
    readonly type: FeatureType;
    readonly sketchId?: string;
    readonly onCancel: () => void;
    readonly onConfirm: (type: FeatureType, params: FeatureParams) => void;
}

function FeatureCreationDialog(props: FeatureCreationDialogProps): React.ReactElement {
    const type = props.type;
    const isExtrude = type === 'pad' || type === 'pocket';
    const isRevolve = type === 'revolve' || type === 'groove';
    const [length, setLength] = React.useState('1');
    const [axis, setAxis] = React.useState<'x' | 'y' | 'z'>('z');
    const [symmetric, setSymmetric] = React.useState(false);
    const [angle, setAngle] = React.useState('90');
    const [label, setLabel] = React.useState(`${type}_1`);
    const [error, setError] = React.useState<string | undefined>();

    const submit = (): void => {
        if (props.sketchId === undefined) {
            setError('No sketch is selected.');
            return;
        }
        if (isExtrude) {
            const value = Number(length);
            if (!Number.isFinite(value) || value <= 0) {
                setError('Length must be a positive number.');
                return;
            }
            props.onConfirm(type, { length: value, axis, symmetric, label });
        } else if (isRevolve) {
            const value = Number(angle);
            if (!Number.isFinite(value) || value <= 0 || value > 360) {
                setError('Angle must be in (0, 360].');
                return;
            }
            props.onConfirm(type, { axis, angle: value, label });
        }
    };

    return (
        <div className="cad-feature-dialog">
            <div className="cad-feature-dialog-title">{capitalize(type)}</div>
            {error !== undefined && <div className="cad-feature-dialog-error">{error}</div>}
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
            <label className="cad-feature-dialog-row">
                Label
                <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} />
            </label>
            <div className="cad-feature-dialog-actions">
                <button className="theia-button" onClick={submit}>
                    <span className="codicon codicon-check" /> Create
                </button>
                <button className="theia-button secondary" onClick={props.onCancel}>
                    <span className="codicon codicon-close" /> Cancel
                </button>
            </div>
        </div>
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
        <div className="cad-sketch-parameters-panel">
            <div className="cad-sketch-parameters-header">
                <span>Parameters</span>
                <button className="theia-button secondary" onClick={onClose}>
                    <span className="codicon codicon-close" />
                </button>
            </div>
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
        </div>
    );
}

interface DiagnosticsPopoverProps {
    status: SketchStatus;
    constraints: Array<{ id: string; kind: ConstraintKind; targetIds: string[] }>;
    onHighlight: (kind: 'conflicting' | 'redundant') => void;
    onClose: () => void;
}

function DiagnosticsPopover(props: DiagnosticsPopoverProps): React.ReactElement {
    const { status, constraints, onHighlight, onClose } = props;
    const findConstraint = (id: string) => constraints.find((c) => c.id === id);

    return (
        <div className="cad-sketch-diagnostics-popover">
            <div className="cad-sketch-diagnostics-header">
                <span>Solver Diagnostics</span>
                <button className="theia-button secondary" onClick={onClose}>
                    <span className="codicon codicon-close" />
                </button>
            </div>
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
            {status.conflicting.length === 0 && status.redundant.length === 0 && (
                <div className="cad-sketch-diagnostics-empty">No diagnostics to report.</div>
            )}
        </div>
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

function buildStatusText(status: SketchStatus): string {
    const parts: string[] = [];
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
