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
            return keys.map((k) => `<span class="key-badge">${k}</span>`).join('<span class="key-separator">+</span>');
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
