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
 * Capability-to-card contract tests.
 *
 * Every fixture is a real capability result produced by the public `invoke`
 * method with fake services. The result then travels through the same bounded
 * `toToolCallContent` conversion, `summarizeNukeToolResult` parser, and
 * `NukeToolCallCard` renderer the chat UI uses. This catches a capability
 * returning a change-set shape, apply capability, undo token, or warning list
 * the card can no longer represent.
 */

import { describe, expect, it, vi } from 'vitest';
import { Event } from '@theia/core/lib/common/event';
import type { ToolCallContent, ToolRequest } from '@theia/ai-core/lib/common/language-model';
import type { ToolInvocationRegistry } from '@theia/ai-core/lib/common/tool-invocation-registry';
import type { FileService } from '@theia/filesystem/lib/browser/file-service';
import type {
    NukeCapability,
    NukeCapabilityContext,
    NukeCapabilityContextService,
    NukeCapabilityRegistry,
    NukeCapabilityResult
} from 'nuke-core/lib/common/nuke-capability-protocol';
import type { NukePreviewBundle, NukePreviewSession } from '../../extensions/nuke-ai/src/common/nuke-preview-protocol';
import type { NukeAiMetricsService } from '../../extensions/nuke-ai/src/browser/capabilities/nuke-ai-metrics-service';
import type { NukeEditJournal } from '../../extensions/nuke-ai/src/browser/capabilities/nuke-edit-journal';
import type { NukePreviewStore } from '../../extensions/nuke-ai/src/browser/preview/nuke-preview-store';
import { NukeCapabilityToolBridge } from '../../extensions/nuke-ai/src/browser/capabilities/nuke-capability-tool-bridge';
import { toToolName } from '../../extensions/nuke-ai/src/browser/capabilities/nuke-tool-schema';
import {
    summarizeNukeToolResult,
    type NukeToolCallChangeSet
} from '../../extensions/nuke-ai/src/browser/capabilities/nuke-tool-call-summary';
import { collectButtons, escapeHtml, expectChangeRows, expectNoRawJson, renderCapabilityCard } from './nuke-capability-card-harness';
import {
    CAD_CONTEXT,
    CAD_DRAWING_ACTIONS,
    CAD_IMPORT_PATH,
    CAD_IMPORT_PREVIEW_INPUT,
    CAD_MOVE_ARM,
    CAD_OPENMC_CONTEXT,
    CAD_OPENMC_PROJECT_JSON,
    CAD_OPENMC_PROJECT_PATH,
    CAD_SKETCH_REQUEST,
    CAD_TOPOLOGY_BUILD_CHANGED_GROUP,
    PATTERN_COUNT_CHANGE,
    createAssemblyHarness,
    createCadHarness,
    createDrawingHarness,
    createImportHarness,
    createTopologyHarness,
    stubAssemblyTessellation,
    stubCandidateTessellation
} from './nuke-cad-authoring-harness';
import {
    APPLY_ASSEMBLY_CHANGE_ID,
    APPLY_DRAWING_CHANGE_ID,
    APPLY_FEATURE_CHANGE_ID,
    APPLY_IMPORT_BODIES_ID,
    APPLY_SKETCH_CHANGE_ID,
    APPLY_TOPOLOGY_CHANGE_ID,
    INSPECT_IMPORT_SOURCE_ID,
    PREVIEW_ASSEMBLY_CHANGE_ID,
    PREVIEW_DRAWING_CHANGE_ID,
    PREVIEW_FEATURE_CHANGE_ID,
    PREVIEW_IMPORT_BODIES_ID,
    PREVIEW_SKETCH_CHANGE_ID,
    PREVIEW_TOPOLOGY_CHANGE_ID
} from '../../extensions/nuke-cad/src/browser/capabilities/nuke-cad-authoring-capabilities';
import { buildDagmcState, buildGeometryState, buildState, createOpenMcHarness, OPENMC_PROJECT_PATH } from './openmc-capability-harness';

