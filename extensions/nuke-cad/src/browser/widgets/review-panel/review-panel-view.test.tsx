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

/**
 * Tests the pure CAD edit review panel view.
 */

import { describe, expect, it, vi } from 'vitest';
import * as React from '@theia/core/shared/react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OpenmcRegionBlocker } from '../../../common/openmc-region-references';
import type { TopologyImpact, TopologyRegionRef } from '../../../common/topology-impact';
import type { SketchSolveSummary } from '../../sketch/sketch-edit-types';
import {
    CadReviewAppliedEntry,
    CadReviewPanelView,
    CadReviewPanelViewProps,
    CadReviewProposalView,
    CadReviewTopologyContext
} from './review-panel-view';

// The shared loading overlay pulls Theia's widget helper, which touches the
// DOM at module load; this suite renders markup in a plain Node environment.
vi.mock('nuke-essentials/lib/theme/browser/components/nuke-loading-overlay', () => ({
    NukeLoadingOverlay: (overlayProps: { message: string; subMessage?: string }) =>
        React.createElement('div', { className: 'nuke-loading-overlay' }, overlayProps.message, overlayProps.subMessage)
}));

interface ButtonProps {
    className?: string;
    children?: React.ReactNode;
    disabled?: boolean;
    onClick?: () => void;
    checked?: boolean;
    onChange?: (checked: boolean) => void;
}

function collectButtons(
    node: React.ReactNode,
    className: string,
    found: React.ReactElement<ButtonProps>[] = []
): React.ReactElement<ButtonProps>[] {
    if (Array.isArray(node)) {
        for (const child of node) {
            collectButtons(child, className, found);
        }
        return found;
    }
    if (!React.isValidElement<ButtonProps>(node)) {
        return found;
    }
    const props = node.props;
    if (typeof props.className === 'string' && props.className.split(/\s+/).includes(className)) {
        found.push(node);
    }
    // The view and the shared primitives are pure function components, so the
    // traversal can expand them to reach host buttons instead of rendering.
    if (typeof node.type === 'function') {
        collectButtons((node.type as (componentProps: ButtonProps) => React.ReactNode)(props), className, found);
        return found;
    }
    collectButtons(props.children, className, found);
    return found;
}

function proposal(overrides: Partial<CadReviewProposalView> = {}): CadReviewProposalView {
    return {
        id: 'proposal-1',
        summary: 'fuel length: 1 → 1.2',
        documentPath: '/workspace/project/pincell.nuke-cad',
        changes: [
            {
                path: 'features.fuel.params.length',
                label: 'fuel length',
                kind: 'update',
                before: 1,
                after: 1.2
            }
        ],
        impact: {
            solids: { before: 2, after: 2 },
            faces: { before: 48, after: 52 },
            triangles: { before: 4000, after: 4400 },
            boundingBox: {
                before: { min: [0, 0, 0], max: [10, 10, 5] },
                after: { min: [0, 0, 0], max: [10, 10, 6] }
            }
        },
        build: { success: true, solidCount: 2, faceCount: 52, triangleCount: 4400 },
        ...overrides
    };
}

function props(overrides: Partial<CadReviewPanelViewProps> = {}): CadReviewPanelViewProps {
    return {
        proposals: [proposal()],
        applied: [],
        authoringEnabled: true,
        applying: false,
        undoableProposalIds: [],
        onApply: vi.fn(),
        onDismiss: vi.fn(),
        onUndo: vi.fn(),
        ...overrides
    };
}

function solverSummary(overrides: Partial<SketchSolveSummary> = {}): SketchSolveSummary {
    return {
        status: 'converged',
        dof: 0,
        fullyConstrained: true,
        conflicting: [],
        redundant: [],
        errorCount: 0,
        warningCount: 0,
        sketches: [],
        ...overrides
    };
}

function sketchProposal(overrides: Partial<CadReviewProposalView> = {}): CadReviewProposalView {
    return proposal({
        scope: 'sketch',
        changes: [
            {
                path: 'sketches.pellet.dimensions.diameter',
                label: 'pellet diameter',
                kind: 'update',
                before: 1,
                after: 1.2
            }
        ],
        impact: undefined,
        build: undefined,
        sketch: {
            targetSketchId: 'pellet',
            targetSketchName: 'Pellet profile',
            affectedSketchIds: ['pellet', 'clad'],
            solver: solverSummary()
        },
        ...overrides
    });
}

function region(selector: string, solidIds: readonly number[] = [1]): TopologyRegionRef {
    return {
        kind: 'volume',
        selector,
        group: `${selector}_region`,
        name: `${selector}_region`,
        material: 'steel',
        materialId: `material-${selector}`,
        solidIds
    };
}

