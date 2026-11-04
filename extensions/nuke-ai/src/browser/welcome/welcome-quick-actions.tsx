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
 * NukeAI Welcome Quick Actions
 *
 * The "NukeAI quick start" section of the Nuke chat welcome screen. Every
 * action runs an existing NukeAI command through the injected callback, so the
 * component stays free of Theia services and renders to static markup in tests.
 * The model setup card is shown only while no language model is ready.
 *
 * @module nuke-ai/browser/welcome
 */

import * as React from '@theia/core/shared/react';
import { NukeAiCommands } from '../actions/nuke-ai-commands';
import './welcome-quick-actions.css';

/** One quick action shown on the NukeAI welcome screen. */
export interface WelcomeQuickAction {
    readonly id: string;
    readonly commandId: string;
    readonly label: string;
    readonly description: string;
    readonly icon: string;
}

/** The quick actions in display order. */
export const WELCOME_QUICK_ACTIONS: readonly WelcomeQuickAction[] = [
    {
        id: 'ask',
        commandId: NukeAiCommands.ASK.id,
        label: 'Ask About Active Context',
        description: 'Summarize the active CAD model, OpenMC project, and dataset without changing anything.',
        icon: 'comment-discussion'
    },
    {
        id: 'check-cad',
        commandId: NukeAiCommands.CHECK_CAD.id,
        label: 'Check Active CAD Model',
        description: 'Report build status, counts, selection, and warnings for the active CAD document.',
        icon: 'beaker'
    },
    {
        id: 'diagnose-openmc',
        commandId: NukeAiCommands.DIAGNOSE_OPENMC.id,
        label: 'Diagnose OpenMC Project',
        description: 'Triage project validation, environment readiness, and cross-section state.',
        icon: 'checklist'
    },
    {
        id: 'preview-settings',
        commandId: NukeAiCommands.PREVIEW_SETTINGS.id,
        label: 'Review OpenMC Settings',
        description: 'Review the active run settings and preview a change before anything is applied.',
        icon: 'settings-gear'
    },
    {
        id: 'diagnose-statepoint',
        commandId: NukeAiCommands.DIAGNOSE_STATEPOINT.id,
        label: 'Diagnose Active Statepoint',
        description: 'Check k-effective uncertainty, batches, and tally coverage for the loaded statepoint.',
        icon: 'graph'
    }
];

/** Props for the quick-start section. */
export interface WelcomeQuickActionsProps {
    /** Run an existing command by id. */
    readonly onRun: (commandId: string) => void;
    /** Whether at least one language model is ready. */
    readonly hasReadyModel: boolean;
    /** Command that opens the AI configuration view or AI preferences. */
    readonly modelSettingsCommandId: string;
}

/** Render the NukeAI quick-start section of the chat welcome screen. */
export function WelcomeQuickActions({ onRun, hasReadyModel, modelSettingsCommandId }: WelcomeQuickActionsProps): React.ReactElement {
    return (
        <div className="nuke-welcome-quick-actions-frame">
            <section
                className="nuke-welcome-quick-actions"
                aria-labelledby="nuke-welcome-quick-actions-title"
                data-ready-model={hasReadyModel ? 'true' : 'false'}
            >
                <div className="nuke-welcome-quick-actions-header">
                    <h2 id="nuke-welcome-quick-actions-title" className="nuke-welcome-quick-actions-title">
                        NukeAI quick start
                    </h2>
                    <p className="nuke-welcome-quick-actions-subtitle">
                        Run a focused read-only request with your active workspace context, or ask NukeAI a question in the chat.
                    </p>
                </div>
                {!hasReadyModel && (
                    <div className="nuke-welcome-quick-actions-setup" data-state="model-setup">
                        <span className="codicon codicon-warning nuke-welcome-quick-actions-setup-icon" aria-hidden="true" />
                        <div className="nuke-welcome-quick-actions-setup-body">
                            <span className="nuke-welcome-quick-actions-setup-title">Choose a model</span>
                            <span className="nuke-welcome-quick-actions-setup-text">
                                Choose a model provider and API key in AI settings to start a NukeAI chat.
                            </span>
                        </div>
                        <button
                            type="button"
                            className="theia-button main nuke-welcome-quick-actions-setup-button"
                            data-command-id={modelSettingsCommandId}
                            onClick={() => onRun(modelSettingsCommandId)}
                        >
                            Open AI Settings
                        </button>
                    </div>
                )}
                <ul className="nuke-welcome-quick-actions-grid">
                    {WELCOME_QUICK_ACTIONS.map((action) => (
                        <li key={action.id} className="nuke-welcome-quick-actions-item">
                            <button
                                type="button"
                                className="nuke-welcome-quick-action"
                                data-command-id={action.commandId}
                                onClick={() => onRun(action.commandId)}
                            >
                                <span className={`codicon codicon-${action.icon} nuke-welcome-quick-action-icon`} aria-hidden="true" />
                                <span className="nuke-welcome-quick-action-body">
                                    <span className="nuke-welcome-quick-action-label">{action.label}</span>
                                    <span className="nuke-welcome-quick-action-description">{action.description}</span>
                                </span>
                            </button>
                        </li>
                    ))}
                </ul>
            </section>
        </div>
    );
}
