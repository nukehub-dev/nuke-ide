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
 * Pure CAD command registry: the single ordered action table behind the
 * document ribbon and the toolbar command search.
 *
 * The toolbar supplies document state plus handlers; `buildCadCommands` binds
 * both into `CadCommandSpec`s. Consumers render the specs but never own a
 * second action table, so enabling rules, labels, icons, order, and disabled
 * explanations cannot drift between the ribbon and search. Active states stay
 * host-owned because they describe a transient UI mode, not command
 * availability.
 *
 * No React or Theia imports: this module is directly unit-testable.
 *
 * @module nuke-cad/browser
 */

import { type FeatureType } from '../common/cad-document';

/** Ribbon section ids in render order. */
export type CadCommandGroup = 'document' | 'sketch' | 'additive' | 'boolean' | 'dressUp' | 'pattern' | 'inspect';

/** One ribbon section and its inline (promoted) action count. */
export interface CadRibbonGroup {
    readonly id: CadCommandGroup;
    readonly label: string;
    readonly promoted: number;
}

/**
 * The seven ribbon sections in order, with the number of actions promoted out
 * of the caret menu. Promotion is data: change it here, not in the toolbar.
 */
export const CAD_RIBBON_GROUPS: readonly CadRibbonGroup[] = [
    { id: 'document', label: 'Document', promoted: 5 },
    { id: 'sketch', label: 'Sketch', promoted: 2 },
    { id: 'additive', label: 'Additive', promoted: 3 },
    { id: 'boolean', label: 'Boolean', promoted: 3 },
    { id: 'dressUp', label: 'Dress-up', promoted: 3 },
    { id: 'pattern', label: 'Pattern', promoted: 3 },
    { id: 'inspect', label: 'Inspect', promoted: 2 }
];

/** Document state that gates command availability. */
export interface CadCommandContext {
    readonly hasDocument: boolean;
    readonly selectedSketchId?: string;
    readonly hasBodies: boolean;
    readonly hasCurves: boolean;
    readonly hasSolidProducers: boolean;
    readonly sketchCount: number;
    readonly canUndo: boolean;
    readonly canRedo: boolean;
    readonly dirty: boolean;
    readonly measureActive: boolean;
    readonly measureListOpen: boolean;
    readonly measureCount: number;
}

/** Toolbar callbacks the command table dispatches. */
export interface CadCommandHandlers {
    readonly onNewDocument?: () => void;
    readonly onSaveDocument?: () => void;
    readonly onRebuildDocument?: () => void;
    readonly onExportPython?: () => void;
    readonly onStartSketchSetup: () => void;
    readonly onEditSketch: (sketchId: string) => void;
    readonly onStartFeatureCreation: (type: FeatureType) => void;
    readonly onUndo: () => void;
    readonly onRedo: () => void;
    readonly onToggleMeasure?: () => void;
    readonly onToggleMeasureList?: () => void;
}

/** One resolved ribbon/search command. */
export interface CadCommandSpec {
    readonly id: string;
    readonly label: string;
    readonly shortLabel?: string;
    readonly icon: string;
    /** Stable ribbon section id; use {@link cadCommandGroupLabel} for captions. */
    readonly group: CadCommandGroup;
    /** Display-only binding hint (labels keep their existing shortcut text). */
    readonly shortcut?: string;
    readonly isEnabled: (context: CadCommandContext) => boolean;
    /** Concise, actionable explanation; undefined when the command is enabled. */
    readonly disabledReason?: (context: CadCommandContext) => string | undefined;
    readonly run: () => void;
}

/** User-facing explanations, kept in one place so every surface stays consistent. */
export const CAD_COMMAND_REASONS = {
    documentOpen: 'A document is already open.',
    noUnsavedChanges: 'No unsaved changes.',
    nothingToUndo: 'Nothing to undo.',
    nothingToRedo: 'Nothing to redo.',
    selectSketch: 'Select a sketch first.',
    selectSketchAndBody: 'Select a sketch and create a body first.',
    twoSketches: 'Create at least two sketches.',
    sketchCurves: 'Requires sketch curves.',
    bodyFirst: 'Create a body first.',
    solidProducer: 'Requires a solid-producing feature.',
    unavailable: 'Not available in this view.'
} as const;

