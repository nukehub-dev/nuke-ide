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
 * Feature tree panel for `.nuke-cad` documents.
 *
 * Lists datums, sketches, and features in document order. Each row exposes
 * selection, suppression toggle, and build-status markers from the last
 * document rebuild. Sketches can be edited and features can be deleted (with
 * dependent rejection surfaced inline).
 *
 * @module nuke-cad/browser/widgets
 */

import * as React from '@theia/core/shared/react';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { Disposable } from '@theia/core/lib/common/disposable';
import { MessageService } from '@theia/core/lib/common/message-service';
import { CommandService } from '@theia/core/lib/common/command';
import { NukeCadCommands } from '../../commands';
import { CadDocumentStore } from '../../document/cad-document-store';
import { type NukeCadDocument, type FeatureDef, type SketchDef, type DatumPlane } from '../../../common/cad-document';
import { type FeatureResult } from '../../../common/nuke-cad-protocol';
import { type DocumentSelection } from '../../document/cad-document-store';
import { Tooltip, useTooltip } from 'nuke-essentials/lib/theme/browser/components/tooltip';
import './feature-tree.css';

@injectable()
export class CadFeatureTreeWidget extends ReactWidget {
    static readonly ID = 'nuke-cad-feature-tree-widget';
    static readonly LABEL = 'Feature Tree';

    @inject(MessageService)
    protected readonly messageService: MessageService;

    @inject(CommandService)
    protected readonly commandService: CommandService;

    @inject(CadDocumentStore)
    protected readonly documentStore: CadDocumentStore;

    @postConstruct()
    protected init(): void {
        this.id = CadFeatureTreeWidget.ID;
        this.title.label = CadFeatureTreeWidget.LABEL;
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-list-tree';

        this.toDispose.push(Disposable.create(this.documentStore.onChange(() => this.update())));
        this.update();
    }

    protected render(): React.ReactNode {
        return (
            <CadFeatureTreeComponent
                document={this.documentStore.document}
                selection={this.documentStore.selection}
                featureResults={this.documentStore.featureResults}
                onSelectSketch={(id) => this.documentStore.selectSketch(id)}
                onSelectFeature={(id) => this.documentStore.selectFeature(id)}
                onToggleSuppressed={(id, value) => this.handleToggleSuppressed(id, value)}
                onDeleteFeature={(id) => this.handleDeleteFeature(id)}
                onEditSketch={(id) => this.commandService.executeCommand(NukeCadCommands.NEW_SKETCH.id)}
                onNewSketch={() => this.commandService.executeCommand(NukeCadCommands.NEW_SKETCH.id)}
                onStartFeatureCreation={(type) => {
                    const command =
                        type === 'pad'
                            ? NukeCadCommands.ADD_FEATURE_PAD
                            : type === 'pocket'
                              ? NukeCadCommands.ADD_FEATURE_POCKET
                              : type === 'revolve'
                                ? NukeCadCommands.ADD_FEATURE_REVOLVE
                                : NukeCadCommands.ADD_FEATURE_GROOVE;
                    void this.commandService.executeCommand(command.id);
                }}
            />
        );
    }

    private handleToggleSuppressed(id: string, value: boolean): void {
        const result = this.documentStore.setFeatureSuppressed(id, value);
        if (!result.success) {
            this.messageService.error(result.error || 'Failed to toggle suppression.');
        }
    }

    private handleDeleteFeature(id: string): void {
        const result = this.documentStore.deleteFeature(id);
        if (!result.success) {
            this.messageService.error(result.error || 'Failed to delete feature.');
        }
    }
}

interface CadFeatureTreeComponentProps {
    readonly document?: NukeCadDocument;
    readonly selection: DocumentSelection;
    readonly featureResults: ReadonlyMap<string, FeatureResult>;
    readonly onSelectSketch: (id: string | undefined) => void;
    readonly onSelectFeature: (id: string | undefined) => void;
    readonly onToggleSuppressed: (id: string, value: boolean) => void;
    readonly onDeleteFeature: (id: string) => void;
    readonly onEditSketch: (id: string) => void;
    readonly onNewSketch: () => void;
    readonly onStartFeatureCreation: (type: 'pad' | 'pocket' | 'revolve' | 'groove') => void;
}

