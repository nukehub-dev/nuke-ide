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
 * Help-menu ordering for the NukeIDE shell.
 *
 * Theia registers About with order `9`, which puts it above product entries.
 * Move it to the bottom so Help reads Welcome, Documentation, NukeAI
 * Walkthrough, About.
 *
 * @module nuke-essentials/browser/about
 */

import { injectable } from '@theia/core/shared/inversify';
import { CommonCommands } from '@theia/core/lib/browser/common-commands';
import { CommonMenus } from '@theia/core/lib/browser/common-menus';
import { MenuContribution, MenuModelRegistry } from '@theia/core/lib/common/menu';

/** Moves About to the end of the Help menu. */
@injectable()
export class AboutMenuContribution implements MenuContribution {
    registerMenus(menus: MenuModelRegistry): void {
        menus.unregisterMenuAction(CommonCommands.ABOUT_COMMAND, CommonMenus.HELP);
        menus.registerMenuAction(CommonMenus.HELP, {
            commandId: CommonCommands.ABOUT_COMMAND.id,
            label: CommonCommands.ABOUT_COMMAND.label,
            order: 'z9'
        });
    }
}