// Keep the suite in Node: the real services these capabilities orchestrate pull
// in browser DOM modules. Only the module boundaries are mocked.
vi.mock('@theia/core/lib/common', () => {
    class Emitter<T> {
        private readonly listeners: ((value: T) => void)[] = [];
        readonly event = (listener: (value: T) => void) => {
            this.listeners.push(listener);
            return { dispose: () => undefined };
        };
        fire(value: T): void {
            for (const listener of this.listeners) {
                listener(value);
            }
        }
    }
    return { Emitter, Event: class {}, nls: { localize: (_key: string, value: string) => value } };
});
vi.mock('@theia/core/lib/common/message-service', () => ({ MessageService: class {} }));
vi.mock('@theia/core/lib/common/preferences', () => ({ PreferenceScope: {}, PreferenceService: class {} }));
vi.mock('@theia/workspace/lib/browser', () => ({ WorkspaceService: class WorkspaceService {} }));
vi.mock('@theia/workspace/lib/browser/workspace-service', () => ({ WorkspaceService: class WorkspaceService {} }));
vi.mock('@theia/filesystem/lib/browser/file-service', () => ({ FileService: class FileService {} }));
vi.mock('@theia/filesystem/lib/browser/file-dialog', () => ({ FileDialogService: Symbol('FileDialogService') }));
vi.mock('@theia/monaco/lib/browser/monaco-workspace', () => ({ MonacoWorkspace: class MonacoWorkspace {} }));
vi.mock('../../extensions/openmc-studio/src/browser/services/openmc-environment-service', () => ({
    OpenMCEnvironmentService: class OpenMCEnvironmentService {}
}));
vi.mock('../../extensions/openmc-studio/src/browser/widgets/simulation-dashboard/simulation-runner', () => ({
    OpenMCSimulationRunner: class OpenMCSimulationRunner {}
}));
vi.mock('../../extensions/openmc-studio/src/browser/xml-generator/xml-generation-service', () => ({
    OpenMCXMLGenerationService: class OpenMCXMLGenerationService {}
}));
vi.mock('../../extensions/openmc-studio/src/browser/script-generator/python-exporter', () => ({
    OpenMCPythonExporter: class OpenMCPythonExporter {}
}));

type Invoker = (id: string, input: unknown, context?: NukeCapabilityContext) => Promise<NukeCapabilityResult>;

interface PreviewApplyFlow {
    readonly title: string;
    readonly previewId: string;
    readonly applyId: string;
    readonly previewInput: unknown;
    readonly applyInput: (proposalId: string) => unknown;
    readonly context?: NukeCapabilityContext;
    readonly beforePreview?: () => Promise<void>;
    readonly expectedWarnings?: readonly string[];
}

