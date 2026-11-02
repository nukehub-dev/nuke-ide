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

vi.mock('@theia/core/lib/browser', () => ({ ApplicationShell: class {}, WidgetManager: class {} }));
vi.mock('@theia/core/lib/browser/quick-input', () => ({ QuickInputService: class {} }));
vi.mock('@theia/filesystem/lib/browser/file-service', () => ({ FileService: class {} }));
vi.mock('@theia/filesystem/lib/browser/file-dialog', () => ({ FileDialogService: class {} }));
vi.mock('@theia/workspace/lib/browser', () => ({ WorkspaceService: class {} }));
vi.mock('@theia/editor/lib/browser', () => ({ EditorManager: class {} }));
vi.mock('./nuke-cad-openhandler-contribution', () => ({ NukeCadOpenHandler: class {} }));
vi.mock('../document/cad-document-store', () => ({ CadDocumentStore: class {} }));
vi.mock('../widgets/cad-viewport/cad-viewport-widget', () => ({
    CadViewportWidget: class CadViewportWidget {
        static readonly ID = 'nuke-cad-viewport';
    }
}));
vi.mock('../widgets/outline-panel/outline-panel-widget', () => ({
    CadOutlinePanelWidget: class CadOutlinePanelWidget {
        static readonly ID = 'nuke-cad-outline';
    }
}));
vi.mock('../widgets/feature-tree/feature-tree-widget', () => ({
    CadFeatureTreeWidget: class CadFeatureTreeWidget {
        static readonly ID = 'nuke-cad-feature-tree';
    }
}));
vi.mock('../widgets/bom-panel/bom-panel', () => ({ CadBomPanelWidget: class CadBomPanelWidget {} }));
vi.mock('../widgets/review-panel/review-panel-widget', () => ({ CadReviewPanelWidget: class CadReviewPanelWidget {} }));
vi.mock('../widgets/drawing-sheet/drawing-sheet-widget', () => ({ DrawingSheetWidget: class DrawingSheetWidget {} }));
vi.mock('../widgets/fem-panel/fem-panel-widget', () => ({ FemPanelWidget: class FemPanelWidget {} }));
vi.mock('../widgets/foam-panel/foam-panel-widget', () => ({ FoamPanelWidget: class FoamPanelWidget {} }));

import { URI } from '@theia/core/lib/common/uri';
import type { CommandRegistry } from '@theia/core/lib/common/command';
import type { GeometryBuildResult, SandboxedScriptBuildRequest } from '../../common/nuke-cad-protocol';
import type { WorkspaceService } from '@theia/workspace/lib/browser';
import type { CadDocumentStore } from '../document/cad-document-store';
import type { CadModel, NukeCadStateManager } from '../state/nuke-cad-state-manager';
import { NukeCadCommands } from '../commands';
import { NukeCadCommandContribution } from './nuke-cad-command-contribution';

const WORKSPACE = '/workspace/project';
const SCRIPT_PATH = `${WORKSPACE}/pincell_model.py`;

const BUILD_RESULT: GeometryBuildResult = {
    success: true,
    solidCount: 1,
    faceCount: 6,
    triangleCount: 12,
    boundingBox: { min: [0, 0, 0], max: [2, 2, 2] }
};

const SANDBOX_RESULT = {
    success: true,
    solidCount: 1,
    faceCount: 6,
    triangleCount: 12,
    boundingBox: { min: [0, 0, 0] as [number, number, number], max: [2, 2, 2] as [number, number, number] },
    tessPath: `${WORKSPACE}/sandbox/model.tess.json`,
    durationMs: 100,
    exitCode: 0
};

interface Harness {
    contribution: NukeCadCommandContribution;
    handlers: Map<string, { execute: (...args: unknown[]) => unknown }>;
    backendService: {
        buildGeometry: ReturnType<typeof vi.fn>;
        buildSandboxedScript: ReturnType<typeof vi.fn>;
        getScriptSandboxStatus: ReturnType<typeof vi.fn>;
    };
    stateManager: NukeCadStateManager & { setModel: ReturnType<typeof vi.fn> };
    messageService: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
    fileService: { createFolder: ReturnType<typeof vi.fn> };
    scriptBuilds: SandboxedScriptBuildRequest[];
    viewport: { setLoading: ReturnType<typeof vi.fn>; showBuildError: ReturnType<typeof vi.fn> };
}

