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
import { Event } from '@theia/core/lib/common/event';
import type { ILogger } from '@theia/core/lib/common/logger';
import type { MessageService } from '@theia/core/lib/common/message-service';
import type {
    NukeCapability,
    NukeCapabilityContext,
    NukeCapabilityContextService,
    NukeCapabilityRegistry,
    NukeCapabilityResult,
    NukeChangeSet
} from 'nuke-core/lib/common/nuke-capability-protocol';
import type { NukeUndoService } from 'nuke-core/lib/browser/capabilities/nuke-undo-service';
import type { NukeAiActionService } from '../actions/nuke-ai-action-service';
import { NukeNextActionService, NukeNextActionResponse } from './nuke-next-action-service';
import { toToolName } from './nuke-tool-schema';

const CONTEXT: NukeCapabilityContext = {
    workspaceRoots: ['/workspace'],
    activeCadDocument: '/workspace/model.nuke-cad'
};

function makeCapability(overrides: Partial<NukeCapability> & Pick<NukeCapability, 'id' | 'risk'>): NukeCapability {
    return {
        title: overrides.id,
        description: 'Test capability.',
        category: ['Test'],
        inputSchema: { type: 'object', properties: {} },
        invoke: vi.fn(async (): Promise<NukeCapabilityResult> => ({ ok: true })),
        ...overrides
    };
}

interface Harness {
    service: NukeNextActionService;
    ask: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    loggerError: ReturnType<typeof vi.fn>;
    undo: ReturnType<typeof vi.fn>;
    updateResult: ReturnType<typeof vi.fn>;
    response: NukeNextActionResponse;
}

function createHarness(capabilities: readonly NukeCapability[], context: NukeCapabilityContext = CONTEXT): Harness {
    const registry: NukeCapabilityRegistry = {
        register: () => undefined,
        get: (id) => capabilities.find((capability) => capability.id === id),
        getAll: () => capabilities,
        getEnabled: () => capabilities,
        ready: Promise.resolve(),
        onDidChange: Event.None
    };
    const contextService: NukeCapabilityContextService = {
        getContext: async () => context,
        onDidChangeContext: Event.None
    };
    const ask = vi.fn(async (_prompt: string, _displayText: string) => undefined);
    const warn = vi.fn(async (..._args: unknown[]): Promise<string | undefined> => undefined);
    const error = vi.fn();
    const loggerError = vi.fn();
    const undo = vi.fn(async (_token: string): Promise<NukeCapabilityResult> => ({ ok: true, message: 'Settings change undone.' }));
    const updateResult = vi.fn();
    const undoService: NukeUndoService = {
        register: () => 'undo-1',
        has: () => true,
        undo,
        onDidChange: Event.None
    };
    const service = new NukeNextActionService(
        registry,
        contextService,
        { ask } as unknown as NukeAiActionService,
        undoService,
        { warn, error } as unknown as MessageService,
        { error: loggerError } as unknown as ILogger
    );
    return { service, ask, warn, error, loggerError, undo, updateResult, response: { updateResult } };
}

const APPLY_CHANGE_SET: NukeChangeSet = {
    id: 'proposal-1',
    title: 'Run settings',
    summary: 'Increase batches and particles per batch.',
    changes: [
        { path: 'run.batches', label: 'Batches', kind: 'update', before: 100, after: 200 },
        { path: 'run.particles', label: 'Particles per batch', kind: 'update', before: 1000, after: 5000 }
    ],
    applyCapability: 'nuke.openmc.applySettings'
};