describe('CAD authoring capability cards', () => {
    it('renders a feature preview diff, invokes its apply capability, and shows Undo only after apply', async () => {
        const harness = createCadHarness();
        await expectPreviewAndApply(harness.invoke, {
            title: 'feature',
            previewId: PREVIEW_FEATURE_CHANGE_ID,
            applyId: APPLY_FEATURE_CHANGE_ID,
            previewInput: { changes: [{ featureId: 'pad-1', param: 'length', value: 120 }] },
            applyInput: (proposalId) => ({ proposalId })
        });
    });

    it('renders a sketch preview diff and its applied result', async () => {
        const harness = createCadHarness();
        stubCandidateTessellation(harness);
        await expectPreviewAndApply(harness.invoke, {
            title: 'sketch',
            previewId: PREVIEW_SKETCH_CHANGE_ID,
            applyId: APPLY_SKETCH_CHANGE_ID,
            previewInput: { changes: CAD_SKETCH_REQUEST },
            applyInput: (proposalId) => ({ proposalId })
        });
    });

    it('renders a topology preview diff, warnings, acknowledgement-gated apply, and Undo', async () => {
        const harness = createTopologyHarness();
        stubCandidateTessellation(harness);
        await expectPreviewAndApply(harness.invoke, {
            title: 'topology',
            previewId: PREVIEW_TOPOLOGY_CHANGE_ID,
            applyId: APPLY_TOPOLOGY_CHANGE_ID,
            previewInput: { changes: [PATTERN_COUNT_CHANGE] },
            applyInput: (proposalId) => ({ proposalId, acknowledgeRegionChanges: true }),
            expectedWarnings: ['No saved OpenMC project is open; DAGMC references cannot be checked.']
        });
    });

    it('renders an import preview diff and its applied result', async () => {
        const harness = createImportHarness();
        await expectPreviewAndApply(harness.invoke, {
            title: 'import',
            previewId: PREVIEW_IMPORT_BODIES_ID,
            applyId: APPLY_IMPORT_BODIES_ID,
            previewInput: CAD_IMPORT_PREVIEW_INPUT,
            applyInput: (proposalId) => ({ proposalId }),
            beforePreview: async () => {
                const inspected = await harness.invoke(INSPECT_IMPORT_SOURCE_ID, { sourcePath: CAD_IMPORT_PATH });
                expect(inspected.ok).toBe(true);
            }
        });
    });

    it('renders an assembly preview diff and its applied result', async () => {
        const harness = createAssemblyHarness();
        stubAssemblyTessellation(harness);
        await expectPreviewAndApply(harness.invoke, {
            title: 'assembly',
            previewId: PREVIEW_ASSEMBLY_CHANGE_ID,
            applyId: APPLY_ASSEMBLY_CHANGE_ID,
            previewInput: { changes: [CAD_MOVE_ARM] },
            applyInput: (proposalId) => ({ proposalId })
        });
    });

    it('renders a drawing preview diff and its applied result', async () => {
        const harness = createDrawingHarness();
        await expectPreviewAndApply(harness.invoke, {
            title: 'drawing',
            previewId: PREVIEW_DRAWING_CHANGE_ID,
            applyId: APPLY_DRAWING_CHANGE_ID,
            previewInput: { changes: CAD_DRAWING_ACTIONS },
            applyInput: (proposalId) => ({ proposalId })
        });
    });

    it('hides Apply on a blocked preview whose change set omits the apply capability', async () => {
        const harness = createTopologyHarness({
            build: CAD_TOPOLOGY_BUILD_CHANGED_GROUP,
            files: { [CAD_OPENMC_PROJECT_PATH]: CAD_OPENMC_PROJECT_JSON }
        });
        stubCandidateTessellation(harness);

        const preview = await harness.invoke(PREVIEW_TOPOLOGY_CHANGE_ID, { changes: [PATTERN_COUNT_CHANGE] }, CAD_OPENMC_CONTEXT);

        expect(preview.ok).toBe(true);
        expect(preview.changeSet).toBeDefined();
        expect(preview.changeSet?.applyCapability).toBeUndefined();
        const card = await renderCapabilityCard(toToolName(PREVIEW_TOPOLOGY_CHANGE_ID), preview);
        expect(collectButtons(card.tree, 'nuke-tool-card-apply-button')).toHaveLength(0);
        expect(collectButtons(card.tree, 'nuke-tool-card-undo-button')).toHaveLength(0);
        expect(card.bodyHtml).not.toContain('Apply with NukeAI');
        expectNoRawJson(card.bodyHtml);
    });
});

