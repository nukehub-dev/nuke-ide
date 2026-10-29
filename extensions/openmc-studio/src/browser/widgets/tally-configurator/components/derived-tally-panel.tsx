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
import { ColorPicker, NukeSelect, Tooltip } from 'nuke-essentials/lib/theme/browser/components';
import { OpenMCDerivedExpression, OpenMCDerivedTally, OpenMCMesh, OpenMCTally } from '../../../../common/openmc-state-schema';
import {
    appendDerivedToken,
    DerivedTallyValidationIssue,
    derivedFormulaPreview,
    estimateDerivedBins,
    expressionToTokens,
    formatDerivedExpression,
    OpenMCDerivedToken,
    removeLastDerivedToken,
    tokensToExpression,
    validateDerivedTally
} from '../../../../common/derived-tallies';

interface DerivedTallyPanelProps {
    derivedTallies: OpenMCDerivedTally[];
    tallies: OpenMCTally[];
    meshes: OpenMCMesh[];
    onAdd: (derivedTally: OpenMCDerivedTally) => void;
    onUpdate: (id: number, updates: Partial<OpenMCDerivedTally>) => void;
    onDelete: (id: number) => void;
}

interface DerivedTallyPanelState {
    selectedId?: number;
    draft?: OpenMCDerivedTally;
    tokens: OpenMCDerivedToken[];
    selectedTallyId?: number;
    selectedScore?: string;
    selectedNuclide?: string;
    scalarValue: string;
    deleteConfirmId?: number;
}

const DEFAULT_COLOR = '#4a9eff';

/** Pick a sensible initial score for the operand picker. */
function firstScore(tally: OpenMCTally | undefined): string | undefined {
    return tally?.scores[0];
}

/**
 * Derived Tallies tab: list + visual expression builder.
 *
 * The builder is token-first (operand/operator/parenthesis buttons and
 * keyboard shortcuts); the persisted expression is parsed from those tokens so
 * precedence is never inferred by string concatenation at evaluation time.
 */
export class DerivedTallyPanel extends React.Component<DerivedTallyPanelProps, DerivedTallyPanelState> {
    constructor(props: DerivedTallyPanelProps) {
        super(props);
        this.state = {
            tokens: [],
            scalarValue: '1'
        };
    }

    componentDidUpdate(previousProps: DerivedTallyPanelProps): void {
        if (previousProps.derivedTallies === this.props.derivedTallies) {
            return;
        }
        if (this.state.selectedId !== undefined && !this.props.derivedTallies.some((entry) => entry.id === this.state.selectedId)) {
            this.setState({ selectedId: undefined, draft: undefined, tokens: [], deleteConfirmId: undefined });
        }
    }

    private startNew(): void {
        const nextId = this.props.derivedTallies.reduce((max, entry) => Math.max(max, entry.id), 0) + 1;
        const draft: OpenMCDerivedTally = {
            id: nextId,
            name: `Derived ${nextId}`,
            expression: { kind: 'scalar', value: 1 },
            unit: '',
            color: DEFAULT_COLOR
        };
        const tally = this.props.tallies[0];
        this.setState({
            selectedId: nextId,
            draft,
            tokens: [],
            selectedTallyId: tally?.id,
            selectedScore: firstScore(tally),
            selectedNuclide: undefined,
            deleteConfirmId: undefined
        });
    }

    private selectDerived(derived: OpenMCDerivedTally): void {
        const operands = expressionToTokens(derived.expression).filter((token) => token.kind === 'operand');
        const firstTally = operands.find((token) => token.kind === 'operand' && token.operand.kind === 'tally');
        const tallyId =
            firstTally?.kind === 'operand' && firstTally.operand.kind === 'tally' ? firstTally.operand.tallyId : this.props.tallies[0]?.id;
        const tally = this.props.tallies.find((entry) => entry.id === tallyId);
        const selectedScore =
            firstTally?.kind === 'operand' && firstTally.operand.kind === 'tally' ? firstTally.operand.score : firstScore(tally);
        const selectedNuclide =
            firstTally?.kind === 'operand' && firstTally.operand.kind === 'tally' ? firstTally.operand.nuclide : undefined;
        this.setState({
            selectedId: derived.id,
            draft: { ...derived },
            tokens: expressionToTokens(derived.expression),
            selectedTallyId: tallyId,
            selectedScore,
            selectedNuclide,
            deleteConfirmId: undefined
        });
    }

    private updateDraft(updates: Partial<OpenMCDerivedTally>): void {
        if (!this.state.draft) {
            return;
        }
        this.setState({ draft: { ...this.state.draft, ...updates } });
    }

