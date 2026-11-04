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
 * NukeAI walkthrough provider.
 *
 * Wraps Theia's AI getting-started walkthrough and rewrites its product copy
 * and links to NukeAI. The walkthrough id and every step id stay unchanged so
 * existing progress, the `ai.openGettingStartedWalkthrough` command, and the
 * chat welcome's "unfinished walkthrough" action keep working.
 *
 * The wrapper leaves the enable/model/agent/confirmation steps untouched: their
 * commands and preference ids are Theia's UI and remain correct.
 *
 * @module nuke-ai/browser/welcome
 */

import { inject, injectable } from '@theia/core/shared/inversify';
import { FrontendApplicationConfigProvider } from '@theia/core/lib/browser/frontend-application-config-provider';
import { ENABLE_AI_CONTEXT_KEY } from '@theia/ai-core/lib/browser/ai-activation-service';
import { AiGettingStartedWalkthroughProvider } from '@theia/ai-ide/lib/browser/ai-getting-started-walkthrough';
import type { WalkthroughProvider } from '@theia/getting-started/lib/common/walkthrough-provider';
import type { WalkthroughDefinition, WalkthroughStepDefinition } from '@theia/getting-started/lib/common/walkthrough-types';

/** Opens the NukeAI user guide inside the IDE docs widget. */
export const NUKE_AI_GUIDE_LINK = 'command:nuke.docs.open?/nuke-ai/user/getting-started.md';

/** NukeHub organization page shown in the closing step. */
export const NUKE_HUB_URL = 'https://github.com/nukehub-dev/nuke-ide';

/** Theia documentation link the base walkthrough uses for its closing step. */
const THEIA_AI_DOC_URL = 'https://theia-ide.org/docs/user_ai/';

/** Framework link the base walkthrough uses on its opening slide. */
const THEIA_AI_FRAMEWORK_URL = 'https://theia-ide.org/docs/theia_ai/';

/** Icon name shown on the walkthrough card and detail header. */
const NUKE_AI_WALKTHROUGH_ICON = 'hubot';

/** Rewrites Theia's AI walkthrough copy and links to NukeAI. */
@injectable()
export class NukeAiWalkthroughProvider implements WalkthroughProvider {
    constructor(
        @inject(AiGettingStartedWalkthroughProvider)
        protected readonly base: AiGettingStartedWalkthroughProvider
    ) {}

    getWalkthroughs(): WalkthroughDefinition[] {
        return this.base.getWalkthroughs().map((walkthrough) => this.customize(walkthrough));
    }

    /** Apply the NukeAI identity and replace the generic Theia product links. */
    protected customize(walkthrough: WalkthroughDefinition): WalkthroughDefinition {
        const applicationName = FrontendApplicationConfigProvider.get().applicationName;
        return {
            ...walkthrough,
            icon: NUKE_AI_WALKTHROUGH_ICON,
            title: 'Get started with NukeAI',
            description: `Set up NukeAI in ${applicationName} and learn how to work with it.`,
            steps: walkthrough.steps.map((step) => this.customizeStep(step, applicationName))
        };
    }

    /** Rewrite only the two slides that carried Theia product links. */
    protected customizeStep(step: WalkthroughStepDefinition, applicationName: string): WalkthroughStepDefinition {
        if (step.id === 'ai-support') {
            return {
                ...step,
                title: `NukeAI in ${applicationName}`,
                description: `
${applicationName} ships **NukeAI**: a chat assistant for CAD geometry, DAGMC export, OpenMC projects and runs, and statepoint visualization.

NukeAI works through typed tools. It can read your active document or project, prepare a change, and apply it only after you confirm. Write and run tools always ask first.

AI features are disabled by default. Once enabled, they may generate continuous requests to the language model provider you connect, and those costs are yours to monitor.

[Read the NukeAI guide](${NUKE_AI_GUIDE_LINK}) · [NukeIDE on GitHub](${NUKE_HUB_URL})
`.trim(),
                completionEvents: [`onContext:${ENABLE_AI_CONTEXT_KEY}`, `onLink:${NUKE_AI_GUIDE_LINK}`]
            };
        }
        if (step.id === 'go-further') {
            return {
                ...step,
                description: step.description
                    .split(THEIA_AI_DOC_URL)
                    .join(NUKE_AI_GUIDE_LINK)
                    .split(THEIA_AI_FRAMEWORK_URL)
                    .join(NUKE_HUB_URL)
                    .replace('the documentation', 'the NukeAI guide')
                    .replace('your feedback is always welcome', `your feedback is always welcome on [GitHub](${NUKE_HUB_URL})`)
            };
        }
        return step;
    }
}