type OptionalHandlerKey = 'onNewDocument' | 'onSaveDocument' | 'onRebuildDocument' | 'onExportPython';

interface CadCommandDefinition {
    readonly id: string;
    readonly label: string | ((context: CadCommandContext) => string);
    readonly shortLabel?: string;
    readonly icon: string;
    readonly group: CadCommandGroup;
    readonly shortcut?: string;
    /** Command is hidden when this returns false (Edit Selected Sketch). */
    readonly isAvailable?: (context: CadCommandContext) => boolean;
    /** An optional handler must be supplied or the command is unavailable. */
    readonly requiresHandler?: OptionalHandlerKey;
    readonly isEnabled: (context: CadCommandContext) => boolean;
    readonly disabledReason?: (context: CadCommandContext) => string | undefined;
    readonly run: (handlers: CadCommandHandlers, context: CadCommandContext) => void;
}

const alwaysEnabled = (): boolean => true;

const bodyFeature =
    (type: FeatureType) =>
    (handlers: CadCommandHandlers): void =>
        handlers.onStartFeatureCreation(type);

const CAD_COMMAND_DEFINITIONS: readonly CadCommandDefinition[] = [
    {
        id: 'newDocument',
        label: 'New Document',
        shortLabel: 'New',
        icon: 'codicon-new-file',
        group: 'document',
        requiresHandler: 'onNewDocument',
        isEnabled: (context) => !context.hasDocument,
        disabledReason: (context) => (context.hasDocument ? CAD_COMMAND_REASONS.documentOpen : undefined),
        run: (handlers) => handlers.onNewDocument?.()
    },
    {
        id: 'saveDocument',
        label: 'Save Document',
        shortLabel: 'Save',
        icon: 'codicon-save',
        group: 'document',
        requiresHandler: 'onSaveDocument',
        isEnabled: (context) => context.dirty,
        disabledReason: (context) => (context.dirty ? undefined : CAD_COMMAND_REASONS.noUnsavedChanges),
        run: (handlers) => handlers.onSaveDocument?.()
    },
    {
        id: 'undo',
        label: 'Undo (Ctrl+Z)',
        shortLabel: 'Undo',
        icon: 'codicon-nuke-cad-undo',
        group: 'document',
        shortcut: 'Ctrl+Z',
        isEnabled: (context) => context.canUndo,
        disabledReason: (context) => (context.canUndo ? undefined : CAD_COMMAND_REASONS.nothingToUndo),
        run: (handlers) => handlers.onUndo()
    },
    {
        id: 'redo',
        label: 'Redo (Ctrl+Shift+Z / Ctrl+Y)',
        shortLabel: 'Redo',
        icon: 'codicon-nuke-cad-redo',
        group: 'document',
        shortcut: 'Ctrl+Shift+Z / Ctrl+Y',
        isEnabled: (context) => context.canRedo,
        disabledReason: (context) => (context.canRedo ? undefined : CAD_COMMAND_REASONS.nothingToRedo),
        run: (handlers) => handlers.onRedo()
    },
    {
        id: 'rebuild',
        label: 'Rebuild Geometry',
        shortLabel: 'Rebuild',
        icon: 'codicon-refresh',
        group: 'document',
        requiresHandler: 'onRebuildDocument',
        isEnabled: alwaysEnabled,
        run: (handlers) => handlers.onRebuildDocument?.()
    },
    {
        id: 'exportPython',
        label: 'Export as Python',
        icon: 'codicon-code',
        group: 'document',
        requiresHandler: 'onExportPython',
        isEnabled: alwaysEnabled,
        run: (handlers) => handlers.onExportPython?.()
    },
    {
        id: 'newSketch',
        label: 'New Sketch',
        shortLabel: 'New',
        icon: 'codicon-nuke-cad-sketch',
        group: 'sketch',
        isEnabled: alwaysEnabled,
        run: (handlers) => handlers.onStartSketchSetup()
    },
    {
        id: 'editSketch',
        label: 'Edit Selected Sketch',
        shortLabel: 'Edit',
        icon: 'codicon-edit',
        group: 'sketch',
        isAvailable: (context) => context.selectedSketchId !== undefined,
        isEnabled: alwaysEnabled,
        run: (handlers, context) => {
            if (context.selectedSketchId !== undefined) {
                handlers.onEditSketch(context.selectedSketchId);
            }
        }
    },
    {
        id: 'pad',
        label: 'Pad (extrude add)',
        shortLabel: 'Pad',
        icon: 'codicon-nuke-cad-pad',
        group: 'additive',
        isEnabled: (context) => context.selectedSketchId !== undefined,
        disabledReason: (context) => (context.selectedSketchId === undefined ? CAD_COMMAND_REASONS.selectSketch : undefined),
        run: bodyFeature('pad')
    },
    {
        id: 'pocket',
        label: 'Pocket (extrude cut)',
        shortLabel: 'Pocket',
        icon: 'codicon-nuke-cad-pocket',
        group: 'additive',
        isEnabled: (context) => context.selectedSketchId !== undefined && context.hasBodies,
        disabledReason: (context) =>
            context.selectedSketchId !== undefined && context.hasBodies ? undefined : CAD_COMMAND_REASONS.selectSketchAndBody,
        run: bodyFeature('pocket')
    },
    {
        id: 'revolve',
        label: 'Revolve',
        icon: 'codicon-nuke-cad-revolve',
        group: 'additive',
        isEnabled: (context) => context.selectedSketchId !== undefined,
        disabledReason: (context) => (context.selectedSketchId === undefined ? CAD_COMMAND_REASONS.selectSketch : undefined),
        run: bodyFeature('revolve')
    },
    {
        id: 'groove',
        label: 'Groove',
        icon: 'codicon-nuke-cad-groove',
        group: 'additive',
        isEnabled: (context) => context.selectedSketchId !== undefined && context.hasBodies,
        disabledReason: (context) =>
            context.selectedSketchId !== undefined && context.hasBodies ? undefined : CAD_COMMAND_REASONS.selectSketchAndBody,
        run: bodyFeature('groove')
    },
    {
        id: 'loft',
        label: 'Loft (join sketch sections)',
        icon: 'codicon-nuke-cad-loft',
        group: 'additive',
        isEnabled: (context) => context.hasDocument && context.sketchCount >= 2,
        disabledReason: (context) => (context.hasDocument && context.sketchCount >= 2 ? undefined : CAD_COMMAND_REASONS.twoSketches),
        run: bodyFeature('loft')
    },
    {
        id: 'sweep',
        label: 'Sweep (sketch along curve)',
        icon: 'codicon-nuke-cad-sweep',
        group: 'additive',
        isEnabled: (context) => context.selectedSketchId !== undefined && context.hasCurves,
        disabledReason: (context) =>
            context.selectedSketchId !== undefined && context.hasCurves ? undefined : CAD_COMMAND_REASONS.sketchCurves,
        run: bodyFeature('sweep')
    },
    {
        id: 'pipe',
        label: 'Pipe (circle along curve)',
        icon: 'codicon-nuke-cad-pipe',
        group: 'additive',
        isEnabled: (context) => context.hasCurves,
        disabledReason: (context) => (context.hasCurves ? undefined : CAD_COMMAND_REASONS.sketchCurves),
        run: bodyFeature('pipe')
    },
    {
        id: 'helicalSweep',
        label: 'Helical Sweep (sketch along helix)',
        icon: 'codicon-nuke-cad-helix',
        group: 'additive',
        isEnabled: (context) => context.selectedSketchId !== undefined,
        disabledReason: (context) => (context.selectedSketchId === undefined ? CAD_COMMAND_REASONS.selectSketch : undefined),
        run: bodyFeature('helicalSweep')
    },
    {
        id: 'booleanFuse',
        label: 'Boolean Fuse',
        shortLabel: 'Fuse',
        icon: 'codicon-nuke-cad-boolean-fuse',
        group: 'boolean',
        isEnabled: (context) => context.hasBodies,
        disabledReason: (context) => (context.hasBodies ? undefined : CAD_COMMAND_REASONS.bodyFirst),
        run: bodyFeature('booleanFuse')
    },
    {
        id: 'booleanCut',
        label: 'Boolean Cut',
        shortLabel: 'Cut',
        icon: 'codicon-nuke-cad-boolean-cut',
        group: 'boolean',
        isEnabled: (context) => context.hasBodies,
        disabledReason: (context) => (context.hasBodies ? undefined : CAD_COMMAND_REASONS.bodyFirst),
        run: bodyFeature('booleanCut')
    },
    {
        id: 'booleanCommon',
        label: 'Boolean Common',
        shortLabel: 'Common',
        icon: 'codicon-nuke-cad-boolean-common',
        group: 'boolean',
        isEnabled: (context) => context.hasBodies,
        disabledReason: (context) => (context.hasBodies ? undefined : CAD_COMMAND_REASONS.bodyFirst),
        run: bodyFeature('booleanCommon')
    },
    {
        id: 'fillet',
        label: 'Fillet',
        icon: 'codicon-nuke-cad-fillet',
        group: 'dressUp',
        isEnabled: (context) => context.hasBodies,
        disabledReason: (context) => (context.hasBodies ? undefined : CAD_COMMAND_REASONS.bodyFirst),
        run: bodyFeature('fillet')
    },
    {
        id: 'chamfer',
        label: 'Chamfer',
        icon: 'codicon-nuke-cad-chamfer',
        group: 'dressUp',
        isEnabled: (context) => context.hasBodies,
        disabledReason: (context) => (context.hasBodies ? undefined : CAD_COMMAND_REASONS.bodyFirst),
        run: bodyFeature('chamfer')
    },
    {
        id: 'shell',
        label: 'Shell',
        icon: 'codicon-nuke-cad-shell',
        group: 'dressUp',
        isEnabled: (context) => context.hasBodies,
        disabledReason: (context) => (context.hasBodies ? undefined : CAD_COMMAND_REASONS.bodyFirst),
        run: bodyFeature('shell')
    },
    {
        id: 'draft',
        label: 'Draft',
        icon: 'codicon-nuke-cad-draft',
        group: 'dressUp',
        isEnabled: (context) => context.hasBodies,
        disabledReason: (context) => (context.hasBodies ? undefined : CAD_COMMAND_REASONS.bodyFirst),
        run: bodyFeature('draft')
    },
    {
        id: 'translate',
        label: 'Move (translate body)',
        icon: 'codicon-nuke-cad-move',
        group: 'dressUp',
        isEnabled: (context) => context.hasBodies,
        disabledReason: (context) => (context.hasBodies ? undefined : CAD_COMMAND_REASONS.bodyFirst),
        run: bodyFeature('translate')
    },
    {
        id: 'linearPattern',
        label: 'Linear Pattern',
        shortLabel: 'Linear',
        icon: 'codicon-nuke-cad-linear-pattern',
        group: 'pattern',
        isEnabled: (context) => context.hasBodies && context.hasSolidProducers,
        disabledReason: (context) =>
            !context.hasBodies ? CAD_COMMAND_REASONS.bodyFirst : context.hasSolidProducers ? undefined : CAD_COMMAND_REASONS.solidProducer,
        run: bodyFeature('linearPattern')
    },
    {
        id: 'circularPattern',
        label: 'Circular Pattern',
        shortLabel: 'Circular',
        icon: 'codicon-nuke-cad-circular-pattern',
        group: 'pattern',
        isEnabled: (context) => context.hasBodies && context.hasSolidProducers,
        disabledReason: (context) =>
            !context.hasBodies ? CAD_COMMAND_REASONS.bodyFirst : context.hasSolidProducers ? undefined : CAD_COMMAND_REASONS.solidProducer,
        run: bodyFeature('circularPattern')
    },
    {
        id: 'mirror',
        label: 'Mirror',
        icon: 'codicon-nuke-cad-mirror',
        group: 'pattern',
        isEnabled: (context) => context.hasBodies && context.hasSolidProducers,
        disabledReason: (context) =>
            !context.hasBodies ? CAD_COMMAND_REASONS.bodyFirst : context.hasSolidProducers ? undefined : CAD_COMMAND_REASONS.solidProducer,
        run: bodyFeature('mirror')
    },
    {
        id: 'lattice',
        label: 'Lattice',
        icon: 'codicon-nuke-cad-lattice',
        group: 'pattern',
        isEnabled: (context) => context.hasBodies && context.hasSolidProducers,
        disabledReason: (context) =>
            !context.hasBodies ? CAD_COMMAND_REASONS.bodyFirst : context.hasSolidProducers ? undefined : CAD_COMMAND_REASONS.solidProducer,
        run: bodyFeature('lattice')
    },
    {
        id: 'hole',
        label: 'Hole',
        icon: 'codicon-nuke-cad-hole',
        group: 'pattern',
        isEnabled: (context) => context.hasBodies,
        disabledReason: (context) => (context.hasBodies ? undefined : CAD_COMMAND_REASONS.bodyFirst),
        run: bodyFeature('hole')
    },
    {
        id: 'measure',
        label: 'Measure (distance, angle, radius)',
        shortLabel: 'Measure',
        icon: 'codicon-nuke-cad-measure',
        group: 'inspect',
        isEnabled: alwaysEnabled,
        run: (handlers) => handlers.onToggleMeasure?.()
    },
    {
        id: 'measureList',
        label: (context) => `Measurements${context.measureCount ? ` (${context.measureCount})` : ''}`,
        shortLabel: 'Measures',
        icon: 'codicon-list-unordered',
        group: 'inspect',
        isEnabled: alwaysEnabled,
        run: (handlers) => handlers.onToggleMeasureList?.()
    }
];

