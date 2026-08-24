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

/**
 * Nuke CAD tools contribution.
 *
 * Registers nuke-cad commands in the Nuke Tools sidebar.
 *
 * @module nuke-cad/browser/contributions
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { NukeToolsContribution, NukeToolsRegistry } from 'nuke-core/lib/common/nuke-tools-protocol';
import { NukeCadCommands } from '../commands';
import { NukeCadStateManager } from '../state/nuke-cad-state-manager';

@injectable()
export class NukeCadToolsContribution implements NukeToolsContribution {
    @inject(NukeCadStateManager)
    protected readonly stateManager: NukeCadStateManager;

    registerTools(registry: NukeToolsRegistry): void {
        const modelEnabled = () => this.stateManager.scriptPath !== undefined;

        registry.registerItem({
            id: 'nuke.cad.openViewport',
            label: 'CAD Viewport',
            commandId: NukeCadCommands.OPEN_CAD_VIEWPORT.id,
            category: ['CAD Studio', 'Geometry'],
            sectionOrder: 'b',
            categoryOrder: 'a',
            order: 'a',
            icon: 'nuke-cad-cube',
            description: 'Open the CAD viewport for the active model.'
        });

        registry.registerItem({
            id: 'nuke.cad.openOutlinePanel',
            label: 'Model Outline',
            commandId: NukeCadCommands.OPEN_OUTLINE_PANEL.id,
            category: ['CAD Studio', 'Geometry'],
            sectionOrder: 'b',
            categoryOrder: 'a',
            order: 'a1',
            icon: 'nuke-cad-outline',
            description: 'Open the model outline and region manifest panel.'
        });

        registry.registerItem({
            id: 'nuke.cad.openFeatureTree',
            label: 'Feature Tree',
            commandId: NukeCadCommands.OPEN_FEATURE_TREE.id,
            category: ['CAD Studio', 'Geometry'],
            sectionOrder: 'b',
            categoryOrder: 'a',
            order: 'a2',
            icon: 'nuke-cad-feature-tree',
            description: 'Open the parametric feature tree for .nuke-cad documents.'
        });

        registry.registerItem({
            id: 'nuke.cad.newDocument',
            label: 'New CAD Document',
            commandId: NukeCadCommands.NEW_DOCUMENT.id,
            category: ['CAD Studio', 'Geometry'],
            sectionOrder: 'b',
            categoryOrder: 'a',
            order: 'a3',
            icon: 'new-file',
            description: 'Create a new .nuke-cad document.'
        });

        registry.registerItem({
            id: 'nuke.cad.rebuild',
            label: 'Rebuild Geometry',
            commandId: NukeCadCommands.REBUILD_GEOMETRY.id,
            category: ['CAD Studio', 'Geometry'],
            sectionOrder: 'b',
            categoryOrder: 'a',
            order: 'b',
            icon: 'refresh',
            description: 'Rebuild the active CAD model from its script.',
            enabled: modelEnabled,
            onDidChangeEnabled: this.stateManager.onModelChange
        });

        registry.registerItem({
            id: 'nuke.cad.checkEnvironment',
            label: 'Check CAD Environment',
            commandId: NukeCadCommands.CHECK_CAD_ENVIRONMENT.id,
            category: ['CAD Studio', 'Environment'],
            sectionOrder: 'b',
            categoryOrder: 'b',
            order: 'a',
            icon: 'pass',
            description: 'Verify that the active Python environment has the CAD toolchain.'
        });

        registry.registerItem({
            id: 'nuke.cad.openFemPanel',
            label: 'FEM Analysis',
            commandId: NukeCadCommands.OPEN_FEM_PANEL.id,
            category: ['CAD Studio', 'FEM'],
            sectionOrder: 'b',
            categoryOrder: 'c',
            order: 'a',
            icon: 'dashboard',
            description: 'Open the CalculiX FEM analysis panel for the active mesh.'
        });

        registry.registerItem({
            id: 'nuke.cad.openFoamPanel',
            label: 'OpenFOAM Case',
            commandId: NukeCadCommands.OPEN_FOAM_PANEL.id,
            category: ['CAD Studio', 'CFD'],
            sectionOrder: 'b',
            categoryOrder: 'd',
            order: 'a',
            icon: 'server-process',
            description: 'Scaffold an OpenFOAM case from the active CAD model.'
        });
    }
}
