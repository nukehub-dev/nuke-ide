// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0.
//
// This Source Code may also be made available under the following Secondary
// Licenses when the conditions for such availability set forth in the Eclipse
// Public License v. 2.0 are satisfied: GNU General Public License, version 2
// with the GNU Classpath Exception which is available at
// https://www.gnu.org/software/classpath/license.html.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

import { injectable } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution, FrontendApplication } from '@theia/core/lib/browser';
import { LogoSvgInner } from '../../theme/browser/components';

@injectable()
export class EmptyMainPanelContribution implements FrontendApplicationContribution {
    private containerElement: HTMLElement | null = null;

    onStart(app: FrontendApplication): void {
        // Wait for DOM to be ready
        setTimeout(() => {
            const mainPanel = document.getElementById('theia-main-content-panel');
            if (!mainPanel) return;

            // Create the empty state container
            // CSS container queries handle the show/hide logic automatically
            this.createEmptyStateElement(mainPanel);
        }, 500);
    }

    protected createEmptyStateElement(mainPanel: HTMLElement): void {
        const isMac = navigator.platform.indexOf('Mac') !== -1;
        const ctrlKey = isMac ? '⌘' : 'Ctrl';

        this.containerElement = document.createElement('div');
        this.containerElement.className = 'nukeide-empty-state';

        // Helper to create key badge HTML - badges on individual keys only
        const createKeyCombo = (keys: string[]) => {
            return keys.map(k => `<span class="key-badge">${k}</span>`).join('<span class="key-separator">+</span>');
        };

        this.containerElement.innerHTML = `
            <svg width="256" height="256" viewBox="0 0 256 256">
                ${LogoSvgInner}
            </svg>
            <div class="empty-state-shortcuts">
                <div class="shortcut-row">
                    <span>Open Chat</span>
                    <span class="shortcut-keys">${createKeyCombo([ctrlKey, 'Alt', 'I'])}</span>
                </div>
                <div class="shortcut-row">
                    <span>Open Folder</span>
                    <span class="shortcut-keys">${createKeyCombo([ctrlKey, 'Alt', 'O'])}</span>
                </div>
                <div class="shortcut-row">
                    <span>More Shortcuts</span>
                    <span class="shortcut-keys">${createKeyCombo([ctrlKey, 'Alt', ','])}</span>
                </div>
            </div>
        `;

        mainPanel.appendChild(this.containerElement);
    }
}
