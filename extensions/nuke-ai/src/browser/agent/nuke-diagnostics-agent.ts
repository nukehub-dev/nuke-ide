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
 * Nuke Diagnostics Agent
 *
 * The dedicated `Nuke Diagnostics` chat agent. It uses the standard streaming
 * chat pipeline with a read-only diagnostics prompt, the `#nukeContext`
 * variable, and the diagnostic tools plus read-only support tools published by
 * the in-process bridge.
 *
 * @module nuke-ai/browser/agent
 */

import { injectable } from '@theia/core/shared/inversify';
import { LanguageModelRequirement, PromptVariantSet } from '@theia/ai-core';
import { AbstractStreamParsingChatAgent, ChatAgentLocation } from '@theia/ai-chat/lib/common/chat-agents';
import { NUKE_DIAGNOSTICS_TOOL_NAMES } from '../../common/nuke-capability-catalog';
import { NUKE_CONTEXT_VARIABLE_ID } from './nuke-chat-agent';
import { NUKE_DIAGNOSTICS_SYSTEM_PROMPT } from './nuke-diagnostics-system-prompt';

/** Diagnostic and read-only support tool names published by the capability bridge. */
export { NUKE_DIAGNOSTICS_TOOL_NAMES };

/** Identifier of the dedicated Nuke Diagnostics chat agent. */
export const NUKE_DIAGNOSTICS_AGENT_ID = 'NukeDiagnostics';

/** Prompt set that owns the Nuke Diagnostics system instructions. */
export const NUKE_DIAGNOSTICS_SYSTEM_PROMPT_ID = 'nuke-diagnostics-system';

/** Default variant of the Nuke Diagnostics system prompt. */
export const NUKE_DIAGNOSTICS_SYSTEM_PROMPT_VARIANT_ID = 'nuke-diagnostics-system-default';

/** Read-only diagnostics agent for CAD, OpenMC, and statepoint state. */
@injectable()
export class NukeDiagnosticsAgent extends AbstractStreamParsingChatAgent {
    readonly id = NUKE_DIAGNOSTICS_AGENT_ID;

    readonly name = 'Nuke Diagnostics';

    description =
        'Read-only diagnostics for the active CAD model, OpenMC project and run, statepoint metadata and comparison, and tally series.';

    iconClass = 'codicon codicon-checklist';

    tags = ['nuke', 'diagnostics', 'cad', 'openmc', 'visualizer'];

    locations = [ChatAgentLocation.Panel];

    languageModelRequirements: LanguageModelRequirement[] = [{ purpose: 'chat' }];

    protected defaultLanguageModelPurpose = 'chat';

    prompts: PromptVariantSet[] = [
        {
            id: NUKE_DIAGNOSTICS_SYSTEM_PROMPT_ID,
            defaultVariant: {
                id: NUKE_DIAGNOSTICS_SYSTEM_PROMPT_VARIANT_ID,
                template: NUKE_DIAGNOSTICS_SYSTEM_PROMPT
            }
        }
    ];

    protected systemPromptId = NUKE_DIAGNOSTICS_SYSTEM_PROMPT_ID;

    variables = [NUKE_CONTEXT_VARIABLE_ID];

    functions = [...NUKE_DIAGNOSTICS_TOOL_NAMES];
}
