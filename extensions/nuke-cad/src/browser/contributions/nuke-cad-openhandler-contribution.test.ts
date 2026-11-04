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
vi.mock('@theia/filesystem/lib/browser/file-service', () => ({ FileService: class {} }));
vi.mock('@theia/workspace/lib/browser', () => ({ WorkspaceService: class {} }));
vi.mock('../nuke-cad-preferences', () => ({ NukeCadPreferences: Symbol('NukeCadPreferences') }));
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

import { URI } from '@theia/core/lib/common/uri';
import type { GeometryBuildResult } from '../../common/nuke-cad-protocol';
import type { WorkspaceService } from '@theia/workspace/lib/browser';
import type { FileService } from '@theia/filesystem/lib/browser/file-service';
import type { NukeCadPreferences } from '../nuke-cad-preferences';
import type { CadModel } from '../state/nuke-cad-state-manager';
import { NukeCadOpenHandler } from './nuke-cad-openhandler-contribution';

const WORKSPACE = '/workspace/project';
const SCRIPT_PATH = `${WORKSPACE}/pincell_model.py`;

const BUILD_RESULT: GeometryBuildResult = {
    success: true,
    solidCount: 1,
    faceCount: 6,
    triangleCount: 12,
    boundingBox: { min: [0, 0, 0], max: [2, 2, 2] }
};

interface Harness {
    handler: NukeCadOpenHandler;
    backendService: { buildGeometry: ReturnType<typeof vi.fn>; buildSandboxedScript: ReturnType<typeof vi.fn> };
    stateManager: { setModel: ReturnType<typeof vi.fn> };
    messageService: { error: ReturnType<typeof vi.fn> };
    widget: { setLoading: ReturnType<typeof vi.fn>; showBuildError: ReturnType<typeof vi.fn> };
}

function createHarness(options: { scriptAuthoring?: boolean; sandboxAvailable?: boolean; sandboxSuccess?: boolean } = {}): Harness {
    const widget = {
        id: 'nuke-cad-viewport',
        isAttached: true,
        setLoading: vi.fn(),
        showBuildError: vi.fn()
    };
    const backendService = {
        buildGeometry: vi.fn(async () => BUILD_RESULT),
        getScriptSandboxStatus: vi.fn(async () => ({
            available: options.sandboxAvailable ?? true,
            engine: 'bubblewrap' as const,
            ...(options.sandboxAvailable === false ? { reason: 'bwrap is missing.' } : {})
        })),
        buildSandboxedScript: vi.fn(async () =>
            options.sandboxSuccess === false
                ? { success: false, error: 'The sandbox rejected the script.' }
                : {
                      success: true,
                      solidCount: 1,
                      faceCount: 6,
                      triangleCount: 12,
                      boundingBox: { min: [0, 0, 0], max: [2, 2, 2] },
                      tessPath: `${WORKSPACE}/sandbox/model.tess.json`,
                      durationMs: 100,
                      exitCode: 0
                  }
        )
    };
    const stateManager = { setModel: vi.fn() };
    const messageService = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const handler = new NukeCadOpenHandler();
    Object.assign(handler as unknown as Record<string, unknown>, {
        widgetManager: {
            getOrCreateWidget: vi.fn(async () => widget),
            getWidget: vi.fn(async () => widget)
        },
        shell: {
            addWidget: vi.fn(),
            revealWidget: vi.fn(),
            activateWidget: vi.fn()
        },
        backendService,
        stateManager,
        messageService,
        preferences: {
            'nukeCad.scriptAuthoringEnabled': options.scriptAuthoring ?? true,
            get: () => undefined
        } as unknown as NukeCadPreferences,
        workspaceService: {
            tryGetRoots: () => [{ resource: new URI(WORKSPACE) }]
        } as unknown as WorkspaceService,
        fileService: { createFolder: vi.fn(async () => undefined) } as unknown as FileService
    });
    return {
        handler,
        backendService: backendService as unknown as Harness['backendService'],
        stateManager: stateManager as unknown as Harness['stateManager'],
        messageService: messageService as unknown as Harness['messageService'],
        widget
    };
}

describe('NukeCadOpenHandler script sandbox routing', () => {
    it('opens a .py through the sandbox when script authoring is enabled', async () => {
        const harness = createHarness({ scriptAuthoring: true });

        await harness.handler.open(new URI(SCRIPT_PATH));

        expect(harness.backendService.buildGeometry).not.toHaveBeenCalled();
        expect(harness.backendService.buildSandboxedScript).toHaveBeenCalledTimes(1);
        expect(harness.backendService.buildSandboxedScript).toHaveBeenCalledWith(
            expect.objectContaining({
                scriptPath: SCRIPT_PATH,
                workspaceRoot: WORKSPACE,
                timeoutSeconds: 120,
                memoryLimitMb: 4096,
                processLimit: 128,
                fileSizeLimitMb: 512
            })
        );
        expect(harness.stateManager.setModel).toHaveBeenCalledWith(
            expect.objectContaining({
                scriptPath: SCRIPT_PATH,
                sandboxed: true,
                result: expect.objectContaining({ success: true, sandboxed: true })
            } satisfies Partial<CadModel>)
        );
        expect(harness.messageService.error).not.toHaveBeenCalled();
    });

    it('refuses to open unsandboxed when the sandbox is unavailable', async () => {
        const harness = createHarness({ scriptAuthoring: true, sandboxAvailable: false });

        await harness.handler.open(new URI(SCRIPT_PATH));

        expect(harness.backendService.buildGeometry).not.toHaveBeenCalled();
        expect(harness.backendService.buildSandboxedScript).not.toHaveBeenCalled();
        expect(harness.stateManager.setModel).not.toHaveBeenCalled();
        expect(harness.widget.showBuildError).toHaveBeenCalledWith(expect.stringContaining('cannot be opened unsandboxed'));
        expect(harness.messageService.error).toHaveBeenCalledWith(expect.stringContaining('cannot be opened unsandboxed'));
    });

    it('keeps the trusted buildGeometry path when script authoring is disabled', async () => {
        const harness = createHarness({ scriptAuthoring: false });

        await harness.handler.open(new URI(SCRIPT_PATH));

        expect(harness.backendService.buildGeometry).toHaveBeenCalledWith(
            expect.objectContaining({ scriptPath: SCRIPT_PATH, sourceType: 'script' })
        );
        expect(harness.backendService.buildSandboxedScript).not.toHaveBeenCalled();
        expect(harness.stateManager.setModel).toHaveBeenCalledWith(
            expect.objectContaining({ scriptPath: SCRIPT_PATH, result: BUILD_RESULT })
        );
    });
});
