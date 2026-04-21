// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
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
