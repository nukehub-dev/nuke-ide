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

import { describe, expect, it, vi } from 'vitest';
import {
    CAD_RIBBON_GROUPS,
    buildCadCommands,
    cadCommandGroupLabel,
    type CadCommandContext,
    type CadCommandHandlers,
    type CadCommandSpec
} from './cad-command-registry';

const context = (overrides: Partial<CadCommandContext> = {}): CadCommandContext => ({
    hasDocument: true,
    hasBodies: false,
    hasCurves: false,
    hasSolidProducers: false,
    sketchCount: 0,
    canUndo: false,
    canRedo: false,
    dirty: false,
    measureActive: false,
    measureListOpen: false,
    measureCount: 0,
    ...overrides
});

const handlers = (overrides: Partial<CadCommandHandlers> = {}): CadCommandHandlers => ({
    onStartSketchSetup: vi.fn(),
    onEditSketch: vi.fn(),
    onStartFeatureCreation: vi.fn(),
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    ...overrides
});

const command = (commands: readonly CadCommandSpec[], id: string): CadCommandSpec => {
    const found = commands.find((entry) => entry.id === id);
    expect(found, `command '${id}'`).toBeDefined();
    return found!;
};

const disabledReason = (commands: readonly CadCommandSpec[], id: string, ctx: CadCommandContext): string | undefined => {
    const spec = command(commands, id);
    return spec.isEnabled(ctx) ? undefined : spec.disabledReason?.(ctx);
};

describe('CAD_RIBBON_GROUPS', () => {
    it('defines the seven ribbon sections in order with their promoted counts', () => {
        expect(CAD_RIBBON_GROUPS.map((group) => group.id)).toEqual([
            'document',
            'sketch',
            'additive',
            'boolean',
            'dressUp',
            'pattern',
            'inspect'
        ]);
        expect(CAD_RIBBON_GROUPS.map((group) => group.label)).toEqual([
            'Document',
            'Sketch',
            'Additive',
            'Boolean',
            'Dress-up',
            'Pattern',
            'Inspect'
        ]);
        expect(CAD_RIBBON_GROUPS.map((group) => group.promoted)).toEqual([5, 2, 3, 3, 3, 3, 2]);
    });

    it('resolves every group caption', () => {
        expect(cadCommandGroupLabel('document')).toBe('Document');
        expect(cadCommandGroupLabel('dressUp')).toBe('Dress-up');
        expect(cadCommandGroupLabel('inspect')).toBe('Inspect');
    });
});