function CadFeatureTreeComponent(props: CadFeatureTreeComponentProps): React.ReactElement {
    const doc = props.document;
    const hasContent = doc !== undefined && (doc.datums.length > 0 || doc.sketches.length > 0 || doc.features.length > 0);

    return (
        <div className="cad-feature-tree-panel">
            <div className="cad-feature-tree-header">
                <div className="header-info">
                    <h2>
                        <i className="codicon codicon-list-tree" />
                        Feature Tree
                    </h2>
                    <p className="header-description">{doc?.name ?? 'No CAD document open'}</p>
                </div>
            </div>

            {!doc && (
                <div className="cad-feature-tree-empty">
                    <i className="codicon codicon-list-tree" />
                    <p>No CAD document is open.</p>
                    <span className="empty-hint">Create or open a .nuke-cad document to edit its feature tree.</span>
                </div>
            )}

            {doc && !hasContent && (
                <div className="cad-feature-tree-empty">
                    <i className="codicon codicon-circle-outline" />
                    <p>This document is empty.</p>
                    <button className="theia-button" onClick={props.onNewSketch}>
                        <span className="codicon codicon-add" /> New Sketch
                    </button>
                </div>
            )}

            {doc && hasContent && (
                <div className="cad-feature-tree-content">
                    <TreeSection title="Datums" count={doc.datums.length}>
                        {doc.datums.map((datum) => (
                            <DatumRow key={datum.id} datum={datum} />
                        ))}
                    </TreeSection>

                    <TreeSection title="Sketches" count={doc.sketches.length}>
                        {doc.sketches.map((sketch) => (
                            <SketchRow
                                key={sketch.id}
                                sketch={sketch}
                                selected={props.selection.selectedSketchId === sketch.id}
                                onSelect={() => props.onSelectSketch(sketch.id)}
                                onEdit={() => props.onEditSketch(sketch.id)}
                            />
                        ))}
                    </TreeSection>

                    <TreeSection title="Features" count={doc.features.length}>
                        {doc.features.map((feature, index) => (
                            <FeatureRow
                                key={feature.id}
                                feature={feature}
                                index={index}
                                result={props.featureResults.get(feature.id)}
                                selected={props.selection.selectedFeatureId === feature.id}
                                onSelect={() => props.onSelectFeature(feature.id)}
                                onToggleSuppressed={props.onToggleSuppressed}
                                onDelete={props.onDeleteFeature}
                                onEditParams={() => props.onStartFeatureCreation(feature.type as 'pad' | 'pocket' | 'revolve' | 'groove')}
                            />
                        ))}
                    </TreeSection>
                </div>
            )}
        </div>
    );
}

interface TreeSectionProps {
    readonly title: string;
    readonly count: number;
    readonly children: React.ReactNode;
}

function TreeSection(props: TreeSectionProps): React.ReactElement {
    const [collapsed, setCollapsed] = React.useState(false);
    return (
        <div className="feature-tree-section">
            <div className="category-header" onClick={() => setCollapsed(!collapsed)}>
                <i className={`codicon codicon-chevron-${collapsed ? 'right' : 'down'}`} />
                <span>{props.title}</span>
                <span className="count-badge">{props.count}</span>
            </div>
            {!collapsed && <div className="feature-tree-rows">{props.children}</div>}
        </div>
    );
}

interface DatumRowProps {
    readonly datum: DatumPlane;
}

function DatumRow(props: DatumRowProps): React.ReactElement {
    const tooltip = useTooltip(`${props.datum.kind}${props.datum.offset !== undefined ? ` offset ${props.datum.offset}` : ''}`, 'right');
    return (
        <>
            <div className="feature-tree-row datum" onMouseEnter={tooltip.onMouseEnter} onMouseLeave={tooltip.onMouseLeave}>
                <span className="codicon codicon-globe feature-tree-icon" />
                <span className="feature-tree-label">{props.datum.name}</span>
            </div>
            {tooltip.tooltipElement}
        </>
    );
}