describe('OpenMC capability cards', () => {
    it('renders a settings preview diff and its applied result', async () => {
        const harness = createOpenMcHarness({ state: buildState() });
        await expectPreviewAndApply(harness.invoke, {
            title: 'settings',
            previewId: 'nuke.openmc.previewSettings',
            applyId: 'nuke.openmc.applySettings',
            previewInput: {
                changes: [
                    { path: 'run.particles', value: 2000 },
                    { path: 'verbosity', value: 3 }
                ],
                summary: 'Tune run'
            },
            applyInput: (proposalId) => ({ proposalId })
        });
    });

    it('renders a material preview diff and its applied result', async () => {
        const harness = createOpenMcHarness({ state: buildState() });
        await expectPreviewAndApply(harness.invoke, {
            title: 'material',
            previewId: 'nuke.openmc.previewMaterialChange',
            applyId: 'nuke.openmc.applyMaterialChange',
            previewInput: {
                actions: [{ action: 'update', materialId: 1, updates: { density: 1.5, color: '#00ff00' } }],
                summary: 'Tune water'
            },
            applyInput: (proposalId) => ({ proposalId })
        });
    });

    it('renders a tally preview diff and its applied result', async () => {
        const harness = createOpenMcHarness({ state: buildState() });
        await expectPreviewAndApply(harness.invoke, {
            title: 'tally',
            previewId: 'nuke.openmc.previewTallyChange',
            applyId: 'nuke.openmc.applyTallyChange',
            previewInput: {
                actions: [
                    { action: 'update', tallyId: 1, updates: { scores: ['flux', 'heating'] } },
                    { action: 'remove', tallyId: 2 }
                ],
                summary: 'Refine tallies'
            },
            applyInput: (proposalId) => ({ proposalId })
        });
    });

    it('renders a CSG geometry preview diff and its applied result', async () => {
        const harness = createOpenMcHarness({ state: buildGeometryState() });
        await expectPreviewAndApply(harness.invoke, {
            title: 'geometry',
            previewId: 'nuke.openmc.previewGeometryChange',
            applyId: 'nuke.openmc.applyGeometryChange',
            previewInput: {
                actions: [
                    { action: 'update', kind: 'cell', id: 2, updates: { name: 'Shield' } },
                    { action: 'add', kind: 'surface', value: { id: 2, type: 'z-plane', coefficients: { z0: 5 } } }
                ],
                summary: 'Shape the shield'
            },
            applyInput: (proposalId) => ({ proposalId })
        });
    });

    it('renders a DAGMC preview diff and its applied result', async () => {
        const harness = createOpenMcHarness({ state: buildDagmcState() });
        await expectPreviewAndApply(harness.invoke, {
            title: 'DAGMC',
            previewId: 'nuke.openmc.previewDagmcChange',
            applyId: 'nuke.openmc.applyDagmcChange',
            previewInput: {
                actions: [
                    { action: 'assign', volumeId: 2, material: 'Water' },
                    { action: 'setFlags', autoMatIds: true }
                ],
                summary: 'Refill volume 2'
            },
            applyInput: (proposalId) => ({ proposalId })
        });
    });

    it('shows the written path, no Apply, and no Undo for nuke.openmc.createProject', async () => {
        const harness = createOpenMcHarness();
        const result = await harness.invoke('nuke.openmc.createProject', {
            name: 'Contract Demo',
            path: 'projects/contract.nuke-openmc',
            templateId: 'pin-cell',
            parameters: { enrichmentPct: 3.2 }
        });

        expect(result.ok).toBe(true);
        expect(result.changeSet).toBeUndefined();
        expect(result.undoToken).toBeUndefined();
        const path = (result.data as { projectPath: string }).projectPath;
        expect(path).toBe('/workspace/projects/contract.nuke-openmc');
        const card = await renderCapabilityCard(toToolName('nuke.openmc.createProject'), result);
        expect(card.bodyHtml).toContain(escapeHtml(path));
        expect(collectButtons(card.tree, 'nuke-tool-card-apply-button')).toHaveLength(0);
        expect(collectButtons(card.tree, 'nuke-tool-card-undo-button')).toHaveLength(0);
        expectNoRawJson(card.bodyHtml);
    });

    it('shows the written path, no Apply, and no Undo for nuke.openmc.exportPython', async () => {
        const harness = createOpenMcHarness({ state: buildState(), projectPath: OPENMC_PROJECT_PATH });
        const result = await harness.invoke('nuke.openmc.exportPython', {});

        expect(result.ok).toBe(true);
        expect(result.changeSet).toBeUndefined();
        expect(result.undoToken).toBeUndefined();
        const path = (result.data as { paths: string[] }).paths[0];
        expect(path).toBe('/workspace/model.py');
        const card = await renderCapabilityCard(toToolName('nuke.openmc.exportPython'), result);
        expect(card.bodyHtml).toContain(escapeHtml(path));
        expect(collectButtons(card.tree, 'nuke-tool-card-apply-button')).toHaveLength(0);
        expect(collectButtons(card.tree, 'nuke-tool-card-undo-button')).toHaveLength(0);
        expectNoRawJson(card.bodyHtml);
    });

    it('renders a failing capability as a failed card without throwing', async () => {
        const harness = createOpenMcHarness();
        const result = await harness.invoke('nuke.openmc.applySettings', { proposalId: 'missing' });

        expect(result.ok).toBe(false);
        const card = await renderCapabilityCard(toToolName('nuke.openmc.applySettings'), result);
        expect(card.summary.errors.length).toBeGreaterThan(0);
        expect(card.html).toContain('nuke-tool-card-failed');
        expect(card.html).toContain('Failed');
        expect(card.html).toContain(escapeHtml(result.message!));
        expectNoRawJson(card.bodyHtml);
    });
});