describe('NukeNextActionService', () => {
    it('runs a read-only capability directly and replaces the card result', async () => {
        const result: NukeCapabilityResult = { ok: true, message: 'Project is valid.' };
        const invoke = vi.fn(async () => result);
        const capability = makeCapability({ id: 'nuke.openmc.validateProject', risk: 'read', title: 'Validate OpenMC Project', invoke });
        const harness = createHarness([capability]);

        await harness.service.run(capability.id, harness.response);

        expect(invoke).toHaveBeenCalledTimes(1);
        expect(invoke).toHaveBeenCalledWith({}, CONTEXT);
        expect(harness.updateResult).toHaveBeenCalledWith({
            content: [{ type: 'text', text: 'Project is valid.' }]
        });
        expect(harness.ask).not.toHaveBeenCalled();
        expect(harness.warn).not.toHaveBeenCalled();
        expect(harness.error).not.toHaveBeenCalled();
    });

    it('asks NukeAI instead of invoking a read capability that still requires confirmation', async () => {
        const invoke = vi.fn(async (): Promise<NukeCapabilityResult> => ({ ok: true }));
        const capability = makeCapability({
            id: 'nuke.cad.readWithConfirmation',
            risk: 'read',
            requiresConfirmation: true,
            title: 'Read with confirmation',
            invoke
        });
        const harness = createHarness([capability]);

        await harness.service.run(capability.id, harness.response);

        expect(invoke).not.toHaveBeenCalled();
        expect(harness.ask).toHaveBeenCalledTimes(1);
        expect(harness.updateResult).not.toHaveBeenCalled();
    });

    it.each(['write', 'execute', 'destructive'] as const)('asks NukeAI instead of invoking a %s capability', async (risk) => {
        const invoke = vi.fn(async (): Promise<NukeCapabilityResult> => ({ ok: true }));
        const capability = makeCapability({
            id: risk === 'write' ? 'nuke.cad.exportDagmc' : risk === 'execute' ? 'nuke.openmc.runSimulation' : 'nuke.cad.replaceBody',
            risk,
            title: `${risk} step`,
            invoke
        });
        const harness = createHarness([capability]);

        await harness.service.run(capability.id, harness.response);

        expect(invoke).not.toHaveBeenCalled();
        expect(harness.updateResult).not.toHaveBeenCalled();
        expect(harness.ask).toHaveBeenCalledTimes(1);
        const [prompt, displayText] = harness.ask.mock.calls[0];
        expect(displayText).toBe('Run next action');
        expect(prompt).toContain(capability.title);
        expect(prompt).toContain(toToolName(capability.id));
        expect(prompt).toContain('never invent');
        expect(prompt).toContain('confirmation');
        expect(prompt).toContain('write, execute, or destructive');
        expect(harness.warn).not.toHaveBeenCalled();
    });

    it('warns and does nothing when the capability is missing', async () => {
        const harness = createHarness([]);

        await harness.service.run('nuke.cad.missingAction', harness.response);

        expect(harness.warn).toHaveBeenCalledWith(expect.stringContaining('could not find'));
        expect(harness.ask).not.toHaveBeenCalled();
        expect(harness.updateResult).not.toHaveBeenCalled();
    });

    it('warns when the capability is not available in the current context', async () => {
        const invoke = vi.fn(async (): Promise<NukeCapabilityResult> => ({ ok: true }));
        const capability = makeCapability({ id: 'nuke.viz.summarizeStatepoint', risk: 'read', when: () => false, invoke });
        const harness = createHarness([capability]);

        await harness.service.run(capability.id, harness.response);

        expect(harness.warn).toHaveBeenCalledWith(expect.stringContaining('is not available in the current context.'));
        expect(invoke).not.toHaveBeenCalled();
        expect(harness.ask).not.toHaveBeenCalled();
        expect(harness.updateResult).not.toHaveBeenCalled();
    });

    it('routes missing required inputs to NukeAI instead of invoking', async () => {
        const invoke = vi.fn(async (): Promise<NukeCapabilityResult> => ({ ok: true }));
        const capability = makeCapability({
            id: 'nuke.cad.exportDagmc',
            risk: 'read',
            inputSchema: {
                type: 'object',
                properties: { path: { type: 'string' } },
                required: ['path']
            },
            invoke
        });
        const harness = createHarness([capability]);

        await harness.service.run(capability.id, harness.response);

        expect(invoke).not.toHaveBeenCalled();
        expect(harness.updateResult).not.toHaveBeenCalled();
        expect(harness.ask).toHaveBeenCalledTimes(1);
        const [prompt, displayText] = harness.ask.mock.calls[0];
        expect(displayText).toBe('Run next action');
        expect(prompt).toContain('missing required input "path"');
        expect(prompt).toContain('ask for them');
    });

    it('logs and reports a failed invocation', async () => {
        const capability = makeCapability({
            id: 'nuke.cad.summarizeDocument',
            risk: 'read',
            title: 'CAD summary',
            invoke: vi.fn(async () => {
                throw new Error('converter crashed');
            })
        });
        const harness = createHarness([capability]);

        await expect(harness.service.run(capability.id, harness.response)).resolves.toBeUndefined();

        expect(harness.loggerError).toHaveBeenCalledWith(expect.stringContaining('nuke.cad.summarizeDocument'), expect.any(Error));
        expect(harness.error).toHaveBeenCalledWith(expect.stringContaining('NukeAI could not run CAD summary'));
        expect(harness.error).toHaveBeenCalledWith(expect.stringContaining('converter crashed'));
        expect(harness.updateResult).not.toHaveBeenCalled();
    });

    it('ignores a duplicate concurrent run of the same capability', async () => {
        let resolveInvoke: (result: NukeCapabilityResult) => void = () => undefined;
        const invoke = vi.fn(
            () =>
                new Promise<NukeCapabilityResult>((resolve) => {
                    resolveInvoke = resolve;
                })
        );
        const capability = makeCapability({ id: 'nuke.cad.summarizeDocument', risk: 'read', invoke });
        const harness = createHarness([capability]);

        const first = harness.service.run(capability.id, harness.response);
        const second = harness.service.run(capability.id, harness.response);
        await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));

        resolveInvoke({ ok: true });
        await Promise.all([first, second]);

        expect(invoke).toHaveBeenCalledTimes(1);
        expect(harness.updateResult).toHaveBeenCalledTimes(1);
        expect(harness.ask).not.toHaveBeenCalled();
    });

    it('allows only existing read capabilities to run directly', () => {
        const capabilities = [
            makeCapability({ id: 'nuke.cad.summarizeDocument', risk: 'read' }),
            makeCapability({ id: 'nuke.cad.exportDagmc', risk: 'write' }),
            makeCapability({ id: 'nuke.openmc.runSimulation', risk: 'execute' }),
            makeCapability({ id: 'nuke.cad.replaceBody', risk: 'destructive' }),
            makeCapability({ id: 'nuke.cad.readWithConfirmation', risk: 'read', requiresConfirmation: true })
        ];
        const harness = createHarness(capabilities);

        expect(harness.service.canRunDirectly('nuke.cad.summarizeDocument')).toBe(true);
        expect(harness.service.canRunDirectly('nuke.cad.readWithConfirmation')).toBe(false);
        expect(harness.service.canRunDirectly('nuke.cad.exportDagmc')).toBe(false);
        expect(harness.service.canRunDirectly('nuke.openmc.runSimulation')).toBe(false);
        expect(harness.service.canRunDirectly('nuke.cad.replaceBody')).toBe(false);
        expect(harness.service.canRunDirectly('nuke.cad.missingAction')).toBe(false);
    });

    it('sends a change-set apply prompt with the proposal id, summary, and capability', async () => {
        const capability = makeCapability({
            id: 'nuke.openmc.applySettings',
            risk: 'write',
            title: 'Apply OpenMC settings',
            requiresConfirmation: true
        });
        const harness = createHarness([capability]);

        await harness.service.applyChangeSet(APPLY_CHANGE_SET);

        expect(harness.ask).toHaveBeenCalledTimes(1);
        const [prompt, displayText] = harness.ask.mock.calls[0];
        expect(displayText).toBe('Apply settings changes');
        expect(prompt).toContain('proposal-1');
        expect(prompt).toContain('Increase batches and particles per batch.');
        expect(prompt).toContain('nuke.openmc.applySettings');
        expect(prompt).toContain('nuke_openmc_applySettings');
        expect(prompt).toContain('run.batches, run.particles');
        expect(prompt).toContain('Preview the change first');
        expect(prompt).toContain('confirmation');
        expect(prompt).toContain('undone');
        expect(capability.invoke).not.toHaveBeenCalled();
        expect(harness.warn).not.toHaveBeenCalled();
        expect(harness.updateResult).not.toHaveBeenCalled();
    });

    it('warns when a change set has no apply capability', async () => {
        const { applyCapability: _ignored, ...changeSetWithoutApply } = APPLY_CHANGE_SET;
        const harness = createHarness([]);

        await harness.service.applyChangeSet(changeSetWithoutApply);

        expect(harness.warn).toHaveBeenCalledWith(expect.stringContaining('no apply capability'));
        expect(harness.ask).not.toHaveBeenCalled();
    });

    it('warns when the apply capability is missing', async () => {
        const harness = createHarness([]);

        await harness.service.applyChangeSet(APPLY_CHANGE_SET);

        expect(harness.warn).toHaveBeenCalledWith(expect.stringContaining('could not find the apply capability'));
        expect(harness.warn).toHaveBeenCalledWith(expect.stringContaining('nuke.openmc.applySettings'));
        expect(harness.ask).not.toHaveBeenCalled();
    });

    it('warns instead of asking when the apply capability is not write or execute', async () => {
        const capability = makeCapability({ id: 'nuke.openmc.applySettings', risk: 'read', title: 'Apply OpenMC settings' });
        const harness = createHarness([capability]);

        await harness.service.applyChangeSet(APPLY_CHANGE_SET);

        expect(harness.warn).toHaveBeenCalledWith(expect.stringContaining('cannot apply this change'));
        expect(harness.ask).not.toHaveBeenCalled();
        expect(capability.invoke).not.toHaveBeenCalled();
    });

    it('reports a failure to open the apply chat prompt', async () => {
        const capability = makeCapability({ id: 'nuke.openmc.applySettings', risk: 'write', title: 'Apply OpenMC settings' });
        const harness = createHarness([capability]);
        harness.ask.mockRejectedValue(new Error('no chat model'));

        await expect(harness.service.applyChangeSet(APPLY_CHANGE_SET)).resolves.toBeUndefined();

        expect(harness.loggerError).toHaveBeenCalledWith(expect.stringContaining('proposal-1'), expect.any(Error));
        expect(harness.error).toHaveBeenCalledWith(expect.stringContaining('could not start applying this change'));
        expect(harness.error).toHaveBeenCalledWith(expect.stringContaining('no chat model'));
    });

    it('does nothing when the undo confirmation is cancelled', async () => {
        const harness = createHarness([]);

        await harness.service.undo('undo-1', harness.response);

        expect(harness.warn).toHaveBeenCalledWith(expect.any(String), 'Undo');
        expect(harness.undo).not.toHaveBeenCalled();
        expect(harness.updateResult).not.toHaveBeenCalled();
        expect(harness.error).not.toHaveBeenCalled();
    });

    it('undoes after confirmation and replaces the card result', async () => {
        const result: NukeCapabilityResult = { ok: true, message: 'Settings change undone.' };
        const harness = createHarness([]);
        harness.warn.mockResolvedValue('Undo');
        harness.undo.mockResolvedValue(result);

        await harness.service.undo('undo-1', harness.response);

        expect(harness.undo).toHaveBeenCalledWith('undo-1');
        expect(harness.updateResult).toHaveBeenCalledWith({
            content: [{ type: 'text', text: 'Settings change undone.' }]
        });
        expect(harness.error).not.toHaveBeenCalled();
    });

    it('reports a failed undo without replacing the card result', async () => {
        const result: NukeCapabilityResult = { ok: false, message: 'This change can no longer be undone.' };
        const harness = createHarness([]);
        harness.warn.mockResolvedValue('Undo');
        harness.undo.mockResolvedValue(result);

        await harness.service.undo('undo-1', harness.response);

        expect(harness.undo).toHaveBeenCalledWith('undo-1');
        expect(harness.error).toHaveBeenCalledWith('This change can no longer be undone.');
        expect(harness.updateResult).not.toHaveBeenCalled();
    });

    it('reports a thrown undo error without rejecting or replacing the result', async () => {
        const harness = createHarness([]);
        harness.warn.mockResolvedValue('Undo');
        harness.undo.mockRejectedValue(new Error('undo crashed'));

        await expect(harness.service.undo('undo-1', harness.response)).resolves.toBeUndefined();

        expect(harness.loggerError).toHaveBeenCalledWith('[NukeAI] Failed to undo an applied change.', expect.any(Error));
        expect(JSON.stringify(harness.loggerError.mock.calls)).not.toContain('undo-1');
        expect(harness.error).toHaveBeenCalledWith(expect.stringContaining('could not undo this change'));
        expect(harness.updateResult).not.toHaveBeenCalled();
    });

    it('ignores a duplicate concurrent undo of the same token', async () => {
        let resolveUndo: (result: NukeCapabilityResult) => void = () => undefined;
        const harness = createHarness([]);
        harness.warn.mockResolvedValue('Undo');
        harness.undo.mockImplementation(
            () =>
                new Promise<NukeCapabilityResult>((resolve) => {
                    resolveUndo = resolve;
                })
        );

        const first = harness.service.undo('undo-1', harness.response);
        const second = harness.service.undo('undo-1', harness.response);
        await vi.waitFor(() => expect(harness.undo).toHaveBeenCalledTimes(1));

        resolveUndo({ ok: true, message: 'Settings change undone.' });
        await Promise.all([first, second]);

        expect(harness.undo).toHaveBeenCalledTimes(1);
        expect(harness.updateResult).toHaveBeenCalledTimes(1);
    });
});