    private appendToken(token: OpenMCDerivedToken): void {
        this.setState((state) => ({ tokens: appendDerivedToken(state.tokens, token) }));
    }

    private appendOperand(): void {
        const tally = this.props.tallies.find((entry) => entry.id === this.state.selectedTallyId);
        if (!tally) {
            return;
        }
        const score = this.state.selectedScore ?? firstScore(tally);
        if (!score) {
            return;
        }
        this.appendToken({
            kind: 'operand',
            operand: {
                kind: 'tally',
                tallyId: tally.id,
                score,
                ...(this.state.selectedNuclide ? { nuclide: this.state.selectedNuclide } : {})
            }
        });
    }

    private appendScalar(): void {
        const value = Number(this.state.scalarValue);
        if (!Number.isFinite(value)) {
            return;
        }
        this.appendToken({ kind: 'operand', operand: { kind: 'scalar', value } });
    }

    private handleEditorKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
        if (event.key === 'Backspace') {
            event.preventDefault();
            this.setState((state) => ({ tokens: removeLastDerivedToken(state.tokens) }));
        } else if (event.key === 'Enter') {
            event.preventDefault();
            this.appendOperand();
        } else if (event.key === 'Escape') {
            event.preventDefault();
            this.setState({ selectedId: undefined, draft: undefined, tokens: [] });
        }
    }

    private parseDraft(): { expression?: OpenMCDerivedExpression; error?: string } {
        if (this.state.tokens.length === 0) {
            return { error: 'Expression is empty. Add at least one tally score operand.' };
        }
        return tokensToExpression(this.state.tokens);
    }

    private validationIssues(expression: OpenMCDerivedExpression, parseError?: string): DerivedTallyValidationIssue[] {
        const draft = this.state.draft;
        if (!draft) {
            return [];
        }
        const issues = validateDerivedTally({ id: draft.id, name: draft.name, expression }, this.props.tallies, this.props.derivedTallies);
        if (parseError) {
            issues.unshift({ severity: 'error', code: 'invalid-expression', message: parseError });
        }
        return issues;
    }

    private save(): void {
        const draft = this.state.draft;
        if (!draft) {
            return;
        }
        const parsed = this.parseDraft();
        const expression = parsed.expression ?? draft.expression;
        const issues = this.validationIssues(expression, parsed.error);
        if (issues.some((issue) => issue.severity === 'error')) {
            return;
        }
        const saved: OpenMCDerivedTally = {
            ...draft,
            name: draft.name.trim(),
            expression,
            unit: draft.unit?.trim() || undefined,
            color: draft.color || DEFAULT_COLOR
        };
        if (this.props.derivedTallies.some((entry) => entry.id === saved.id)) {
            this.props.onUpdate(saved.id, saved);
        } else {
            this.props.onAdd(saved);
        }
        this.setState({ selectedId: saved.id, draft: saved, tokens: expressionToTokens(expression) });
    }

    render(): React.ReactNode {
        return (
            <div className="derived-tab-container">
                <div className="derived-list-panel">{this.renderList()}</div>
                <div className="derived-builder-panel">{this.renderBuilder()}</div>
            </div>
        );
    }

    private renderList(): React.ReactNode {
        const { derivedTallies } = this.props;
        return (
            <div className="derived-list">
                <div className="panel-header">
                    <h3>
                        <i className="codicon codicon-openmc-derived"></i>
                        Derived Tallies
                    </h3>
                    <button className="add-button" onClick={() => this.startNew()} aria-label="Add derived tally">
                        <i className="codicon codicon-add"></i>
                    </button>
                </div>
                {derivedTallies.length === 0 ? (
                    <div className="empty-state derived-empty-state">
                        <i className="codicon codicon-openmc-derived"></i>
                        <p>
                            No derived tallies yet. Combine tallies into ratios, sums, or products — for example, capture-to-fission ratio.
                        </p>
                        <button className="theia-button primary" onClick={() => this.startNew()}>
                            <i className="codicon codicon-add"></i>
                            Create Derived Tally
                        </button>
                    </div>
                ) : (
                    <div className="derived-list-container">
                        {derivedTallies.map((derived) => {
                            const isSelected = derived.id === this.state.selectedId;
                            return (
                                <div
                                    key={derived.id}
                                    className={`derived-card ${isSelected ? 'active' : ''}`}
                                    data-derived-id={derived.id}
                                    role="button"
                                    tabIndex={0}
                                    onClick={() => this.selectDerived(derived)}
                                    onKeyDown={(event) => {
                                        if (event.key === 'Enter' || event.key === ' ') {
                                            event.preventDefault();
                                            this.selectDerived(derived);
                                        }
                                    }}
                                >
                                    <div className="derived-card-main">
                                        <span className="derived-card-color" style={{ background: derived.color || DEFAULT_COLOR }}></span>
                                        <div className="derived-card-info">
                                            <div className="derived-card-name">{derived.name}</div>
                                            <code className="derived-card-formula">{formatDerivedExpression(derived.expression)}</code>
                                            {derived.unit && <span className="derived-card-unit">[{derived.unit}]</span>}
                                        </div>
                                    </div>
                                    <div className="derived-card-actions">
                                        {this.state.deleteConfirmId === derived.id ? (
                                            <>
                                                <span className="derived-delete-question">Delete?</span>
                                                <button
                                                    className="delete-item-btn danger"
                                                    aria-label={`Confirm delete ${derived.name}`}
                                                    onClick={(event) => {
                                                        event.stopPropagation();
                                                        this.props.onDelete(derived.id);
                                                        this.setState({ deleteConfirmId: undefined });
                                                    }}
                                                >
                                                    <i className="codicon codicon-check"></i>
                                                </button>
                                                <button
                                                    className="delete-item-btn"
                                                    aria-label="Cancel delete"
                                                    onClick={(event) => {
                                                        event.stopPropagation();
                                                        this.setState({ deleteConfirmId: undefined });
                                                    }}
                                                >
                                                    <i className="codicon codicon-close"></i>
                                                </button>
                                            </>
                                        ) : (
                                            <Tooltip content="Delete this derived tally" position="top">
                                                <button
                                                    className="delete-item-btn"
                                                    aria-label={`Delete ${derived.name}`}
                                                    onClick={(event) => {
                                                        event.stopPropagation();
                                                        this.setState({ deleteConfirmId: derived.id });
                                                    }}
                                                >
                                                    <i className="codicon codicon-trash"></i>
                                                </button>
                                            </Tooltip>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
                <p className="derived-postprocessing-note">
                    Post-processing only — derived tallies are not written to simulation XML or Python.
                </p>
            </div>
        );
    }

    private renderBuilder(): React.ReactNode {
        const draft = this.state.draft;
        if (!draft) {
            return (
                <div className="derived-builder-empty">
                    <i className="codicon codicon-openmc-derived"></i>
                    <p>
                        Select a derived tally to edit, or create a new one to combine tally scores into a ratio, sum, difference, or
                        product.
                    </p>
                </div>
            );
        }

        const parsed = this.parseDraft();
        const expression = parsed.expression ?? draft.expression;
        const issues = this.validationIssues(expression, parsed.error);
        const errors = issues.filter((issue) => issue.severity === 'error');
        const estimatedBins = parsed.expression ? estimateDerivedBins(parsed.expression, this.props.tallies, this.props.meshes) : undefined;
        const selectedTally = this.props.tallies.find((entry) => entry.id === this.state.selectedTallyId) ?? this.props.tallies[0];
        const scores = selectedTally?.scores ?? [];
        const nuclides = selectedTally?.nuclides ?? [];
        const formula = this.state.tokens.length > 0 ? derivedFormulaPreview(this.state.tokens) : 'No expression yet';

        return (
            <div className="derived-builder">
                <div className="derived-builder-header">
                    <h3>{this.props.derivedTallies.some((entry) => entry.id === draft.id) ? 'Edit Derived Tally' : 'New Derived Tally'}</h3>
                    <span className="derived-badge">DERIVED</span>
                </div>

                <section className="derived-section">
                    <h4>
                        <span className="derived-step">1</span>
                        Operands
                    </h4>
                    <p className="section-description">Add a tally score, optionally restricted to one nuclide, or a scalar constant.</p>
                    {this.props.tallies.length === 0 ? (
                        <p className="derived-hint">
                            No simulation tallies exist yet. Create a tally first, then return to build a derived tally.
                        </p>
                    ) : (
                        <>
                            <div className="form-row">
                                <div className="form-group">
                                    <Tooltip content="Tally whose scores feed this operand" position="top">
                                        <label>Tally</label>
                                    </Tooltip>
                                    <NukeSelect
                                        value={selectedTally ? String(selectedTally.id) : ''}
                                        options={this.props.tallies.map((tally) => ({
                                            value: String(tally.id),
                                            label: `Tally ${tally.id}${tally.name ? `: ${tally.name}` : ''}`
                                        }))}
                                        onChange={(value: string) => {
                                            const tally = this.props.tallies.find((entry) => String(entry.id) === value);
                                            this.setState({
                                                selectedTallyId: tally?.id,
                                                selectedScore: firstScore(tally),
                                                selectedNuclide: undefined
                                            });
                                        }}
                                        ariaLabel="Derived tally operand tally"
                                    />
                                </div>
                                <div className="form-group">
                                    <Tooltip content="Score from the selected tally" position="top">
                                        <label>Score</label>
                                    </Tooltip>
                                    <NukeSelect
                                        value={this.state.selectedScore ?? firstScore(selectedTally) ?? ''}
                                        options={scores.map((score) => ({ value: score, label: score }))}
                                        onChange={(value: string) => this.setState({ selectedScore: value })}
                                        ariaLabel="Derived tally operand score"
                                    />
                                    {scores.length === 0 && (
                                        <p className="form-hint">This tally has no scores yet — add one in the Tallies tab.</p>
                                    )}
                                </div>
                                <div className="form-group">
                                    <Tooltip content="Restrict the operand to one nuclide, or keep all scored nuclides" position="top">
                                        <label>Nuclide</label>
                                    </Tooltip>
                                    <NukeSelect
                                        value={this.state.selectedNuclide ?? ''}
                                        options={[
                                            { value: '', label: 'All scored nuclides' },
                                            ...nuclides.map((nuclide) => ({ value: nuclide, label: nuclide }))
                                        ]}
                                        onChange={(value: string) => this.setState({ selectedNuclide: value || undefined })}
                                        ariaLabel="Derived tally operand nuclide"
                                    />
                                </div>
                            </div>
                            <div className="derived-operand-actions">
                                <button
                                    className="theia-button primary"
                                    onClick={() => this.appendOperand()}
                                    disabled={!selectedTally || !(this.state.selectedScore ?? firstScore(selectedTally))}
                                >
                                    <i className="codicon codicon-add"></i>
                                    Add operand
                                </button>
                                <div className="derived-scalar-row">
                                    <label htmlFor="derived-scalar-value">Scalar</label>
                                    <input
                                        id="derived-scalar-value"
                                        type="number"
                                        step="any"
                                        value={this.state.scalarValue}
                                        onChange={(event) => this.setState({ scalarValue: event.target.value })}
                                    />
                                    <button className="theia-button secondary" onClick={() => this.appendScalar()}>
                                        Add scalar
                                    </button>
                                </div>
                            </div>
                            <div className="derived-operand-chips" aria-label="Quick operands">
                                {this.props.tallies.flatMap((tally) =>
                                    tally.scores.map((score) => (
                                        <Tooltip
                                            key={`${tally.id}-${score}`}
                                            content={`Add T${tally.id} ${score} to the expression`}
                                            position="top"
                                        >
                                            <button
                                                className="derived-operand-chip"
                                                onClick={() =>
                                                    this.appendToken({
                                                        kind: 'operand',
                                                        operand: { kind: 'tally', tallyId: tally.id, score }
                                                    })
                                                }
                                            >
                                                T{tally.id} · {score}
                                            </button>
                                        </Tooltip>
                                    ))
                                )}
                            </div>
                        </>
                    )}
                </section>

                <section className="derived-section">
                    <h4>
                        <span className="derived-step">2</span>
                        Expression
                    </h4>
                    <div
                        className="derived-token-editor"
                        tabIndex={0}
                        role="group"
                        aria-label="Derived tally expression tokens"
                        onKeyDown={(event) => this.handleEditorKeyDown(event)}
                    >
                        {this.state.tokens.length === 0 ? (
                            <span className="derived-token-placeholder">
                                Add an operand to start — Backspace removes the last token, Escape cancels.
                            </span>
                        ) : (
                            this.state.tokens.map((token, index) => (
                                <span key={`${index}-${token.kind}`} className={`derived-token derived-token--${token.kind}`}>
                                    {token.kind === 'operand'
                                        ? formatDerivedExpression(token.operand)
                                        : token.kind === 'operator'
                                          ? token.op
                                          : token.value}
                                </span>
                            ))
                        )}
                    </div>
                    <div className="derived-token-toolbar">
                        {(['+', '-', '*', '/'] as const).map((op) => (
                            <Tooltip
                                key={op}
                                content={`Append the ${op === '*' ? 'multiply' : op === '/' ? 'divide' : op === '+' ? 'add' : 'subtract'} operator`}
                                position="top"
                            >
                                <button
                                    className="derived-token-button"
                                    aria-label={`Append ${op} operator`}
                                    onClick={() => this.appendToken({ kind: 'operator', op })}
                                >
                                    {op === '*' ? '×' : op === '/' ? '÷' : op}
                                </button>
                            </Tooltip>
                        ))}
                        <Tooltip content="Open a group" position="top">
                            <button
                                className="derived-token-button"
                                aria-label="Append open parenthesis"
                                onClick={() => this.appendToken({ kind: 'paren', value: '(' })}
                            >
                                (
                            </button>
                        </Tooltip>
                        <Tooltip content="Close a group" position="top">
                            <button
                                className="derived-token-button"
                                aria-label="Append close parenthesis"
                                onClick={() => this.appendToken({ kind: 'paren', value: ')' })}
                            >
                                )
                            </button>
                        </Tooltip>
                        <Tooltip content="Remove the last token (Backspace)" position="top">
                            <button
                                className="derived-token-button"
                                aria-label="Backspace expression token"
                                onClick={() => this.setState((state) => ({ tokens: removeLastDerivedToken(state.tokens) }))}
                            >
                                <i className="codicon codicon-chevron-left"></i>
                            </button>
                        </Tooltip>
                        <Tooltip content="Clear the whole expression" position="top">
                            <button
                                className="derived-token-button"
                                aria-label="Clear expression"
                                onClick={() => this.setState({ tokens: [] })}
                            >
                                Clear
                            </button>
                        </Tooltip>
                    </div>
                    <div className="derived-formula-row">
                        <span className="derived-formula-label">Formula</span>
                        <code className="derived-formula-preview">{formula}</code>
                    </div>
                </section>

                <section className="derived-section">
                    <h4>
                        <span className="derived-step">3</span>
                        Preview
                    </h4>
                    {errors.length === 0 ? (
                        <p className="derived-preview-ok">
                            <i className="codicon codicon-check"></i>
                            Ready — will produce {estimatedBins ?? 'at least 1'} bin{estimatedBins === 1 ? '' : 's'} from the current
                            filters.
                        </p>
                    ) : (
                        <ul className="derived-validation-list">
                            {errors.map((issue) => (
                                <li key={issue.code + issue.message} className="validation-error">
                                    <i className="codicon codicon-error"></i>
                                    {issue.message}
                                </li>
                            ))}
                        </ul>
                    )}
                    {estimatedBins === undefined && errors.length === 0 && (
                        <p className="validation-warning">
                            <i className="codicon codicon-warning"></i>
                            The bin count could not be estimated; check that both tallies use the same filter bins.
                        </p>
                    )}
                    <p className="derived-caveat">
                        <i className="codicon codicon-info"></i>
                        Uncertainty assumes independent tallies. Correlated tallies can under-predict the true uncertainty.
                    </p>
                </section>

                <section className="derived-section">
                    <h4>
                        <span className="derived-step">4</span>
                        Display
                    </h4>
                    <div className="form-row">
                        <div className="form-group">
                            <Tooltip content="Name shown in the derived-tally list and statepoint results" position="top">
                                <label>Name</label>
                            </Tooltip>
                            <input
                                type="text"
                                value={draft.name}
                                onChange={(event) => this.updateDraft({ name: event.target.value })}
                                placeholder={`Derived ${draft.id}`}
                                aria-label="Derived tally name"
                            />
                        </div>
                        <div className="form-group">
                            <Tooltip content="Unit label used in plots and result tables" position="top">
                                <label>Unit</label>
                            </Tooltip>
                            <input
                                type="text"
                                value={draft.unit ?? ''}
                                onChange={(event) => this.updateDraft({ unit: event.target.value })}
                                placeholder="ratio, cm^-2, W…"
                                aria-label="Derived tally unit"
                            />
                        </div>
                    </div>
                    <div className="form-row">
                        <div className="form-group derived-color-group">
                            <label>Color</label>
                            <div className="derived-color-row">
                                <ColorPicker value={draft.color || DEFAULT_COLOR} onChange={(color) => this.updateDraft({ color })} />
                                <code>{draft.color || DEFAULT_COLOR}</code>
                            </div>
                        </div>
                        <div className="form-group derived-description-group">
                            <label>Description</label>
                            <input
                                type="text"
                                value={draft.description ?? ''}
                                onChange={(event) => this.updateDraft({ description: event.target.value })}
                                placeholder="What this expression means"
                                aria-label="Derived tally description"
                            />
                        </div>
                    </div>
                </section>

                <div className="derived-builder-actions">
                    <button className="theia-button primary" onClick={() => this.save()} disabled={errors.length > 0}>
                        <i className="codicon codicon-save"></i>
                        {this.props.derivedTallies.some((entry) => entry.id === draft.id) ? 'Update derived tally' : 'Save derived tally'}
                    </button>
                    <button
                        className="theia-button secondary"
                        onClick={() => this.setState({ selectedId: undefined, draft: undefined, tokens: [] })}
                    >
                        Cancel
                    </button>
                </div>
            </div>
        );
    }
}