describe('scripted-agent capability bridge', () => {
    it('registers a real capability as a tool and returns converted content for success and failure', async () => {
        const harness = createCadHarness();
        const preview = harness.registered.get(PREVIEW_FEATURE_CHANGE_ID);
        const apply = harness.registered.get(APPLY_FEATURE_CHANGE_ID);
        if (!preview || !apply) {
            throw new Error('Expected the CAD authoring capabilities to register.');
        }
        const bridge = createBridge([preview, apply]);

        await bridge.bridge.onStart();

        const toolName = toToolName(PREVIEW_FEATURE_CHANGE_ID);
        const tool = bridge.toolRegistry.tools.get(toolName) as ToolRequest;
        expect(tool.id).toBe(toolName);
        expect(tool.name).toBe(toolName);
        expect(tool.providerName).toBe('nuke-ai');

        const result = (await tool.handler(JSON.stringify({ changes: [{ featureId: 'pad-1', param: 'length', value: 120 }] }), {
            toolCallId: 'call-1'
        })) as ToolCallContent;
        const parsed = summarizeNukeToolResult(result);
        expect(parsed.changeSet?.applyCapability).toBe(APPLY_FEATURE_CHANGE_ID);
        expect(parsed.changeSet?.changes.length).toBeGreaterThan(0);

        const failedTool = bridge.toolRegistry.tools.get(toToolName(APPLY_FEATURE_CHANGE_ID)) as ToolRequest;
        const failed = (await failedTool.handler(JSON.stringify({ proposalId: 'missing' }), { toolCallId: 'call-2' })) as ToolCallContent;
        expect(failed.content[0]).toMatchObject({ type: 'error' });
        expect((failed.content[0] as { data: string }).data).toContain('missing or expired');
    });
});

async function expectPreviewAndApply(invoke: Invoker, flow: PreviewApplyFlow): Promise<void> {
    if (flow.beforePreview) {
        await flow.beforePreview();
    }
    const preview = await invoke(flow.previewId, flow.previewInput, flow.context);
    expect(preview.ok).toBe(true);
    expect(preview.changeSet).toBeDefined();
    expect(preview.changeSet?.applyCapability).toBe(flow.applyId);
    expect(preview.undoToken).toBeUndefined();

    const applied: NukeToolCallChangeSet[] = [];
    const previewCard = await renderCapabilityCard(toToolName(flow.previewId), preview, {
        onApplyChangeSet: (changeSet) => {
            applied.push(changeSet);
        }
    });
    expect(previewCard.summary.changeSet).toEqual(preview.changeSet);
    expect(previewCard.html).toContain(escapeHtml(preview.changeSet!.title));
    if (preview.changeSet!.summary.length > 0) {
        expect(previewCard.html).toContain(escapeHtml(preview.changeSet!.summary));
    }
    expectChangeRows(previewCard.html, preview.changeSet!);
    for (const warning of preview.warnings ?? []) {
        expect(previewCard.html).toContain(escapeHtml(warning));
    }
    for (const warning of flow.expectedWarnings ?? []) {
        expect(preview.warnings).toContain(warning);
        expect(previewCard.html).toContain(escapeHtml(warning));
    }
    expectNoRawJson(previewCard.bodyHtml);

    const applyButtons = collectButtons(previewCard.tree, 'nuke-tool-card-apply-button');
    expect(applyButtons).toHaveLength(1);
    expect(applyButtons[0].props.children).toBe('Apply with NukeAI');
    expect(applyButtons[0].props.disabled).toBe(false);
    applyButtons[0].props.onClick?.();
    expect(applied).toHaveLength(1);
    expect(applied[0].id).toBe(preview.changeSet!.id);
    expect(applied[0].applyCapability).toBe(flow.applyId);
    expect(collectButtons(previewCard.tree, 'nuke-tool-card-undo-button')).toHaveLength(0);

    const applyResult = await invoke(flow.applyId, flow.applyInput(applied[0].id), flow.context);
    expect(applyResult.ok).toBe(true);
    expect(applyResult.changeSet).toBeDefined();
    expect(applyResult.changeSet?.id).toBe(applied[0].id);
    expect(applyResult.changeSet?.changes).toEqual(preview.changeSet!.changes);
    expect(applyResult.undoToken).toBeTruthy();

    const undone: string[] = [];
    const applyCard = await renderCapabilityCard(toToolName(flow.applyId), applyResult, {
        onUndo: (token) => {
            undone.push(token);
        }
    });
    expect(applyCard.summary.changeSet).toEqual(applyResult.changeSet);
    expect(applyCard.html).toContain(escapeHtml(applyResult.changeSet!.title));
    if (applyResult.changeSet!.summary.length > 0) {
        expect(applyCard.html).toContain(escapeHtml(applyResult.changeSet!.summary));
    }
    expectChangeRows(applyCard.html, applyResult.changeSet!);
    expectNoRawJson(applyCard.bodyHtml);
    const applyButtonsAfterApply = collectButtons(applyCard.tree, 'nuke-tool-card-apply-button');
    const undoButtons = collectButtons(applyCard.tree, 'nuke-tool-card-undo-button');
    expect(undoButtons).toHaveLength(1);
    expect(undoButtons[0].props.disabled).toBe(false);
    undoButtons[0].props.onClick?.();
    expect(undone).toEqual([applyResult.undoToken]);

    if (applyResult.changeSet?.applyCapability !== undefined) {
        // An applied change set must omit the apply capability so the card shows
        // only Undo; otherwise the same proposal looks appliable a second time.
        const repeatedApply = await invoke(flow.applyId, flow.applyInput(applied[0].id), flow.context);
        expect(repeatedApply.ok).toBe(false);
        expect(repeatedApply.message).toContain('missing or expired');
        throw new Error(
            `${flow.applyId} returned changeSet.applyCapability=${applyResult.changeSet.applyCapability}; ` +
                `an applied result must not advertise a second Apply action (rendered ${applyButtonsAfterApply.length} Apply buttons).`
        );
    }
    expect(applyButtonsAfterApply).toHaveLength(0);
}