interface SketchRowProps {
    readonly sketch: SketchDef;
    readonly selected: boolean;
    readonly onSelect: () => void;
    readonly onEdit: () => void;
}

function SketchRow(props: SketchRowProps): React.ReactElement {
    const tooltip = useTooltip('Click to select, edit to enter sketch mode', 'right');
    return (
        <>
            <div
                className={`feature-tree-row sketch${props.selected ? ' selected' : ''}`}
                onClick={props.onSelect}
                onMouseEnter={tooltip.onMouseEnter}
                onMouseLeave={tooltip.onMouseLeave}
            >
                <span className="codicon codicon-circle-outline feature-tree-icon" />
                <span className="feature-tree-label">{props.sketch.name}</span>
                <Tooltip content="Edit Sketch" position="left">
                    <button
                        className="theia-button secondary feature-tree-action"
                        onClick={(e) => {
                            e.stopPropagation();
                            props.onEdit();
                        }}
                    >
                        <span className="codicon codicon-edit" />
                    </button>
                </Tooltip>
            </div>
            {tooltip.tooltipElement}
        </>
    );
}

interface FeatureRowProps {
    readonly feature: FeatureDef;
    readonly index: number;
    readonly result?: FeatureResult;
    readonly selected: boolean;
    readonly onSelect: () => void;
    readonly onToggleSuppressed: (id: string, value: boolean) => void;
    readonly onDelete: (id: string) => void;
    readonly onEditParams: () => void;
}

function FeatureRow(props: FeatureRowProps): React.ReactElement {
    const { feature, result } = props;
    const status = result?.status ?? 'stale';
    const statusClass = `status-${status}`;
    const statusTooltip = result?.error ?? `${status}`;
    const tooltip = useTooltip(statusTooltip, 'right');

    return (
        <>
            <div
                className={`feature-tree-row feature${props.selected ? ' selected' : ''} ${statusClass}`}
                onClick={props.onSelect}
                onMouseEnter={tooltip.onMouseEnter}
                onMouseLeave={tooltip.onMouseLeave}
            >
                <span className={`codicon ${iconForFeature(feature.type)} feature-tree-icon`} />
                <span className="feature-tree-label">{feature.name}</span>
                <span className="feature-tree-status" />
                <Tooltip content={feature.suppressed ? 'Unsuppress' : 'Suppress'} position="left">
                    <button
                        className={`theia-button secondary feature-tree-action ${feature.suppressed ? 'suppressed' : ''}`}
                        onClick={(e) => {
                            e.stopPropagation();
                            props.onToggleSuppressed(feature.id, !feature.suppressed);
                        }}
                    >
                        <span className={`codicon codicon-${feature.suppressed ? 'eye-closed' : 'eye'}`} />
                    </button>
                </Tooltip>
                <Tooltip content="Edit Parameters" position="left">
                    <button
                        className="theia-button secondary feature-tree-action"
                        onClick={(e) => {
                            e.stopPropagation();
                            props.onEditParams();
                        }}
                    >
                        <span className="codicon codicon-edit" />
                    </button>
                </Tooltip>
                <Tooltip content="Delete" position="left">
                    <button
                        className="theia-button secondary feature-tree-action"
                        onClick={(e) => {
                            e.stopPropagation();
                            props.onDelete(feature.id);
                        }}
                    >
                        <span className="codicon codicon-trash" />
                    </button>
                </Tooltip>
            </div>
            {tooltip.tooltipElement}
        </>
    );
}

function iconForFeature(type: string): string {
    switch (type) {
        case 'pad':
            return 'codicon-fold-up';
        case 'pocket':
            return 'codicon-fold-down';
        case 'revolve':
            return 'codicon-sync';
        case 'groove':
            return 'codicon-discard';
        default:
            return 'codicon-symbol-method';
    }
}
