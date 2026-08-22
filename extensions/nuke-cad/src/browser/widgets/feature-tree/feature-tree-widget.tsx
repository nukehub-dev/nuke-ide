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
import { ConfirmDialog } from '@theia/core/lib/browser/dialogs';
import { NukeCadCommands } from '../../commands';
import { CadDocumentStore } from '../../document/cad-document-store';
import { type NukeCadDocument, type BodyDef, type FeatureDef, type SketchDef, type DatumPlane } from '../../../common/cad-document';
import { type FeatureResult } from '../../../common/nuke-cad-protocol';
import { type DocumentSelection } from '../../document/cad-document-store';
import { type TopologyRef } from '../../../common/topology-refs';
import { Tooltip, useTooltip } from 'nuke-essentials/lib/theme/browser/components/tooltip';
import './feature-tree.css';

function getSourceFeatureId(feature: FeatureDef): string {
    const source = (feature.params as Record<string, unknown>).source;
    return typeof source === 'string' ? source : '';
}

function collectDependentFeatureIds(doc: NukeCadDocument, id: string): string[] {
    const dependents: string[] = [];
    for (const feature of doc.features) {
        if (feature.dependsOn.includes(id) || getSourceFeatureId(feature) === id) {
            dependents.push(feature.id);
        }
    }
    return dependents;
}

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
                referenceResults={this.documentStore.getReferenceResults()}
                onSelectSketch={(id) => this.documentStore.selectSketch(id)}
                onSelectFeature={(id) => this.documentStore.selectFeature(id)}
                onSelectBody={(id) => this.documentStore.selectBody(id)}
                onToggleSuppressed={(id, value) => this.handleToggleSuppressed(id, value)}
                onDeleteFeature={(id) => void this.handleDeleteFeature(id)}
                onRenameFeature={(id, name) => this.handleRenameFeature(id, name)}
                onRenameBody={(id, name) => this.handleRenameBody(id, name)}
                onReorderFeatures={(orderedIds) => this.handleReorderFeatures(orderedIds)}
                onRepairRef={(path, fingerprint) => this.handleRepairRef(path, fingerprint)}
                onEditSketch={(id) => this.commandService.executeCommand(NukeCadCommands.EDIT_SKETCH.id, id)}
                onNewSketch={() => this.commandService.executeCommand(NukeCadCommands.NEW_SKETCH.id)}
                onEditFeature={(id) => this.commandService.executeCommand(NukeCadCommands.EDIT_FEATURE.id, id)}
                onExportPython={() => void this.commandService.executeCommand(NukeCadCommands.EXPORT_PYTHON.id)}
                onStartFeatureCreation={(type) => {
                    const command = commandForFeatureType(type);
                    if (command !== undefined) {
                        void this.commandService.executeCommand(command.id);
                    }
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

    private async handleDeleteFeature(id: string): Promise<void> {
        const doc = this.documentStore.document;
        if (doc === undefined) {
            return;
        }
        const dependentIds = collectDependentFeatureIds(doc, id);
        if (dependentIds.length > 0) {
            const confirmed = await new ConfirmDialog({
                title: 'Delete dependent features?',
                msg: `Delete feature '${id}' and ${dependentIds.length} dependent feature${
                    dependentIds.length === 1 ? '' : 's'
                }? This cannot be undone.`,
                ok: 'Delete all'
            }).open();
            if (!confirmed) {
                return;
            }
            const result = this.documentStore.deleteFeature(id, 'cascade');
            if (!result.success) {
                this.messageService.error(result.error || 'Failed to delete feature.');
            }
            return;
        }
        const result = this.documentStore.deleteFeature(id, 'error');
        if (!result.success) {
            this.messageService.error(result.error || 'Failed to delete feature.');
        }
    }

    private handleRenameFeature(id: string, name: string): void {
        const result = this.documentStore.renameFeature(id, name);
        if (!result.success) {
            this.messageService.error(result.error || 'Failed to rename feature.');
        }
    }

    private handleRenameBody(id: string, name: string): void {
        const result = this.documentStore.renameBody(id, name);
        if (!result.success) {
            this.messageService.error(result.error || 'Failed to rename body.');
        }
    }

    private handleReorderFeatures(orderedIds: string[]): void {
        const result = this.documentStore.reorderFeatures(orderedIds);
        if (!result.success) {
            this.messageService.error(result.error || 'Failed to reorder features.');
        }
    }

    private handleRepairRef(
        path: string,
        fingerprint: import('../../../common/topology-refs').FaceFingerprint | import('../../../common/topology-refs').EdgeFingerprint
    ): void {
        const result = this.documentStore.replaceTopologyRef(path, fingerprint);
        if (!result.success) {
            this.messageService.error(result.error || 'Failed to repair reference.');
            return;
        }
        void this.commandService.executeCommand(NukeCadCommands.REBUILD_GEOMETRY.id);
    }
}

interface CadFeatureTreeComponentProps {
    readonly document?: NukeCadDocument;
    readonly selection: DocumentSelection;
    readonly featureResults: ReadonlyMap<string, FeatureResult>;
    readonly referenceResults: readonly import('../../../common/nuke-cad-protocol').ReferenceResolutionResult[];
    readonly onSelectSketch: (id: string | undefined) => void;
    readonly onSelectFeature: (id: string | undefined) => void;
    readonly onSelectBody: (id: string | undefined) => void;
    readonly onToggleSuppressed: (id: string, value: boolean) => void;
    readonly onDeleteFeature: (id: string) => void;
    readonly onRenameFeature: (id: string, name: string) => void;
    readonly onRenameBody: (id: string, name: string) => void;
    readonly onReorderFeatures: (orderedIds: string[]) => void;
    readonly onRepairRef: (
        path: string,
        fingerprint: import('../../../common/topology-refs').FaceFingerprint | import('../../../common/topology-refs').EdgeFingerprint
    ) => void;
    readonly onEditSketch: (id: string) => void;
    readonly onEditFeature: (id: string) => void;
    readonly onNewSketch: () => void;
    readonly onExportPython?: () => void;
    readonly onStartFeatureCreation: (type: FeatureDef['type']) => void;
}

function CadFeatureTreeComponent(props: CadFeatureTreeComponentProps): React.ReactElement {
    const doc = props.document;
    const hasContent =
        doc !== undefined && (doc.datums.length > 0 || doc.sketches.length > 0 || doc.bodies.length > 0 || doc.features.length > 0);
    const [renamingId, setRenamingId] = React.useState<string | undefined>();
    const [renameValue, setRenameValue] = React.useState('');
    const [repairPopover, setRepairPopover] = React.useState<
        | {
              featureId: string;
              results: readonly import('../../../common/nuke-cad-protocol').ReferenceResolutionResult[];
              anchor: HTMLElement;
          }
        | undefined
    >();
    const bodyNameMap = React.useMemo(() => {
        const map = new Map<string, string>();
        if (doc !== undefined) {
            for (const body of doc.bodies) {
                map.set(body.id, bodyLabelText(body));
            }
        }
        return map;
    }, [doc?.bodies]);

    const featureIds = React.useMemo(() => doc?.features.map((f) => f.id) ?? [], [doc?.features]);

    const moveFeature = (id: string, direction: -1 | 1): void => {
        const idx = featureIds.indexOf(id);
        const newIdx = idx + direction;
        if (idx < 0 || newIdx < 0 || newIdx >= featureIds.length) {
            return;
        }
        const newIds = [...featureIds];
        [newIds[idx], newIds[newIdx]] = [newIds[newIdx], newIds[idx]];
        props.onReorderFeatures(newIds);
    };

    const startRenameBody = (body: BodyDef): void => {
        setRenamingId(body.id);
        setRenameValue(body.name);
    };

    const commitRenameBody = (): void => {
        if (renamingId !== undefined) {
            props.onRenameBody(renamingId, renameValue);
        }
        setRenamingId(undefined);
    };

    const cancelRenameBody = (): void => {
        setRenamingId(undefined);
    };

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
                {doc !== undefined && props.onExportPython !== undefined && (
                    <Tooltip content="Export as Python" position="left">
                        <button className="theia-button secondary" onClick={props.onExportPython}>
                            <span className="codicon codicon-code" />
                        </button>
                    </Tooltip>
                )}
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

                    <TreeSection title="Bodies" count={doc.bodies.length}>
                        {doc.bodies.map((body) => (
                            <BodyRow
                                key={body.id}
                                body={body}
                                selected={props.selection.selectedBodyId === body.id}
                                renaming={renamingId === body.id}
                                renameValue={renameValue}
                                onSelect={() => props.onSelectBody(body.id)}
                                onRenameValueChange={setRenameValue}
                                onRenameCommit={commitRenameBody}
                                onRenameCancel={cancelRenameBody}
                                onStartRename={() => startRenameBody(body)}
                            />
                        ))}
                    </TreeSection>

                    <TreeSection title="Features" count={doc.features.length}>
                        {doc.features.map((feature, index) => (
                            <FeatureRow
                                key={feature.id}
                                feature={feature}
                                index={index}
                                isFirst={index === 0}
                                isLast={index === doc.features.length - 1}
                                result={props.featureResults.get(feature.id)}
                                referenceResults={props.referenceResults.filter((r) => r.featureId === feature.id)}
                                bodyNameMap={bodyNameMap}
                                selected={props.selection.selectedFeatureId === feature.id}
                                onSelect={() => props.onSelectFeature(feature.id)}
                                onToggleSuppressed={props.onToggleSuppressed}
                                onDelete={props.onDeleteFeature}
                                onEditFeature={props.onEditFeature}
                                onRenameFeature={props.onRenameFeature}
                                onMoveUp={(id) => moveFeature(id, -1)}
                                onMoveDown={(id) => moveFeature(id, 1)}
                                onOpenRepairPopover={(featureId, results, anchor) => setRepairPopover({ featureId, results, anchor })}
                            />
                        ))}
                    </TreeSection>
                </div>
            )}
            {repairPopover !== undefined && doc !== undefined && (
                <RepairPopover
                    document={doc}
                    featureId={repairPopover.featureId}
                    results={repairPopover.results}
                    anchor={repairPopover.anchor}
                    onRepair={props.onRepairRef}
                    onClose={() => setRepairPopover(undefined)}
                />
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

interface InlineRenameProps {
    readonly value: string;
    readonly onChange: (value: string) => void;
    readonly onCommit: () => void;
    readonly onCancel: () => void;
}

function InlineRename(props: InlineRenameProps): React.ReactElement {
    return (
        <input
            className="feature-tree-rename-input"
            value={props.value}
            onChange={(e) => props.onChange(e.target.value)}
            onKeyDown={(e) => {
                if (e.key === 'Enter') {
                    props.onCommit();
                } else if (e.key === 'Escape') {
                    props.onCancel();
                }
            }}
            onBlur={props.onCommit}
            autoFocus
        />
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

interface BodyRowProps {
    readonly body: BodyDef;
    readonly selected: boolean;
    readonly renaming: boolean;
    readonly renameValue: string;
    readonly onSelect: () => void;
    readonly onRenameValueChange: (value: string) => void;
    readonly onRenameCommit: () => void;
    readonly onRenameCancel: () => void;
    readonly onStartRename: () => void;
}

function BodyRow(props: BodyRowProps): React.ReactElement {
    const tooltip = useTooltip('Click to select body; double-click label to rename', 'right');
    return (
        <>
            <div
                className={`feature-tree-row body${props.selected ? ' selected' : ''}`}
                onClick={props.onSelect}
                onMouseEnter={tooltip.onMouseEnter}
                onMouseLeave={tooltip.onMouseLeave}
            >
                <span className="codicon codicon-circle-outline feature-tree-icon" />
                {props.renaming ? (
                    <InlineRename
                        value={props.renameValue}
                        onChange={props.onRenameValueChange}
                        onCommit={props.onRenameCommit}
                        onCancel={props.onRenameCancel}
                    />
                ) : (
                    <span className="feature-tree-label" onDoubleClick={props.onStartRename}>
                        {bodyLabelText(props.body)}
                    </span>
                )}
                {!props.renaming && (
                    <Tooltip content="Rename" position="left">
                        <button
                            className="theia-button secondary feature-tree-action"
                            onClick={(e) => {
                                e.stopPropagation();
                                props.onStartRename();
                            }}
                        >
                            <span className="codicon codicon-edit" />
                        </button>
                    </Tooltip>
                )}
            </div>
            {tooltip.tooltipElement}
        </>
    );
}

interface FeatureRowProps {
    readonly feature: FeatureDef;
    readonly index: number;
    readonly isFirst: boolean;
    readonly isLast: boolean;
    readonly result?: FeatureResult;
    readonly referenceResults: readonly import('../../../common/nuke-cad-protocol').ReferenceResolutionResult[];
    readonly bodyNameMap: ReadonlyMap<string, string>;
    readonly selected: boolean;
    readonly onSelect: () => void;
    readonly onToggleSuppressed: (id: string, value: boolean) => void;
    readonly onDelete: (id: string) => void;
    readonly onEditFeature: (id: string) => void;
    readonly onRenameFeature: (id: string, name: string) => void;
    readonly onMoveUp: (id: string) => void;
    readonly onMoveDown: (id: string) => void;
    readonly onOpenRepairPopover: (
        featureId: string,
        results: readonly import('../../../common/nuke-cad-protocol').ReferenceResolutionResult[],
        anchor: HTMLElement
    ) => void;
}

function FeatureRow(props: FeatureRowProps): React.ReactElement {
    const { feature, result, referenceResults, bodyNameMap } = props;
    const status = result?.status ?? 'stale';
    const statusClass = `status-${status}`;
    const statusTooltip = result?.error ?? `${status}`;
    const tooltip = useTooltip(statusTooltip, 'right');
    const ambiguous = referenceResults.filter((r) => r.status === 'ambiguous').length;
    const unmatched = referenceResults.filter((r) => r.status === 'unmatched').length;
    const isBoolean = feature.type === 'booleanFuse' || feature.type === 'booleanCut' || feature.type === 'booleanCommon';
    const params = feature.params as Record<string, unknown>;
    const targetBody = isBoolean && typeof params.targetBody === 'string' ? params.targetBody : undefined;
    const toolBodies = isBoolean && Array.isArray(params.toolBodies) ? (params.toolBodies as string[]) : [];
    const [renaming, setRenaming] = React.useState(false);
    const [editName, setEditName] = React.useState(feature.name);

    const commitRename = (): void => {
        const name = editName.trim();
        if (name.length > 0 && name !== feature.name) {
            props.onRenameFeature(feature.id, name);
        }
        setRenaming(false);
    };

    const cancelRename = (): void => {
        setEditName(feature.name);
        setRenaming(false);
    };

    return (
        <>
            <div
                className={`feature-tree-row feature${props.selected ? ' selected' : ''} ${statusClass}`}
                onClick={props.onSelect}
                onMouseEnter={tooltip.onMouseEnter}
                onMouseLeave={tooltip.onMouseLeave}
            >
                <span className={`codicon ${iconForFeature(feature.type)} feature-tree-icon`} />
                {renaming ? (
                    <InlineRename value={editName} onChange={setEditName} onCommit={commitRename} onCancel={cancelRename} />
                ) : (
                    <span className="feature-tree-label" onDoubleClick={() => setRenaming(true)}>
                        {feature.name}
                    </span>
                )}
                <span className="feature-tree-body-chip" title="Target body">
                    {bodyNameMap.get(feature.body) ?? feature.body}
                </span>
                {isBoolean && (
                    <span className="feature-tree-boolean-hint">
                        {targetBody !== undefined && `→ ${bodyNameMap.get(targetBody) ?? targetBody}`}
                        {toolBodies.length > 0 && ` · tools: ${toolBodies.map((id) => bodyNameMap.get(id) ?? id).join(', ')}`}
                    </span>
                )}
                {(ambiguous > 0 || unmatched > 0) && (
                    <span
                        ref={(el) => {
                            if (el !== null) {
                                el.dataset.featureId = feature.id;
                            }
                        }}
                        className={`feature-tree-ref-badge ${unmatched > 0 ? 'unmatched' : 'ambiguous'}`}
                        onClick={(e) => {
                            e.stopPropagation();
                            props.onOpenRepairPopover(feature.id, referenceResults, e.currentTarget);
                        }}
                    >
                        {unmatched > 0 ? `${unmatched} unmatched` : `${ambiguous} ambiguous`}
                    </span>
                )}
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
                <Tooltip content="Move up" position="left">
                    <button
                        className="theia-button secondary feature-tree-action"
                        disabled={props.isFirst}
                        onClick={(e) => {
                            e.stopPropagation();
                            props.onMoveUp(feature.id);
                        }}
                    >
                        <span className="codicon codicon-arrow-up" />
                    </button>
                </Tooltip>
                <Tooltip content="Move down" position="left">
                    <button
                        className="theia-button secondary feature-tree-action"
                        disabled={props.isLast}
                        onClick={(e) => {
                            e.stopPropagation();
                            props.onMoveDown(feature.id);
                        }}
                    >
                        <span className="codicon codicon-arrow-down" />
                    </button>
                </Tooltip>
                {!isBoolean && !renaming && (
                    <Tooltip content="Edit Parameters" position="left">
                        <button
                            className="theia-button secondary feature-tree-action"
                            onClick={(e) => {
                                e.stopPropagation();
                                props.onEditFeature(feature.id);
                            }}
                        >
                            <span className="codicon codicon-edit" />
                        </button>
                    </Tooltip>
                )}
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

function resolveTopologyRefAtPath(doc: NukeCadDocument, path: string): TopologyRef | undefined {
    const datumMatch = path.match(/^datum\.([^.]+)\.reference$/);
    if (datumMatch !== null) {
        return doc.datums.find((d) => d.id === datumMatch[1])?.reference;
    }
    const sketchMatch = path.match(/^sketch\.([^.]+)\.externalRefs\[(\d+)\]$/);
    if (sketchMatch !== null) {
        const sketch = doc.sketches.find((s) => s.id === sketchMatch[1]);
        const index = Number(sketchMatch[2]);
        return sketch?.externalRefs?.[index];
    }
    const arrayMatch = path.match(/^feature\.([^.]+)\.params\.(edges|faces)\[(\d+)\]$/);
    if (arrayMatch !== null) {
        const feature = doc.features.find((f) => f.id === arrayMatch[1]);
        const params = feature?.params as Record<string, unknown> | undefined;
        const index = Number(arrayMatch[3]);
        const refs = params?.[arrayMatch[2]] as TopologyRef[] | undefined;
        return refs?.[index];
    }
    const faceMatch = path.match(/^feature\.([^.]+)\.params\.(face|upToFace)$/);
    if (faceMatch !== null) {
        const feature = doc.features.find((f) => f.id === faceMatch[1]);
        const params = feature?.params as Record<string, unknown> | undefined;
        return params?.[faceMatch[2]] as TopologyRef | undefined;
    }
    return undefined;
}

function formatPoint3(point: readonly number[]): string {
    return `(${point.map((v) => Number(v).toFixed(3)).join(', ')})`;
}

function summarizeFingerprint(ref: TopologyRef | undefined): string {
    if (ref === undefined) {
        return 'none';
    }
    if (ref.kind === 'face') {
        const fp = ref.fingerprint as import('../../../common/topology-refs').FaceFingerprint;
        return `${fp.surfaceType} area=${fp.area.toFixed(3)} center=${formatPoint3(fp.center)}`;
    }
    const fp = ref.fingerprint as import('../../../common/topology-refs').EdgeFingerprint;
    return `${fp.curveType} length=${fp.length.toFixed(3)} ${formatPoint3(fp.start)} -> ${formatPoint3(fp.end)}`;
}

interface RepairPopoverProps {
    readonly document: NukeCadDocument;
    readonly featureId: string;
    readonly results: readonly import('../../../common/nuke-cad-protocol').ReferenceResolutionResult[];
    readonly anchor: HTMLElement;
    readonly onRepair: (
        path: string,
        fingerprint: import('../../../common/topology-refs').FaceFingerprint | import('../../../common/topology-refs').EdgeFingerprint
    ) => void;
    readonly onClose: () => void;
}

function RepairPopover(props: RepairPopoverProps): React.ReactElement {
    const rect = props.anchor.getBoundingClientRect();
    const results = props.results.filter((r) => r.status === 'ambiguous' || r.status === 'unmatched');
    return (
        <div
            className="cad-feature-tree-repair-popover"
            style={{ position: 'fixed', top: rect.bottom + 4, left: rect.left }}
            onClick={(e) => e.stopPropagation()}
        >
            <div className="cad-feature-tree-repair-header">
                <span>Repair references for {props.featureId}</span>
                <button className="theia-button secondary" onClick={props.onClose}>
                    <span className="codicon codicon-close" />
                </button>
            </div>
            {results.length === 0 && <div className="cad-feature-tree-repair-empty">No repairable references.</div>}
            {results.map((result) => {
                const current = resolveTopologyRefAtPath(props.document, result.path);
                const candidates = result.candidates ?? [];
                return (
                    <div key={result.path} className="cad-feature-tree-repair-group">
                        <div className="cad-feature-tree-repair-path">{result.path}</div>
                        <div className="cad-feature-tree-repair-current">Current: {summarizeFingerprint(current)}</div>
                        {candidates.length === 0 && <div className="cad-feature-tree-repair-empty">No candidates available.</div>}
                        {candidates.length > 0 && (
                            <div className="cad-feature-tree-repair-candidates">
                                {candidates.map((candidate, index) => (
                                    <button
                                        key={`${candidate.candidateId}-${index}`}
                                        className="theia-button secondary cad-feature-tree-repair-candidate"
                                        onClick={() => {
                                            if (candidate.fingerprint !== undefined) {
                                                props.onRepair(result.path, candidate.fingerprint);
                                            }
                                        }}
                                        disabled={candidate.fingerprint === undefined}
                                    >
                                        <span className="cad-feature-tree-repair-candidate-id">{candidate.candidateId}</span>
                                        <span className="cad-feature-tree-repair-candidate-score">{candidate.score.toFixed(3)}</span>
                                        {candidate.fingerprint !== undefined && (
                                            <span className="cad-feature-tree-repair-candidate-summary">
                                                {summarizeFingerprint({
                                                    featureId: props.featureId,
                                                    kind: result.kind,
                                                    fingerprint: candidate.fingerprint
                                                } as TopologyRef)}
                                            </span>
                                        )}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
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
        case 'booleanFuse':
            return 'codicon-type-hierarchy-sub';
        case 'booleanCut':
            return 'codicon-type-hierarchy-super';
        case 'booleanCommon':
            return 'codicon-intersect';
        default:
            return 'codicon-symbol-method';
    }
}

function commandForFeatureType(type: FeatureDef['type']): import('@theia/core/lib/common/command').Command | undefined {
    switch (type) {
        case 'pad':
            return NukeCadCommands.ADD_FEATURE_PAD;
        case 'pocket':
            return NukeCadCommands.ADD_FEATURE_POCKET;
        case 'revolve':
            return NukeCadCommands.ADD_FEATURE_REVOLVE;
        case 'groove':
            return NukeCadCommands.ADD_FEATURE_GROOVE;
        default:
            return undefined;
    }
}

function bodyLabelText(body: BodyDef): string {
    return body.label !== undefined ? `${body.name} · ${body.label}` : body.name;
}