interface BridgeHarness {
    readonly bridge: NukeCapabilityToolBridge;
    readonly toolRegistry: FakeToolRegistry;
}

function createBridge(capabilities: readonly NukeCapability[]): BridgeHarness {
    const toolRegistry = new FakeToolRegistry();
    const bridge = new NukeCapabilityToolBridge(
        new FakeReverseRegistry(capabilities),
        new FakeContextService(),
        toolRegistry,
        { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as never,
        new FakePreviewStore() as unknown as NukePreviewStore,
        {} as FileService,
        { record: vi.fn() } as unknown as NukeAiMetricsService,
        { record: vi.fn() } as unknown as NukeEditJournal
    );
    return { bridge, toolRegistry };
}

class FakeReverseRegistry implements NukeCapabilityRegistry {
    readonly onDidChange = Event.None;
    readonly ready = Promise.resolve();

    constructor(readonly capabilities: readonly NukeCapability[]) {}

    register(): void {
        // Registration is not part of the bridge contract under test.
    }

    get(id: string): NukeCapability | undefined {
        return this.capabilities.find((capability) => capability.id === id);
    }

    getAll(): readonly NukeCapability[] {
        return [...this.capabilities];
    }

    getEnabled(context: NukeCapabilityContext): readonly NukeCapability[] {
        return this.capabilities.filter((capability) => !capability.when || capability.when(context));
    }
}

class FakeContextService implements NukeCapabilityContextService {
    readonly onDidChangeContext = Event.None;

    async getContext(): Promise<NukeCapabilityContext> {
        return CAD_CONTEXT;
    }
}

class FakeToolRegistry implements ToolInvocationRegistry {
    readonly tools = new Map<string, ToolRequest>();
    readonly onDidChange = Event.None;

    registerTool(tool: ToolRequest): void {
        this.tools.set(tool.id, tool);
    }

    unregisterTool(toolId: string): void {
        this.tools.delete(toolId);
    }

    unregisterAllTools(providerName: string): void {
        for (const [id, tool] of [...this.tools.entries()]) {
            if (tool.providerName === providerName) {
                this.tools.delete(id);
            }
        }
    }

    getFunction(toolId: string): ToolRequest | undefined {
        return this.tools.get(toolId);
    }

    getFunctions(...toolIds: string[]): ToolRequest[] {
        return toolIds.map((id) => this.tools.get(id)).filter((tool): tool is ToolRequest => tool !== undefined);
    }

    getAllFunctions(): ToolRequest[] {
        return [...this.tools.values()];
    }
}

class FakePreviewStore {
    readonly releaseSession = vi.fn();
    readonly createSession = vi.fn(async (): Promise<NukePreviewSession> => ({
        id: 'session-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        rootDir: CAD_CONTEXT.workspaceRoots[0]
    }));
    readonly capture = vi.fn(async (): Promise<NukePreviewBundle> => ({
        id: 'bundle-001',
        sessionId: 'session-1',
        createdAt: '2026-01-01T00:00:00.000Z'
    }));
}