function topologyImpact(overrides: Partial<TopologyImpact> = {}): TopologyImpact {
    return {
        solids: { before: 3, after: 4 },
        faces: { before: 24, after: 30 },
        triangles: { before: 4800, after: 6000 },
        addedSolidIds: [4],
        removedSolidIds: [],
        changedSolidIds: [1, 2],
        addedRegions: [region('insert', [4])],
        removedRegions: [region('shield', [3])],
        changedRegions: [
            {
                selector: 'fuel',
                group: 'fuel_region',
                beforeGroup: 'fuel_region',
                afterGroup: 'fuel_core_region',
                beforeSolidIds: [1],
                afterSolidIds: [1, 2],
                beforeMaterial: 'steel',
                afterMaterial: 'steel'
            }
        ],
        addedGroups: ['insert_region'],
        removedGroups: ['shield_region'],
        selectorMapChanged: true,
        regionCoverageChanged: true,
        requiresAcknowledgement: true,
        ...overrides
    };
}

function topologyContext(overrides: Partial<CadReviewTopologyContext> = {}): CadReviewTopologyContext {
    return {
        impact: topologyImpact(),
        blockedRegions: [],
        openmcStatus: 'saved-project',
        openmcProjectPath: '/workspace/project/pincell.nuke-openmc',
        openmcWarnings: [],
        ...overrides
    };
}

function topologyProposal(overrides: Partial<CadReviewProposalView> = {}): CadReviewProposalView {
    return proposal({
        scope: 'topology',
        changes: [
            {
                path: 'features.coolant.params.depth',
                label: 'Feature coolant hole depth',
                kind: 'remove',
                before: 2,
                after: undefined
            }
        ],
        impact: undefined,
        build: undefined,
        topology: topologyContext(),
        ...overrides
    });
}

function regionBlocker(): OpenmcRegionBlocker {
    const blocked = region('shield', [3]);
    return {
        region: blocked,
        reference: 'steel',
        kind: 'material',
        message: "OpenMC material 'steel' still references region 'shield'."
    };
}

