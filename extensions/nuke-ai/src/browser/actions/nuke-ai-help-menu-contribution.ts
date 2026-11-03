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
 * Help-menu entry for the shipped NukeAI walkthrough.
 *
 * The only walkthrough NukeIDE ships is the NukeAI one, so the generic
 * "Open Walkthrough..." entry would open a picker with a single item. This
 * contribution replaces it with a named entry that opens that walkthrough
 * directly; the generic command stays available in the Command Palette for any
 * future walkthrough.
 *
 * @module nuke-ai/browser/actions
 */

import { injectable } from '@theia/core/shared/inversify';
import { AI_OPEN_GETTING_STARTED_WALKTHROUGH } from '@theia/ai-ide/lib/browser/ai-getting-started-commands';
import { WalkthroughCommands } from '@theia/getting-started/lib/common/walkthrough-commands';
import { MenuContribution, MenuModelRegistry } from '@theia/core/lib/common/menu';
import { CommonMenus } from '@theia/core/lib/browser/common-menus';

/** Replaces the generic walkthrough entry in the Help menu. */
@injectable()
export class NukeAiHelpMenuContribution implements MenuContribution {
    registerMenus(menus: MenuModelRegistry): void {
        menus.unregisterMenuAction(WalkthroughCommands.OPEN_WALKTHROUGH.id, CommonMenus.HELP);
        menus.registerMenuAction(CommonMenus.HELP, {
            commandId: AI_OPEN_GETTING_STARTED_WALKTHROUGH.id,
            label: 'NukeAI Walkthrough...',
            order: 'a20'
        });
    }
}
