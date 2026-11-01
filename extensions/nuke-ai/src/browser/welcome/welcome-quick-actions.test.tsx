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

import { describe, expect, it } from 'vitest';
import * as React from '@theia/core/shared/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NukeAiCommands } from '../actions/nuke-ai-commands';
import { WELCOME_QUICK_ACTIONS, WelcomeQuickActions } from './welcome-quick-actions';

const MODEL_SETTINGS_COMMAND = 'aiConfiguration:open';

function render(hasReadyModel: boolean): string {
    return renderToStaticMarkup(
        <WelcomeQuickActions hasReadyModel={hasReadyModel} modelSettingsCommandId={MODEL_SETTINGS_COMMAND} onRun={() => undefined} />
    );
}

describe('WelcomeQuickActions', () => {
    it('offers the five quick actions in order', () => {
        expect(WELCOME_QUICK_ACTIONS.map((action) => action.commandId)).toEqual([
            NukeAiCommands.ASK.id,
            NukeAiCommands.CHECK_CAD.id,
            NukeAiCommands.DIAGNOSE_OPENMC.id,
            NukeAiCommands.PREVIEW_SETTINGS.id,
            NukeAiCommands.DIAGNOSE_STATEPOINT.id
        ]);
    });

    it('renders every label and command id', () => {
        const html = render(true);

        expect(html).toContain('NukeAI quick start');
        expect(html).not.toContain('class="nuke-ai-bot"');
        expect(html).toContain('Ask About Active Context');
        expect(html).toContain('Check Active CAD Model');
        expect(html).toContain('Diagnose OpenMC Project');
        expect(html).toContain('Review OpenMC Settings');
        expect(html).toContain('Diagnose Active Statepoint');
        for (const action of WELCOME_QUICK_ACTIONS) {
            expect(html).toContain(`data-command-id="${action.commandId}"`);
        }
        expect(html).not.toContain('title=');
    });

    it('hides the model setup card when a language model is ready', () => {
        const html = render(true);

        expect(html).not.toContain('data-state="model-setup"');
        expect(html).not.toContain('Choose a model provider and API key');
        expect(html).toContain('data-ready-model="true"');
    });

    it('shows the model setup card and AI settings button when no model is ready', () => {
        const html = render(false);

        expect(html).toContain('data-state="model-setup"');
        expect(html).toContain('Choose a model provider and API key in AI settings');
        expect(html).toContain(`data-command-id="${MODEL_SETTINGS_COMMAND}"`);
        expect(html).toContain('Open AI Settings');
        expect(html).toContain('data-ready-model="false"');
    });
});
