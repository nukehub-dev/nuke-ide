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

import { CommandService, nls } from '@theia/core';
import { AboutDialog, AboutDialogProps, ABOUT_CONTENT_CLASS } from '@theia/core/lib/browser/about-dialog';
import { FrontendApplicationConfigProvider } from '@theia/core/lib/browser/frontend-application-config-provider';
import { WindowService } from '@theia/core/lib/browser/window/window-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import * as React from '@theia/core/shared/react';
import { VSCODE_DEFAULT_API_VERSION } from '@theia/plugin-ext-vscode/lib/common/plugin-vscode-types';
import { codicon } from '@theia/core/lib/browser';

@injectable()
export class NukeAboutDialog extends AboutDialog {
    @inject(CommandService)
    protected readonly commandService: CommandService;
    @inject(WindowService)
    protected readonly windowService: WindowService;

    constructor(
        @inject(AboutDialogProps)
        protected readonly props: AboutDialogProps
    ) {
        super(props);

        this.titleNode.textContent = nls.localize('nuke-ide/about/title', 'About NukeIDE');

        this.acceptButton = this.createButton('OK');
        this.controlPanel.appendChild(this.acceptButton);
        this.acceptButton.classList.add('main');
    }

    protected appendAcceptButton(text: string): HTMLButtonElement {
        // prevent append of parent's button
        return this.createButton(text);
    }

    protected openUrl = (url: string) => this.windowService.openNewWindow(url, { external: true });

    protected render(): React.ReactNode {
        return <div className={ABOUT_CONTENT_CLASS}>
            {this.renderContent()}
        </div>;
    }

    protected renderContent(): React.ReactNode {
        return <div className={`${ABOUT_CONTENT_CLASS} about-content`}>
            {this.renderHeader()}
            {this.renderInfoCards()}
            {this.renderVersions()}
        </div>;
    }

    protected renderHeader(): React.ReactNode {
        const applicationInfo = this.applicationInfo;
        const applicationName = FrontendApplicationConfigProvider.get().applicationName;

        return (
            <div className="about-header">
                <div className="about-logo">
                </div>

                <div className="about-title-section">
                    <div className="about-title">{applicationName}</div>
                    <div className="about-version">v{applicationInfo?.version || '0.0.0'}</div>
                </div>
            </div>
        );
    }

    protected renderInfoCards(): React.ReactNode {
        const links = [
            { icon: 'globe', label: 'Website', url: 'https://nukehub.org' },
            { icon: 'github', label: 'GitHub', url: 'https://github.com/nukehub-dev' },
            { icon: 'comment-discussion', label: 'Community', url: 'https://talk.nukehub.org' },
        ];

        return (
            <div className="about-links-section">
                <div className="about-section-label">Links</div>
                <div className="about-links-container">
                    {links.map((link, index) => (
                        <button
                            key={index}
                            onClick={() => this.openUrl(link.url)}
                            className="about-link-button"
                        >
                            <span className={codicon(link.icon)} />
                            {link.label}
                        </button>
                    ))}
                </div>

                <div className="about-license-card">
                    <span className={codicon('law')} />
                    <div>
                        <div className="about-license-text">BSD-2-Clause License</div>
                        <div className="about-copyright">© 2023-2026 NukeHub</div>
                    </div>
                </div>
            </div>
        );
    }

    protected renderVersions(): React.ReactNode {
        return (
            <div className="about-version-card">
                <div className="about-version-label">
                    <span className={codicon('versions')} />
                    VSCode API Version
                </div>
                <div className="about-version-value">{VSCODE_DEFAULT_API_VERSION}</div>
            </div>
        );
    }
}
