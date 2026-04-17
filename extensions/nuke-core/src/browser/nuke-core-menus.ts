// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

import { injectable } from '@theia/core/shared/inversify';
import { MenuContribution, MenuModelRegistry, MAIN_MENU_BAR } from '@theia/core/lib/common';

/**
 * Common menu paths and labels for Nuke IDE
 */
export namespace NukeMenus {
    /** Top-level Tools menu */
    export const TOOLS = [...MAIN_MENU_BAR, '7_tools'];
}

@injectable()
export class NukeCoreMenuContribution implements MenuContribution {
    registerMenus(menus: MenuModelRegistry): void {
        // Authoritative registration of the Tools menu
        menus.registerSubmenu(NukeMenus.TOOLS, 'Tools');
    }
}