/** Section caption for a command group. */
export function cadCommandGroupLabel(group: CadCommandGroup): string {
    return CAD_RIBBON_GROUPS.find((entry) => entry.id === group)?.label ?? group;
}

/**
 * Resolve the ordered command table for the current document state.
 *
 * The returned specs keep today's ribbon order (including caret-menu tails)
 * and handler wiring; `isEnabled`/`disabledReason` are context-bound so the
 * ribbon and search evaluate identical rules.
 */
export function buildCadCommands(context: CadCommandContext, handlers: CadCommandHandlers): readonly CadCommandSpec[] {
    return CAD_COMMAND_DEFINITIONS.filter((definition) => definition.isAvailable?.(context) !== false).map((definition) => {
        const requiredHandler = definition.requiresHandler;
        const hasHandler = requiredHandler === undefined || handlers[requiredHandler] !== undefined;
        return {
            id: definition.id,
            label: typeof definition.label === 'function' ? definition.label(context) : definition.label,
            shortLabel: definition.shortLabel,
            icon: definition.icon,
            group: definition.group,
            shortcut: definition.shortcut,
            isEnabled: (next: CadCommandContext): boolean => hasHandler && definition.isEnabled(next),
            disabledReason: (next: CadCommandContext): string | undefined => {
                if (!hasHandler) {
                    return CAD_COMMAND_REASONS.unavailable;
                }
                return definition.isEnabled(next) ? undefined : definition.disabledReason?.(next);
            },
            run: () => definition.run(handlers, context)
        };
    });
}