describe('buildCadCommands', () => {
    it('returns the complete command set and order without an edit-sketch selection', () => {
        const commands = buildCadCommands(context(), handlers());
        expect(commands.map((entry) => entry.id)).toEqual([
            'newDocument',
            'saveDocument',
            'undo',
            'redo',
            'rebuild',
            'exportPython',
            'newSketch',
            'pad',
            'pocket',
            'revolve',
            'groove',
            'loft',
            'sweep',
            'pipe',
            'helicalSweep',
            'booleanFuse',
            'booleanCut',
            'booleanCommon',
            'fillet',
            'chamfer',
            'shell',
            'draft',
            'translate',
            'linearPattern',
            'circularPattern',
            'mirror',
            'lattice',
            'hole',
            'measure',
            'measureList'
        ]);
    });

    it('keeps ids unique and groups in ribbon order', () => {
        const commands = buildCadCommands(context({ selectedSketchId: 'sketch-1' }), handlers());
        expect(new Set(commands.map((entry) => entry.id)).size).toBe(commands.length);
        expect([...new Set(commands.map((entry) => entry.group))]).toEqual(CAD_RIBBON_GROUPS.map((group) => group.id));
    });

    it('includes Edit Selected Sketch only while a sketch is selected', () => {
        expect(buildCadCommands(context(), handlers()).map((entry) => entry.id)).not.toContain('editSketch');
        const commands = buildCadCommands(context({ selectedSketchId: 'sketch-1' }), handlers());
        const ids = commands.map((entry) => entry.id);
        expect(ids.indexOf('editSketch')).toBe(ids.indexOf('newSketch') + 1);
        expect(command(commands, 'editSketch').isEnabled(context({ selectedSketchId: 'sketch-1' }))).toBe(true);
    });

    it('includes every caret-menu tail so command search can reach it', () => {
        const ids = buildCadCommands(context(), handlers()).map((entry) => entry.id);
        for (const id of ['exportPython', 'groove', 'loft', 'sweep', 'pipe', 'helicalSweep', 'draft', 'translate', 'lattice', 'hole']) {
            expect(ids).toContain(id);
        }
    });

    it('explains document-level disabled states', () => {
        const ctx = context();
        const commands = buildCadCommands(ctx, handlers({ onNewDocument: vi.fn(), onSaveDocument: vi.fn() }));
        expect(disabledReason(commands, 'newDocument', ctx)).toBe('A document is already open.');
        expect(disabledReason(commands, 'saveDocument', ctx)).toBe('No unsaved changes.');
        expect(disabledReason(commands, 'undo', ctx)).toBe('Nothing to undo.');
        expect(disabledReason(commands, 'redo', ctx)).toBe('Nothing to redo.');
    });

    it('enables document commands from their context flags', () => {
        const ctx = context({ hasDocument: false, dirty: true, canUndo: true, canRedo: true });
        const commands = buildCadCommands(ctx, handlers({ onNewDocument: vi.fn(), onSaveDocument: vi.fn() }));
        expect(command(commands, 'newDocument').isEnabled(ctx)).toBe(true);
        expect(command(commands, 'saveDocument').isEnabled(ctx)).toBe(true);
        expect(command(commands, 'undo').isEnabled(ctx)).toBe(true);
        expect(command(commands, 'redo').isEnabled(ctx)).toBe(true);
        expect(command(commands, 'newDocument').disabledReason?.(ctx)).toBeUndefined();
        expect(command(commands, 'saveDocument').disabledReason?.(ctx)).toBeUndefined();
    });

    it('explains sketch-dependent additive commands', () => {
        const ctx = context();
        const commands = buildCadCommands(ctx, handlers());
        expect(disabledReason(commands, 'pad', ctx)).toBe('Select a sketch first.');
        expect(disabledReason(commands, 'revolve', ctx)).toBe('Select a sketch first.');
        expect(disabledReason(commands, 'helicalSweep', ctx)).toBe('Select a sketch first.');
        expect(disabledReason(commands, 'pocket', ctx)).toBe('Select a sketch and create a body first.');
        expect(disabledReason(commands, 'groove', ctx)).toBe('Select a sketch and create a body first.');
        expect(disabledReason(commands, 'loft', ctx)).toBe('Create at least two sketches.');
        expect(disabledReason(commands, 'sweep', ctx)).toBe('Requires sketch curves.');
        expect(disabledReason(commands, 'pipe', ctx)).toBe('Requires sketch curves.');
    });

    it('enables additive commands when the selected sketch, bodies, and curves exist', () => {
        const ctx = context({
            selectedSketchId: 'sketch-1',
            hasBodies: true,
            hasCurves: true,
            sketchCount: 2
        });
        const commands = buildCadCommands(ctx, handlers());
        for (const id of ['pad', 'pocket', 'revolve', 'groove', 'loft', 'sweep', 'pipe', 'helicalSweep']) {
            expect(command(commands, id).isEnabled(ctx), id).toBe(true);
            expect(command(commands, id).disabledReason?.(ctx), id).toBeUndefined();
        }
    });

    it('explains body-dependent and pattern-specific disabled states', () => {
        const noBodies = context();
        const commands = buildCadCommands(noBodies, handlers());
        for (const id of [
            'booleanFuse',
            'booleanCut',
            'booleanCommon',
            'fillet',
            'chamfer',
            'shell',
            'draft',
            'translate',
            'linearPattern',
            'circularPattern',
            'mirror',
            'lattice',
            'hole'
        ]) {
            expect(disabledReason(commands, id, noBodies), id).toBe('Create a body first.');
        }

        const bodiesWithoutProducers = context({ hasBodies: true });
        for (const id of ['linearPattern', 'circularPattern', 'mirror', 'lattice']) {
            expect(disabledReason(commands, id, bodiesWithoutProducers), id).toBe('Requires a solid-producing feature.');
        }
        for (const id of ['booleanFuse', 'fillet', 'hole']) {
            expect(command(commands, id).isEnabled(bodiesWithoutProducers), id).toBe(true);
        }
    });

    it('enables patterns when a solid-producing feature exists', () => {
        const ctx = context({ hasBodies: true, hasSolidProducers: true });
        const commands = buildCadCommands(ctx, handlers());
        for (const id of ['linearPattern', 'circularPattern', 'mirror', 'lattice']) {
            expect(command(commands, id).isEnabled(ctx), id).toBe(true);
            expect(command(commands, id).disabledReason?.(ctx), id).toBeUndefined();
        }
    });

    it('marks export and rebuild unavailable without their optional handlers', () => {
        const ctx = context();
        const commands = buildCadCommands(ctx, handlers());
        expect(disabledReason(commands, 'exportPython', ctx)).toBe('Not available in this view.');
        expect(disabledReason(commands, 'rebuild', ctx)).toBe('Not available in this view.');
    });

    it('enables export and rebuild when the host supplies their handlers', () => {
        const ctx = context();
        const commands = buildCadCommands(ctx, handlers({ onExportPython: vi.fn(), onRebuildDocument: vi.fn() }));
        expect(command(commands, 'exportPython').isEnabled(ctx)).toBe(true);
        expect(command(commands, 'exportPython').disabledReason?.(ctx)).toBeUndefined();
        expect(command(commands, 'rebuild').isEnabled(ctx)).toBe(true);
        expect(command(commands, 'rebuild').disabledReason?.(ctx)).toBeUndefined();
    });

    it('resolves the Measurements label with the live count', () => {
        expect(command(buildCadCommands(context(), handlers()), 'measureList').label).toBe('Measurements');
        expect(command(buildCadCommands(context({ measureCount: 3 }), handlers()), 'measureList').label).toBe('Measurements (3)');
    });

    it('wires each command to its handler', () => {
        const onNewDocument = vi.fn();
        const onSaveDocument = vi.fn();
        const onRebuildDocument = vi.fn();
        const onExportPython = vi.fn();
        const onStartSketchSetup = vi.fn();
        const onEditSketch = vi.fn();
        const onStartFeatureCreation = vi.fn();
        const onUndo = vi.fn();
        const onRedo = vi.fn();
        const onToggleMeasure = vi.fn();
        const onToggleMeasureList = vi.fn();
        const ctx = context({ hasDocument: false, selectedSketchId: 'sketch-1', dirty: true });
        const commands = buildCadCommands(ctx, {
            onNewDocument,
            onSaveDocument,
            onRebuildDocument,
            onExportPython,
            onStartSketchSetup,
            onEditSketch,
            onStartFeatureCreation,
            onUndo,
            onRedo,
            onToggleMeasure,
            onToggleMeasureList
        });

        for (const id of ['newDocument', 'saveDocument', 'rebuild', 'exportPython', 'newSketch', 'editSketch', 'undo', 'redo', 'measure']) {
            command(commands, id).run();
        }
        for (const id of ['pad', 'booleanCommon', 'lattice']) {
            command(commands, id).run();
        }
        command(commands, 'measureList').run();

        expect(onNewDocument).toHaveBeenCalledTimes(1);
        expect(onSaveDocument).toHaveBeenCalledTimes(1);
        expect(onRebuildDocument).toHaveBeenCalledTimes(1);
        expect(onExportPython).toHaveBeenCalledTimes(1);
        expect(onStartSketchSetup).toHaveBeenCalledTimes(1);
        expect(onEditSketch).toHaveBeenCalledWith('sketch-1');
        expect(onUndo).toHaveBeenCalledTimes(1);
        expect(onRedo).toHaveBeenCalledTimes(1);
        expect(onToggleMeasure).toHaveBeenCalledTimes(1);
        expect(onToggleMeasureList).toHaveBeenCalledTimes(1);
        expect(onStartFeatureCreation.mock.calls).toEqual([['pad'], ['booleanCommon'], ['lattice']]);
    });
});
