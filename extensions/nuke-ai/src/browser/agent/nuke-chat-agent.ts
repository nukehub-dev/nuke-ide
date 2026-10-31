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
 * Nuke Chat Agent
 *
 * The dedicated `NukeAI` chat agent. It uses the standard streaming chat
 * pipeline with a nuclear-engineering system prompt, the `#nukeContext`
 * variable, and the thirteen capability tools published by the in-process
 * bridge.
 *
 * @module nuke-ai/browser/agent
 */

import { injectable } from '@theia/core/shared/inversify';
import { LanguageModelRequirement, PromptVariantSet } from '@theia/ai-core';
import { AbstractStreamParsingChatAgent, ChatAgentLocation } from '@theia/ai-chat/lib/common/chat-agents';
import { NUKE_SYSTEM_PROMPT } from './nuke-system-prompt';

/** Identifier of the dedicated NukeAI chat agent. */
export const NUKE_CHAT_AGENT_ID = 'NukeAI';

/** Prompt set that owns the NukeAI system instructions. */
export const NUKE_SYSTEM_PROMPT_ID = 'nuke-system';

/** Default variant of the NukeAI system prompt. */
export const NUKE_SYSTEM_PROMPT_VARIANT_ID = 'nuke-system-default';

/** The `#nukeContext` variable id exposed to the agent. */
export const NUKE_CONTEXT_VARIABLE_ID = 'nuke.context';

/** Tool names published by the capability bridge, in workflow order. */
export const NUKE_CAPABILITY_TOOL_NAMES = [
    'nuke_cad_summarizeDocument',
    'nuke_cad_inspectSelection',
    'nuke_cad_exportDagmc',
    'nuke_openmc_summarizeProject',
    'nuke_openmc_validateProject',
    'nuke_openmc_previewSettings',
    'nuke_openmc_applySettings',
    'nuke_openmc_importCad',
    'nuke_openmc_runSimulation',
    'nuke_openmc_getRunStatus',
    'nuke_viz_summarizeStatepoint',
    'nuke_viz_openStatepoint',
    'nuke_viz_captureView'
] as const;

/** Dedicated chat agent for nuclear engineering workflows. */
@injectable()
export class NukeChatAgent extends AbstractStreamParsingChatAgent {
    readonly id = NUKE_CHAT_AGENT_ID;

    readonly name = 'NukeAI';

    description = 'Nuclear engineering assistant for CAD, DAGMC export, OpenMC projects and runs, and statepoint visualization in NukeIDE.';

    iconClass = 'codicon codicon-beaker';

    tags = ['nuke', 'nuclear', 'cad', 'openmc', 'visualizer'];

    locations = [ChatAgentLocation.Panel];

    languageModelRequirements: LanguageModelRequirement[] = [{ purpose: 'chat' }];

    protected defaultLanguageModelPurpose = 'chat';

    prompts: PromptVariantSet[] = [
        {
            id: NUKE_SYSTEM_PROMPT_ID,
            defaultVariant: {
                id: NUKE_SYSTEM_PROMPT_VARIANT_ID,
                template: NUKE_SYSTEM_PROMPT
            }
        }
    ];

    protected systemPromptId = NUKE_SYSTEM_PROMPT_ID;

    variables = [NUKE_CONTEXT_VARIABLE_ID];

    functions = [...NUKE_CAPABILITY_TOOL_NAMES];
}