function createHarness(options: { sandboxed?: boolean; sandboxAvailable?: boolean; sandboxSuccess?: boolean } = {}): Harness {
    const handlers = new Map<string, { execute: (...args: unknown[]) => unknown }>();
    const scriptBuilds: SandboxedScriptBuildRequest[] = [];
    const viewport = { setLoading: vi.fn(), showBuildError: vi.fn() };
    const model: CadModel = {
        scriptPath: SCRIPT_PATH,
        result: BUILD_RESULT,
        ...(options.sandboxed === true ? { sandboxed: true } : {})
    };
    const stateManager = {
        model,
        scriptPath: SCRIPT_PATH,
        setModel: vi.fn()
    } as unknown as NukeCadStateManager & { setModel: ReturnType<typeof vi.fn> };
    const backendService = {
        buildGeometry: vi.fn(async () => BUILD_RESULT),
        getScriptSandboxStatus: vi.fn(async () => ({
            available: options.sandboxAvailable ?? true,
            engine: 'bubblewrap' as const,
            ...(options.sandboxAvailable === false ? { reason: 'bwrap is missing.' } : {})
        })),
        buildSandboxedScript: vi.fn(async (request: SandboxedScriptBuildRequest) => {
            scriptBuilds.push(request);
            return options.sandboxSuccess === false ? { success: false, error: 'The sandbox rejected the script.' } : SANDBOX_RESULT;
        })
    };
    const messageService = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const fileService = { createFolder: vi.fn(async () => undefined) };
    const contribution = new NukeCadCommandContribution();
    Object.assign(contribution as unknown as Record<string, unknown>, {
        widgetManager: {
            getWidget: vi.fn(async () => viewport),
            getOrCreateWidget: vi.fn(async () => viewport)
        },
        shell: { addWidget: vi.fn(), activateWidget: vi.fn() },
        backendService,
        stateManager,
        documentStore: { hasDocument: false } as unknown as CadDocumentStore,
        fileService,
        fileDialogService: {},
        quickInput: {},
        workspaceService: {
            tryGetRoots: () => [{ resource: new URI(WORKSPACE) }]
        } as unknown as WorkspaceService,
        messageService
    });
    contribution.registerCommands({
        registerCommand: (command: { id: string }, handler: { execute: (...args: unknown[]) => unknown }) => {
            handlers.set(command.id, handler);
        }
    } as unknown as CommandRegistry);
    return {
        contribution,
        handlers,
        backendService: backendService as unknown as Harness['backendService'],
        stateManager,
        messageService: messageService as unknown as Harness['messageService'],
        fileService: fileService as unknown as Harness['fileService'],
        scriptBuilds,
        viewport
    };
}

async function rebuild(harness: Harness): Promise<void> {
    const handler = harness.handlers.get(NukeCadCommands.REBUILD_GEOMETRY.id);
    expect(handler).toBeDefined();
    await handler!.execute();
}

describe('NukeCadCommandContribution script rebuild routing', () => {
    it('rebuilds a sandboxed model through the sandbox and never calls buildGeometry', async () => {
        const harness = createHarness({ sandboxed: true });

        await rebuild(harness);

        expect(harness.backendService.buildGeometry).not.toHaveBeenCalled();
        expect(harness.backendService.buildSandboxedScript).toHaveBeenCalledTimes(1);
        expect(harness.scriptBuilds[0]).toMatchObject({
            scriptPath: SCRIPT_PATH,
            workspaceRoot: WORKSPACE,
            timeoutSeconds: 120,
            memoryLimitMb: 4096,
            processLimit: 128,
            fileSizeLimitMb: 512
        });
        expect(harness.scriptBuilds[0].outputDirectory).toMatch(/\/\.nuke-ide\/ai\/cad-scripts\/rebuild-[0-9a-f-]+\/out$/);
        expect(harness.scriptBuilds[0].jobId).toMatch(/^cad-ai-script-rebuild-/);
        expect(harness.fileService.createFolder).toHaveBeenCalledTimes(1);
        expect(harness.stateManager.setModel).toHaveBeenCalledWith(
            expect.objectContaining({
                scriptPath: SCRIPT_PATH,
                sandboxed: true,
                result: expect.objectContaining({ success: true, sandboxed: true, solidCount: 1 })
            })
        );
        expect(harness.messageService.error).not.toHaveBeenCalled();
    });

    it('keeps the unsandboxed buildGeometry path for a trusted script model', async () => {
        const harness = createHarness({ sandboxed: false });

        await rebuild(harness);

        expect(harness.backendService.buildGeometry).toHaveBeenCalledWith({ scriptPath: SCRIPT_PATH });
        expect(harness.backendService.buildSandboxedScript).not.toHaveBeenCalled();
        expect(harness.stateManager.setModel).toHaveBeenCalledWith({
            scriptPath: SCRIPT_PATH,
            result: BUILD_RESULT,
            manifest: undefined
        });
    });

    it('refuses to fall back when the sandbox is unavailable or the build fails', async () => {
        const unavailable = createHarness({ sandboxed: true, sandboxAvailable: false });
        await rebuild(unavailable);
        expect(unavailable.backendService.buildGeometry).not.toHaveBeenCalled();
        expect(unavailable.backendService.buildSandboxedScript).not.toHaveBeenCalled();
        expect(unavailable.stateManager.setModel).not.toHaveBeenCalled();
        expect(unavailable.messageService.error).toHaveBeenCalledWith(expect.stringContaining('sandbox is unavailable'));
        expect(unavailable.viewport.showBuildError).toHaveBeenCalledWith(expect.stringContaining('sandbox is unavailable'));

        const failed = createHarness({ sandboxed: true, sandboxSuccess: false });
        await rebuild(failed);
        expect(failed.backendService.buildGeometry).not.toHaveBeenCalled();
        expect(failed.stateManager.setModel).not.toHaveBeenCalled();
        expect(failed.messageService.error).toHaveBeenCalledWith('The sandbox rejected the script.');
        expect(failed.viewport.showBuildError).toHaveBeenCalledWith('The sandbox rejected the script.');
    });
});
