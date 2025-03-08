import { CommandService, nls } from '@theia/core';
import { AboutDialog, AboutDialogProps, ABOUT_CONTENT_CLASS } from '@theia/core/lib/browser/about-dialog';
import { FrontendApplicationConfigProvider } from '@theia/core/lib/browser/frontend-application-config-provider';
import { WindowService } from '@theia/core/lib/browser/window/window-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import * as React from '@theia/core/shared/react';
import { VSCODE_DEFAULT_API_VERSION } from '@theia/plugin-ext-vscode/lib/common/plugin-vscode-types';

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
        return <div className={ABOUT_CONTENT_CLASS}>
            {this.renderHeader()}
            <hr className="about-hr" />
            {this.renderVersions()}
        </div>;
    }

    protected renderHeader(): React.ReactNode {
        const applicationInfo = this.applicationInfo;
        const applicationName = FrontendApplicationConfigProvider.get().applicationName;

        return <div className="about-paragraph about-flex-grid">
            <div className="about-flex-grid-column">
                <div className="about-logo"></div>
            </div>
            <div className="about-flex-grid-column">
                <h1>
                    {applicationName}
                    <span className="about-sub-header">
                        {applicationInfo && ` ${applicationInfo.version}`}
                    </span>
                </h1>
                {this.renderCopyright()}
            </div>
        </div>;
    }

    protected renderCopyright(): React.ReactNode {
        return <>
            <div className="about-paragraph">
                © 2023-2025 <a href={'mailto:info@nukehub.org'}>
                    NukeHub
                </a>
            </div>
            <div className="about-paragraph">
                <div>
                    <i className="fa fa-link" /> <a href="#" onClick={() => this.openUrl('https://nukehub.org')}>
                        {'https://nukehub.org'}
                    </a>
                </div>
                <div>
                    <i className="fa fa-github" /> <a href="#" onClick={() => this.openUrl('https://github.com/nukehub-dev')}>
                        {'https://github.com/nukehub-dev'}
                    </a>
                </div>
                <div>
                    <i className="fa fa-comments" /> <a href="#" onClick={() => this.openUrl('https://talk.nukehub.org')}>
                        {'https://talk.nukehub.org'}
                    </a>
                </div>
            </div>
            <div className="about-paragraph">
                <div>
                    <i className="fa fa-copyright" /> <span>License: BSD-2-Clause</span>
                </div>
            </div>
        </>;
    }
    

    protected renderVersions(): React.ReactNode {
        return <div className="about-paragraph">
            <div>{nls.localize('nuke-ide/about/vsCodeApiVersion', 'VSCode API Version')}: {VSCODE_DEFAULT_API_VERSION}</div>
        </div>;
    }
}
