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
 * @module nuke-cad/browser/widgets
 */

import * as React from '@theia/core/shared/react';
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components/tooltip';
import { SketchModeController } from '../../sketch/sketch-mode-controller';
import { type SketchTool, type ConstraintKind } from '../../sketch/sketch-session';
import { type DatumKind } from '../../sketch/sketch-math';

interface CadSketchOverlayProps {
    readonly controller: SketchModeController;
    readonly setupVisible: boolean;
    readonly onEnterSketch: (kind: DatumKind, offset: number) => void;
    readonly onExitSketch: () => void;
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
    const { controller, setupVisible, onEnterSketch, onExitSketch } = props;
    const [, forceUpdate] = React.useReducer((n) => n + 1, 0);

    React.useEffect(() => {
        return controller.onChange(forceUpdate);
    }, [controller, forceUpdate]);

    const active = controller.isActive;
    const tool = controller.getTool();
    const construction = controller.getConstruction();
    const status = controller.getStatus();
    const constraintInput = controller.getConstraintInput();

    const [value, setValue] = React.useState('');
    const [datumKind, setDatumKind] = React.useState<DatumKind>('XY');
    const [offset, setOffset] = React.useState('0');

    const needsValue =
        constraintInput !== undefined &&
        VALUE_CONSTRAINTS.has(constraintInput.kind) &&
        constraintInput.targetIds.length === arityFor(constraintInput.kind);

    React.useEffect(() => {
        setValue('');
    }, [constraintInput?.kind, constraintInput?.targetIds.length]);

    const applyValue = (): void => {
        if (constraintInput === undefined) {
            return;
        }
        const num = Number(value);
        if (!Number.isFinite(num)) {
            return;
        }
        void controller.applyConstraintValue(constraintInput.kind, num);
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
        if (e.key === 'Enter') {
            applyValue();
        } else if (e.key === 'Escape') {
            controller.cancel();
        }
    };

    const statusText = buildStatusText(status);

    return (
        <div className="cad-sketch-overlay">
            {setupVisible && !active && (
                <div className="cad-sketch-datum-picker">
                    <div className="cad-sketch-datum-title">Sketch Plane</div>
                    <div className="cad-sketch-datum-buttons">
                        {(['XY', 'YZ', 'XZ'] as DatumKind[]).map((kind) => (
                            <button
                                key={kind}
                                className={`theia-button secondary ${datumKind === kind ? 'active' : ''}`}
                                onClick={() => setDatumKind(kind)}
                            >
                                {kind}
                            </button>
                        ))}
                    </div>
                    <label className="cad-sketch-datum-offset">
                        Offset
                        <input
                            type="number"
                            value={offset}
                            onChange={(e) => setOffset(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    onEnterSketch(datumKind, Number(offset));
                                } else if (e.key === 'Escape') {
                                    onExitSketch();
                                }
                            }}
                        />
                    </label>
                    <div className="cad-sketch-datum-actions">
                        <button className="theia-button secondary" onClick={() => onEnterSketch(datumKind, Number(offset))}>
                            Start Sketch
                        </button>
                        <button className="theia-button secondary" onClick={onExitSketch}>
                            Cancel
                        </button>
                    </div>
                </div>
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
                        <Tooltip content="Exit Sketch" position="right">
                            <button className="theia-button secondary cad-sketch-tool-button" onClick={onExitSketch}>
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
                                    type="number"
                                    value={value}
                                    onChange={(e) => setValue(e.target.value)}
                                    onKeyDown={onKeyDown}
                                    autoFocus
                                />
                            </label>
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
                </>
            )}

            {active && <div className="cad-sketch-status-line">{statusText}</div>}
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
            return 'Radius';
        case 'angle':
            return 'Angle (rad)';
        default:
            return 'Value';
    }
}

function buildStatusText(status: import('../../sketch/sketch-session').SketchStatus): string {
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