describe('CadReviewPanelView', () => {
    it('renders the authoring-off empty state and hides proposals', () => {
        const onOpenSettings = vi.fn();
        const tree = CadReviewPanelView(
            props({
                authoringEnabled: false,
                proposals: [proposal()],
                onOpenSettings
            })
        );
        const html = renderToStaticMarkup(tree);

        expect(html).toContain('AI authoring is off');
        expect(html).toContain('Settings → Nuke CAD → AI Authoring');
        expect(html).toContain('cad-review-empty');
        expect(html).not.toContain('cad-review-proposal');
        expect(html).not.toContain('fuel length: 1 → 1.2');

        const settingsButtons = collectButtons(tree, 'theia-button');
        expect(settingsButtons).toHaveLength(1);
        settingsButtons[0].props.onClick?.();
        expect(onOpenSettings).toHaveBeenCalledOnce();
    });

    it('renders the no-proposals empty state when authoring is on', () => {
        const html = renderToStaticMarkup(CadReviewPanelView(props({ proposals: [], applied: [] })));

        expect(html).toContain('No proposed edits');
        expect(html).toContain('cad-review-empty');
        expect(html).not.toContain('cad-review-proposal');
    });

    it('renders a proposal diff, document, impact, build summary, and actions', () => {
        const onApply = vi.fn();
        const onDismiss = vi.fn();
        const tree = CadReviewPanelView(props({ onApply, onDismiss }));
        const html = renderToStaticMarkup(tree);

        expect(html).toContain('fuel length: 1 → 1.2');
        expect(html).toContain('cad-review-proposal');
        expect(html).toContain('pincell.nuke-cad');
        expect(html).toContain('/workspace/project/pincell.nuke-cad');
        expect(html).toContain('fuel length');
        expect(html).toContain('cad-review-diff-before');
        expect(html).toContain('cad-review-diff-after');
        expect(html).toContain('>1<');
        expect(html).toContain('>1.2<');
        expect(html).toContain('Solids 2 → 2');
        expect(html).toContain('Faces 48 → 52');
        expect(html).toContain('Triangles 4000 → 4400');
        expect(html).toContain('Bounding box:');
        expect(html).toContain('[10, 10, 5]');
        expect(html).toContain('[10, 10, 6]');
        expect(html).toContain('Build: 2 solids · 52 faces · 4400 triangles');
        expect(html).toContain('cad-review-apply');
        expect(html).toContain('cad-review-dismiss');

        const applyButtons = collectButtons(tree, 'cad-review-apply');
        const dismissButtons = collectButtons(tree, 'cad-review-dismiss');
        expect(applyButtons).toHaveLength(1);
        expect(dismissButtons).toHaveLength(1);
        expect(applyButtons[0].props.disabled).toBe(false);
        expect(dismissButtons[0].props.disabled).toBe(false);
        applyButtons[0].props.onClick?.();
        dismissButtons[0].props.onClick?.();
        expect(onApply).toHaveBeenCalledWith('proposal-1');
        expect(onDismiss).toHaveBeenCalledWith('proposal-1');
    });

    it('renders applied entries with a working Undo and disables stale tokens', () => {
        const undoable: CadReviewAppliedEntry = {
            proposalId: 'proposal-1',
            summary: 'fuel length: 1 → 1.2',
            undoToken: 'undo-1'
        };
        const stale: CadReviewAppliedEntry = {
            proposalId: 'proposal-2',
            summary: 'pad thickness: 2 → 3',
            undoToken: 'undo-2'
        };
        const onUndo = vi.fn();
        const tree = CadReviewPanelView(
            props({
                proposals: [],
                applied: [undoable, stale],
                undoableProposalIds: ['proposal-1'],
                onUndo
            })
        );
        const html = renderToStaticMarkup(tree);

        expect(html).toContain('Applied this session');
        expect(html).toContain('cad-review-applied');
        expect(html).toContain('fuel length: 1 → 1.2');
        expect(html).toContain('pad thickness: 2 → 3');
        expect(html).toContain('>Applied<');

        const undoButtons = collectButtons(tree, 'cad-review-undo');
        expect(undoButtons).toHaveLength(2);
        expect(undoButtons[0].props.disabled).toBe(false);
        expect(undoButtons[1].props.disabled).toBe(true);
        undoButtons[0].props.onClick?.();
        expect(onUndo).toHaveBeenCalledWith('proposal-1');
    });

    it('renders the applying overlay and disables proposal actions', () => {
        const tree = CadReviewPanelView(props({ applying: true }));
        const html = renderToStaticMarkup(tree);

        expect(html).toContain('nuke-loading-overlay');
        expect(html).toContain('Applying CAD change...');
        expect(html).toContain('Saving the document and scheduling a rebuild.');

        const applyButtons = collectButtons(tree, 'cad-review-apply');
        const dismissButtons = collectButtons(tree, 'cad-review-dismiss');
        expect(applyButtons[0].props.disabled).toBe(true);
        expect(dismissButtons[0].props.disabled).toBe(true);
    });

    it('renders sketch context for a fully constrained sketch proposal', () => {
        const tree = CadReviewPanelView(props({ proposals: [sketchProposal()] }));
        const html = renderToStaticMarkup(tree);

        expect(html).toContain('cad-review-sketch-context');
        expect(html).toContain('Sketch Pellet profile');
        expect(html).toContain('Fully constrained');
        expect(html).toContain('2 affected sketches');
        expect(html).toContain('pellet diameter');
        expect(html).toContain('cad-review-diff-before');
        expect(html).not.toContain('cad-review-topology');
        expect(html).not.toContain('Region impact');
    });

    it('renders DOF, conflicting constraints, and warnings for an under-constrained sketch', () => {
        const tree = CadReviewPanelView(
            props({
                proposals: [
                    sketchProposal({
                        sketch: {
                            targetSketchId: 'pellet',
                            targetSketchName: 'Pellet profile',
                            affectedSketchIds: ['pellet'],
                            solver: solverSummary({
                                fullyConstrained: false,
                                dof: 3,
                                conflicting: ['constraint-1'],
                                errorCount: 1,
                                warningCount: 2
                            })
                        }
                    })
                ]
            })
        );
        const html = renderToStaticMarkup(tree);

        expect(html).toContain('cad-review-sketch-context');
        expect(html).toContain('3 DOF');
        expect(html).toContain('1 conflicting constraint');
        expect(html).toContain('2 warnings');
        expect(html).not.toContain('2 affected sketches');
    });

    it('renders feature proposals without the sketch context block', () => {
        const tree = CadReviewPanelView(props({ proposals: [proposal({ scope: 'features' })] }));
        const html = renderToStaticMarkup(tree);

        expect(html).not.toContain('cad-review-sketch-context');
        expect(html).not.toContain('cad-review-topology');
        expect(html).not.toContain('Region impact');
        expect(html).toContain('fuel length');
        expect(html).toContain('Solids 2 → 2');
    });

    it('renders topology counts, added/removed/changed regions, OpenMC context, and acknowledgement', () => {
        const onAcknowledge = vi.fn();
        const tree = CadReviewPanelView(props({ proposals: [topologyProposal()], onAcknowledge }));
        const html = renderToStaticMarkup(tree);

        expect(html).toContain('cad-review-topology');
        expect(html).toContain('Region impact');
        expect(html).toContain('>Topology<');
        expect(html).toContain('Solids 3 → 4');
        expect(html).toContain('Faces 24 → 30');
        expect(html).toContain('Triangles 4800 → 6000');
        expect(html).toContain('1 added solid');
        expect(html).toContain('2 changed solids');
        expect(html).toContain('Added regions');
        expect(html).toContain('insert');
        expect(html).toContain('insert_region');
        expect(html).toContain('1 solid');
        expect(html).toContain('Removed regions');
        expect(html).toContain('shield');
        expect(html).toContain('shield_region');
        expect(html).toContain('Changed regions');
        expect(html).toContain('fuel');
        expect(html).toContain('fuel_region → fuel_core_region');
        expect(html).toContain('#1 → #1, #2');
        expect(html).toContain('pincell.nuke-openmc · checked against the saved project file');
        expect(html).toContain('I understand the solid and region impact');

        const checkboxes = collectButtons(tree, 'cad-review-topology-ack');
        expect(checkboxes[0].props.checked).toBe(false);
        checkboxes[0].props.onChange?.(true);
        expect(onAcknowledge).toHaveBeenCalledWith('proposal-1', true);
    });

    it('disables Apply until a topology impact is acknowledged', () => {
        const unacknowledged = CadReviewPanelView(props({ proposals: [topologyProposal()] }));
        expect(collectButtons(unacknowledged, 'cad-review-apply')[0].props.disabled).toBe(true);

        const acknowledged = CadReviewPanelView(props({ proposals: [topologyProposal()], acknowledgedProposalIds: ['proposal-1'] }));
        expect(collectButtons(acknowledged, 'cad-review-apply')[0].props.disabled).toBe(false);
    });

    it('keeps Apply disabled for an OpenMC-blocked region even when acknowledged', () => {
        const tree = CadReviewPanelView(
            props({
                proposals: [
                    topologyProposal({
                        topology: topologyContext({ blockedRegions: [regionBlocker()] })
                    })
                ],
                acknowledgedProposalIds: ['proposal-1']
            })
        );
        const html = renderToStaticMarkup(tree);

        expect(html).toContain('Blocked by OpenMC');
        expect(html).toContain('still references region');
        expect(html).toContain('Update the OpenMC project first; apply stays blocked until reference');
        expect(collectButtons(tree, 'cad-review-apply')[0].props.disabled).toBe(true);
        expect(collectButtons(tree, 'cad-review-topology-ack')[0].props.checked).toBe(true);
    });

    it('warns that OpenMC references were not checked without a saved project', () => {
        const html = renderToStaticMarkup(
            CadReviewPanelView(
                props({
                    proposals: [
                        topologyProposal({
                            topology: topologyContext({
                                openmcStatus: 'no-saved-project',
                                openmcProjectPath: undefined
                            })
                        })
                    ]
                })
            )
        );

        expect(html).toContain('OpenMC references were not checked because no saved OpenMC project is active.');
        expect(html).not.toContain('checked against the saved project file');
    });

    it('warns with the first OpenMC warning for other project states', () => {
        const html = renderToStaticMarkup(
            CadReviewPanelView(
                props({
                    proposals: [
                        topologyProposal({
                            topology: topologyContext({
                                openmcStatus: 'unreadable-project',
                                openmcProjectPath: '/workspace/project/broken.nuke-openmc',
                                openmcWarnings: ['OpenMC project could not be read.']
                            })
                        })
                    ]
                })
            )
        );

        expect(html).toContain('OpenMC project could not be read.');
        expect(html).toContain('cad-review-topology-openmc is-warning');
    });

    it('explains a topology change with no named region changes', () => {
        const html = renderToStaticMarkup(
            CadReviewPanelView(
                props({
                    proposals: [
                        topologyProposal({
                            topology: topologyContext({
                                impact: topologyImpact({
                                    addedRegions: [],
                                    removedRegions: [],
                                    changedRegions: [],
                                    addedGroups: [],
                                    removedGroups: []
                                })
                            })
                        })
                    ]
                })
            )
        );

        expect(html).toContain('No named region changes, but the solid or face topology changed.');
        expect(html).not.toContain('Added regions');
        expect(html).not.toContain('Removed regions');
        expect(html).not.toContain('Changed regions');
    });

    it('labels an applied topology entry as a topology change', () => {
        const entry: CadReviewAppliedEntry = {
            proposalId: 'proposal-3',
            summary: 'Open the coolant hole through the wall',
            undoToken: 'undo-3',
            scope: 'topology'
        };
        const html = renderToStaticMarkup(
            CadReviewPanelView(props({ proposals: [], applied: [entry], undoableProposalIds: ['proposal-3'] }))
        );

        expect(html).toContain('Applied this session');
        expect(html).toContain('Topology change');
        expect(html).not.toContain('Feature parameter');
    });
});
