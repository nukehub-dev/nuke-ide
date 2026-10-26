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
import { MenuModelRegistry, MenuContribution } from '@theia/core/lib/common';
import { NukeCadMenus } from './nuke-cad-menus';
import { NukeCadCommands } from '../commands';

/**
 * Registers the CAD Studio menu hierarchy under Tools, mirroring the Nuke
 * Tools sidebar entries (`NukeCadToolsContribution`) so the main menu and
 * the sidebar offer the same commands.
 */
@injectable()
export class NukeCadMenuContribution implements MenuContribution {
    registerMenus(menus: MenuModelRegistry): void {
        menus.registerSubmenu(NukeCadMenus.CAD, 'CAD Studio');
        menus.registerSubmenu(NukeCadMenus.CAD_GEOMETRY, 'Geometry');
        menus.registerSubmenu(NukeCadMenus.CAD_PANELS, 'Panels');
        menus.registerSubmenu(NukeCadMenus.CAD_ANALYSIS, 'Analysis');
        menus.registerSubmenu(NukeCadMenus.CAD_ENVIRONMENT, 'Environment');

        menus.registerMenuAction(NukeCadMenus.CAD_GEOMETRY, {
            commandId: NukeCadCommands.NEW_DOCUMENT.id,
            label: 'New CAD Document',
            order: 'a'
        });
        menus.registerMenuAction(NukeCadMenus.CAD_GEOMETRY, {
            commandId: NukeCadCommands.OPEN_CAD_VIEWPORT.id,
            label: 'Open CAD Viewport',
            order: 'b'
        });
        menus.registerMenuAction(NukeCadMenus.CAD_GEOMETRY, {
            commandId: NukeCadCommands.REBUILD_GEOMETRY.id,
            label: 'Rebuild Geometry',
            order: 'c'
        });
        menus.registerMenuAction(NukeCadMenus.CAD_GEOMETRY, {
            commandId: NukeCadCommands.IMPORT_CAD_BODY.id,
            label: 'Import CAD as Body…',
            order: 'd'
        });
        menus.registerMenuAction(NukeCadMenus.CAD_GEOMETRY, {
            commandId: NukeCadCommands.REFRESH_IMPORT_SOURCES.id,
            label: 'Refresh Import Sources',
            order: 'e'
        });
        menus.registerMenuAction(NukeCadMenus.CAD_GEOMETRY, {
            commandId: NukeCadCommands.CREATE_W7X_GENERATOR.id,
            label: 'Create W7-X Generator…',
            order: 'f'
        });
        menus.registerMenuAction(NukeCadMenus.CAD_GEOMETRY, {
            commandId: NukeCadCommands.CREATE_W7X_COIL_STUDY.id,
            label: 'Create W7-X Coil Study…',
            order: 'g'
        });
        menus.registerMenuAction(NukeCadMenus.CAD_GEOMETRY, {
            commandId: NukeCadCommands.CREATE_W7X_SHAPE_STUDY.id,
            label: 'Create W7-X Coil Shape Study…',
            order: 'h'
        });

        menus.registerMenuAction(NukeCadMenus.CAD_PANELS, {
            commandId: NukeCadCommands.OPEN_OUTLINE_PANEL.id,
            label: 'Model Outline',
            order: 'a'
        });
        menus.registerMenuAction(NukeCadMenus.CAD_PANELS, {
            commandId: NukeCadCommands.OPEN_FEATURE_TREE.id,
            label: 'Feature Tree',
            order: 'b'
        });
        menus.registerMenuAction(NukeCadMenus.CAD_PANELS, {
            commandId: NukeCadCommands.OPEN_BOM_PANEL.id,
            label: 'BOM',
            order: 'c'
        });
        menus.registerMenuAction(NukeCadMenus.CAD_PANELS, {
            commandId: NukeCadCommands.OPEN_DRAWING_SHEET.id,
            label: 'Drawing Sheet',
            order: 'd'
        });
        menus.registerMenuAction(NukeCadMenus.CAD_PANELS, {
            commandId: NukeCadCommands.EXPORT_PYTHON.id,
            label: 'Export CAD Document as Python',
            order: 'e'
        });

        menus.registerMenuAction(NukeCadMenus.CAD_ANALYSIS, {
            commandId: NukeCadCommands.OPEN_FEM_PANEL.id,
            label: 'FEM Analysis',
            order: 'a'
        });
        menus.registerMenuAction(NukeCadMenus.CAD_ANALYSIS, {
            commandId: NukeCadCommands.OPEN_FOAM_PANEL.id,
            label: 'OpenFOAM Case',
            order: 'b'
        });

        menus.registerMenuAction(NukeCadMenus.CAD_ENVIRONMENT, {
            commandId: NukeCadCommands.CHECK_CAD_ENVIRONMENT.id,
            label: 'Check CAD Environment',
            order: 'a'
        });
    }
}
