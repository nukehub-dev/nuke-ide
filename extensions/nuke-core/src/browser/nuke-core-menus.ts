// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
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

import { injectable } from '@theia/core/shared/inversify';
import { MenuContribution, MenuModelRegistry, MAIN_MENU_BAR } from '@theia/core/lib/common';

/**
 * Common menu paths and labels for Nuke IDE.
 *
 * @see {@link NukeCoreMenuContribution}
 */
export namespace NukeMenus {
    /** Top-level Tools menu path within the main menu bar. */
    export const TOOLS = [...MAIN_MENU_BAR, '7_tools'];
}

/**
 * Contribution that registers the authoritative "Tools" top-level menu in the Nuke IDE menu bar.
 *
 * Bound as a singleton via Inversify and contributed to {@link @theia/core/lib/common#MenuContribution}.
 *
 * @see {@link NukeMenus}
 */
@injectable()
export class NukeCoreMenuContribution implements MenuContribution {

    /**
     * Registers the Nuke Tools submenu in the application's menu model registry.
     *
     * @param menus - The Theia {@link @theia/core/lib/common#MenuModelRegistry} to register menus into.
     * @returns void
     */
    registerMenus(menus: MenuModelRegistry): void {
        // Authoritative registration of the Tools menu
        menus.registerSubmenu(NukeMenus.TOOLS, 'Tools');
    }
}
