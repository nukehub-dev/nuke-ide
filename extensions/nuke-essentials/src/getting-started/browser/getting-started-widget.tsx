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

import { codicon, CommonCommands, Key, KeyCode, LabelProvider, Message, ReactWidget } from '@theia/core/lib/browser';
import { FrontendApplicationConfigProvider } from '@theia/core/lib/browser/frontend-application-config-provider';
import { WindowService } from '@theia/core/lib/browser/window/window-service';
import { CommandRegistry, environment, isOSX, Path, PreferenceService } from '@theia/core/lib/common';
import { ApplicationInfo, ApplicationServer } from '@theia/core/lib/common/application-protocol';
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import { nls } from '@theia/core/lib/common/nls';
import URI from '@theia/core/lib/common/uri';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import * as React from '@theia/core/shared/react';
import { KeymapsCommands } from '@theia/keymaps/lib/browser';
import { WorkspaceCommands, WorkspaceService } from '@theia/workspace/lib/browser';
import { QuoteService, Quote } from '../../common/quote-protocol';
import { Logo } from '../../theme/browser/components';

/**
 * Default implementation of the `GettingStartedWidget`.
 * The widget is displayed when there are currently no workspaces present.
 * Some of the features displayed include:
 * - `open` commands.
 * - `recently used workspaces`.
 * - `settings` commands.
 * - `help` commands.
 * - helpful links.
 */
@injectable()
export class GettingStartedWidget extends ReactWidget {

    /**
     * The widget `id`.
     */
    static readonly ID = 'getting.started.widget';
    /**
     * The widget `label` which is used for display purposes.
     */
    static readonly LABEL = nls.localizeByDefault('Welcome');

    /**
     * The `ApplicationInfo` for the application if available.
     * Used in order to obtain the version number of the application.
     */
    protected applicationInfo: ApplicationInfo | undefined;
    /**
     * The application name which is used for display purposes.
     */
    protected applicationName = FrontendApplicationConfigProvider.get().applicationName;

    protected home: string | undefined;

    /**
     * The recently used workspaces limit.
     * Used in order to limit the number of recently used workspaces to display.
     */
    protected recentLimit = 5;
    /**
     * The list of recently used workspaces.
     */
    protected recentWorkspaces: string[] = [];

    /**
     * Indicates whether the "ai-core" extension is available.
     */
    protected aiIsIncluded: boolean;

    /**
     * Collection of useful links to display for end users.
     */
    protected readonly documentationUrl = 'https://github.com/nukehub-dev/nuke-ide';
    protected readonly neutronicsWorkshopUrl = 'https://github.com/fusion-energy/neutronics-workshop';

    protected selectedQuote: Quote | undefined;

    @inject(ApplicationServer)
    protected readonly appServer: ApplicationServer;

    @inject(CommandRegistry)
    protected readonly commandRegistry: CommandRegistry;

    @inject(EnvVariablesServer)
    protected readonly environments: EnvVariablesServer;

    @inject(LabelProvider)
    protected readonly labelProvider: LabelProvider;

    @inject(WindowService)
    protected readonly windowService: WindowService;

    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;

    @inject(PreferenceService)
    protected readonly preferenceService: PreferenceService;

    @inject(QuoteService)
    protected readonly quoteService: QuoteService;

    constructor(options?: any) {
        super(options);
        this.scrollOptions = undefined;
    }
    
    @postConstruct()
    protected init(): void {
        this.doInit();
    }

    protected async doInit(): Promise<void> {
        this.id = GettingStartedWidget.ID;
        this.title.label = GettingStartedWidget.LABEL;
        this.title.caption = GettingStartedWidget.LABEL;
        this.title.closable = true;

        this.applicationInfo = await this.appServer.getApplicationInfo();
        this.recentWorkspaces = await this.workspaceService.recentWorkspaces();
        this.home = new URI(await this.environments.getHomeDirUri()).path.toString();

        const extensions = await this.appServer.getExtensionsInfos();
        this.aiIsIncluded = extensions.find(ext => ext.name === '@theia/ai-core') !== undefined;
        
        // Load a random quote from the backend service
        this.selectedQuote = await this.quoteService.getRandomQuote();
        this.update();
    }

    protected override onActivateRequest(msg: Message): void {
        super.onActivateRequest(msg);
        const elArr = this.node.getElementsByTagName('a');
        if (elArr && elArr.length > 0) {
            (elArr[0] as HTMLElement).focus();
        }
    }

    /**
     * Render the content of the widget.
     */
    protected render(): React.ReactNode {
        return <div className='gs-container'>
            <div className='gs-content-container'>
                <div className='gs-left-column'>
                    {this.renderHeader()}
                    <hr className='gs-hr' />
                    {this.renderStart()}
                    {this.renderRecentWorkspaces()}
                    {this.renderSettings()}
                    {this.renderHelp()}
                    {this.renderVersion()}
                </div>
                <div className='gs-right-column'>
                    <div className='gs-right-column-content'>
                        <div className='gs-logo'>
                            <Logo />
                        </div>
                        {this.selectedQuote?.text && (
                            <div className='gs-quote'>
                                <span className='gs-quote-mark gs-quote-mark-open'>"</span>
                                <span className='gs-quote-mark gs-quote-mark-close'>"</span>
                                <p className='gs-quote-text'>{this.selectedQuote!.text}</p>
                                <p className='gs-quote-author'>— {this.selectedQuote!.author}</p>
                                {this.selectedQuote!.category && (
                                    <span className='gs-quote-category'>
                                        {this.selectedQuote!.category}
                                    </span>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </div>
            <div className='gs-preference-container'>
                {this.renderPreferences()}
            </div>
        </div>;
    }

    /**
     * Render the widget header.
     */
    protected renderHeader(): React.ReactNode {
        return <div className='gs-header'>
            <h1>
                <span className='gs-header-title'>
                    {this.applicationName}
                </span>
                <span className='gs-header-subtitle'>
                    {GettingStartedWidget.LABEL}
                </span>
            </h1>
        </div>;
    }

    /**
     * Render the `Start` section.
     * Displays a collection of "start-to-work" related commands like `open` commands and some other.
     */
    protected renderStart(): React.ReactNode {
        const requireSingleOpen = isOSX || !environment.electron.is();

        const createFile = <div className='gs-action-container'>
            <a role={'button'} tabIndex={0} className='gs-link' onClick={this.doCreateFile} onKeyDown={this.doCreateFileEnter}>
                <span className={`${codicon('new-file')} gs-link-icon`} />
                {nls.localizeByDefault('New File...')}
            </a>
        </div>;

        const open = requireSingleOpen && <div className='gs-action-container'>
            <a role={'button'} tabIndex={0} className='gs-link' onClick={this.doOpen} onKeyDown={this.doOpenEnter}>
                <span className={`${codicon('folder-opened')} gs-link-icon`} />
                {nls.localizeByDefault('Open')}
            </a>
        </div>;

        const openFile = !requireSingleOpen && <div className='gs-action-container'>
            <a role={'button'} tabIndex={0} className='gs-link' onClick={this.doOpenFile} onKeyDown={this.doOpenFileEnter}>
                <span className={`${codicon('file')} gs-link-icon`} />
                {nls.localizeByDefault('Open File')}
            </a>
        </div>;

        const openFolder = !requireSingleOpen && <div className='gs-action-container'>
            <a role={'button'} tabIndex={0} className='gs-link' onClick={this.doOpenFolder} onKeyDown={this.doOpenFolderEnter}>
                <span className={`${codicon('folder')} gs-link-icon`} />
                {nls.localizeByDefault('Open Folder')}
            </a>
        </div>;

        const openWorkspace = (
            <div className='gs-action-container'>
                <a role={'button'} tabIndex={0} className='gs-link' onClick={this.doOpenWorkspace} onKeyDown={this.doOpenWorkspaceEnter}>
                    <span className={`${codicon('window')} gs-link-icon`} />
                    {nls.localizeByDefault('Open Workspace')}
                </a>
            </div>
        );

        return <div className='gs-section gs-section-1'>
            <h3 className='gs-section-header'>
                <span className={`${codicon('play-circle')} gs-section-icon`} />
                {nls.localizeByDefault('Start')}
            </h3>
            {createFile}
            {open}
            {openFile}
            {openFolder}
            {openWorkspace}
        </div>;
    }

    /**
     * Render the recently used workspaces section.
     */
    protected renderRecentWorkspaces(): React.ReactNode {
        const items = this.recentWorkspaces;
        const paths = this.buildPaths(items);

        const content = paths.slice(0, this.recentLimit).map((item, index) =>
            <div className='gs-action-container-recent' key={index}>
                <a
                    role={'button'}
                    tabIndex={0}
                    className='gs-link-recent'
                    onClick={() => this.open(new URI(items[index]))}
                    onKeyDown={(e: React.KeyboardEvent) => this.openEnter(e, new URI(items[index]))}>
                    <div className='gs-recent-item'>
                        <span className={`${codicon('folder')} gs-section-icon`} />
                        <span className='gs-recent-name'>
                            {this.labelProvider.getName(new URI(items[index]))}
                        </span>
                    </div>
                    <span className='gs-recent-path'>
                        {item}
                    </span>
                </a>
            </div>
        );

        const more = paths.length > this.recentLimit && <div className='gs-action-container' style={{ marginTop: '8px' }}>
            <a
                role={'button'}
                tabIndex={0}
                className='gs-link-recent'
                onClick={this.doOpenRecentWorkspace}
                onKeyDown={this.doOpenRecentWorkspaceEnter}>
                <span className={`${codicon('more')} gs-link-icon`} />
                {nls.localizeByDefault('More...')}
            </a>
        </div>;

        return <div className='gs-section gs-section-2'>
            <h3 className='gs-section-header'>
                <span className={`${codicon('history')} gs-section-icon`} />
                {nls.localizeByDefault('Recent')}
            </h3>
            {items.length > 0 ? content : <p className='gs-no-recent'>
                {nls.localizeByDefault('You have no recent folders,') + ' '}
                <a
                    role={'button'}
                    tabIndex={0}
                    className='gs-no-recent-link'
                    onClick={this.doOpenFolder}
                    onKeyDown={this.doOpenFolderEnter}>
                    {nls.localizeByDefault('open a folder')}
                </a>
                {' ' + nls.localizeByDefault('to start.')}
            </p>}
            {more}
        </div>;
    }

    /**
     * Render the settings section.
     * Generally used to display useful links.
     */
    protected renderSettings(): React.ReactNode {
        return <div className='gs-section gs-section-3'>
            <h3 className='gs-section-header'>
                <span className={`${codicon('settings-gear')} gs-section-icon`} />
                {nls.localizeByDefault('Settings')}
            </h3>
            <div className='gs-action-container'>
                <a role={'button'} tabIndex={0} className='gs-link' onClick={this.doOpenPreferences} onKeyDown={this.doOpenPreferencesEnter}>
                    <span className={`${codicon('settings')} gs-link-icon`} />
                    {nls.localizeByDefault('Open Settings')}
                </a>
            </div>
            <div className='gs-action-container'>
                <a role={'button'} tabIndex={0} className='gs-link' onClick={this.doOpenKeyboardShortcuts} onKeyDown={this.doOpenKeyboardShortcutsEnter}>
                    <span className={`${codicon('keyboard')} gs-link-icon`} />
                    {nls.localizeByDefault('Open Keyboard Shortcuts')}
                </a>
            </div>
        </div>;
    }

    /**
     * Render the help section.
     */
    protected renderHelp(): React.ReactNode {
        return <div className='gs-section gs-section-4'>
            <h3 className='gs-section-header'>
                <span className={`${codicon('question')} gs-section-icon`} />
                {nls.localizeByDefault('Help')}
            </h3>
            <div className='gs-action-container'>
                <a role={'button'} tabIndex={0} className='gs-link' onClick={() => this.doOpenExternalLink(this.documentationUrl)} onKeyDown={(e: React.KeyboardEvent) => this.doOpenExternalLinkEnter(e, this.documentationUrl)}>
                    <span className={`${codicon('book')} gs-link-icon`} />
                    {nls.localizeByDefault('NukeIDE Documentation')}
                </a>
            </div>
            <div className='gs-action-container'>
                <a role={'button'} tabIndex={0} className='gs-link' onClick={() => this.doOpenExternalLink(this.neutronicsWorkshopUrl)} onKeyDown={(e: React.KeyboardEvent) => this.doOpenExternalLinkEnter(e, this.neutronicsWorkshopUrl)}>
                    <span className={`${codicon('code')} gs-link-icon`} />
                    {nls.localizeByDefault('Nuclear Simulation Workshop')}
                </a>
            </div>
        </div>;
    }

    /**
     * Render the version section.
     */
    protected renderVersion(): React.ReactNode {
        return <div className='gs-section gs-section-5'>
            <div className='gs-version'>
                <span className={`${codicon('versions')} gs-version-icon`} />
                <p className='gs-version-text'>
                    {this.applicationInfo ? nls.localizeByDefault('Version: {0}', this.applicationInfo.version) : ''}
                </p>
            </div>
        </div>;
    }

    protected renderPreferences(): React.ReactNode {
        return <WelcomePreferences preferenceService={this.preferenceService}></WelcomePreferences>;
    }

    /**
     * Build the list of workspace paths.
     * @param workspaces {string[]} the list of workspaces.
     * @returns {string[]} the list of workspace paths.
     */
    protected buildPaths(workspaces: string[]): string[] {
        const paths: string[] = [];
        workspaces.forEach(workspace => {
            const uri = new URI(workspace);
            const pathLabel = this.labelProvider.getLongName(uri);
            const path = this.home ? Path.tildify(pathLabel, this.home) : pathLabel;
            paths.push(path);
        });
        return paths;
    }

    /**
     * Trigger the create file command.
     */
    protected doCreateFile = () => this.commandRegistry.executeCommand(CommonCommands.PICK_NEW_FILE.id);
    protected doCreateFileEnter = (e: React.KeyboardEvent) => {
        if (this.isEnterKey(e)) {
            this.doCreateFile();
        }
    };

    /**
     * Trigger the open command.
     */
    protected doOpen = () => this.commandRegistry.executeCommand(WorkspaceCommands.OPEN.id);
    protected doOpenEnter = (e: React.KeyboardEvent) => {
        if (this.isEnterKey(e)) {
            this.doOpen();
        }
    };

    /**
     * Trigger the open file command.
     */
    protected doOpenFile = () => this.commandRegistry.executeCommand(WorkspaceCommands.OPEN_FILE.id);
    protected doOpenFileEnter = (e: React.KeyboardEvent) => {
        if (this.isEnterKey(e)) {
            this.doOpenFile();
        }
    };

    /**
     * Trigger the open folder command.
     */
    protected doOpenFolder = () => this.commandRegistry.executeCommand(WorkspaceCommands.OPEN_FOLDER.id);
    protected doOpenFolderEnter = (e: React.KeyboardEvent) => {
        if (this.isEnterKey(e)) {
            this.doOpenFolder();
        }
    };

    /**
     * Trigger the open workspace command.
     */
    protected doOpenWorkspace = () => this.commandRegistry.executeCommand(WorkspaceCommands.OPEN_WORKSPACE.id);
    protected doOpenWorkspaceEnter = (e: React.KeyboardEvent) => {
        if (this.isEnterKey(e)) {
            this.doOpenWorkspace();
        }
    };

    /**
     * Trigger the open recent workspace command.
     */
    protected doOpenRecentWorkspace = () => this.commandRegistry.executeCommand(WorkspaceCommands.OPEN_RECENT_WORKSPACE.id);
    protected doOpenRecentWorkspaceEnter = (e: React.KeyboardEvent) => {
        if (this.isEnterKey(e)) {
            this.doOpenRecentWorkspace();
        }
    };

    /**
     * Trigger the open preferences command.
     * Used to open the preferences widget.
     */
    protected doOpenPreferences = () => this.commandRegistry.executeCommand(CommonCommands.OPEN_PREFERENCES.id);
    protected doOpenPreferencesEnter = (e: React.KeyboardEvent) => {
        if (this.isEnterKey(e)) {
            this.doOpenPreferences();
        }
    };

    /**
     * Trigger the open keyboard shortcuts command.
     * Used to open the keyboard shortcuts widget.
     */
    protected doOpenKeyboardShortcuts = () => this.commandRegistry.executeCommand(KeymapsCommands.OPEN_KEYMAPS.id);
    protected doOpenKeyboardShortcutsEnter = (e: React.KeyboardEvent) => {
        if (this.isEnterKey(e)) {
            this.doOpenKeyboardShortcuts();
        }
    };

    /**
     * Open a workspace given its uri.
     * @param uri {URI} the workspace uri.
     */
    protected open = (uri: URI) => this.workspaceService.open(uri);
    protected openEnter = (e: React.KeyboardEvent, uri: URI) => {
        if (this.isEnterKey(e)) {
            this.open(uri);
        }
    };

    /**
     * Open a link in an external window.
     * @param url the link.
     */
    protected doOpenExternalLink = (url: string) => this.windowService.openNewWindow(url, { external: true });
    protected doOpenExternalLinkEnter = (e: React.KeyboardEvent, url: string) => {
        if (this.isEnterKey(e)) {
            this.doOpenExternalLink(url);
        }
    };

    protected isEnterKey(e: React.KeyboardEvent): boolean {
        return Key.ENTER.keyCode === KeyCode.createKeyCode(e.nativeEvent).key?.keyCode;
    }
}

export interface PreferencesProps {
    preferenceService: PreferenceService;
}

function WelcomePreferences(props: PreferencesProps): JSX.Element {
    const [startupEditor, setStartupEditor] = React.useState<string>('welcomePage');
    const [isReady, setIsReady] = React.useState(false);

    React.useEffect(() => {
        // Wait for preferences to be ready before reading the value
        props.preferenceService.ready.then(() => {
            const currentValue = props.preferenceService.get('workbench.startupEditor', 'welcomePage');
            setStartupEditor(currentValue);
            setIsReady(true);
        });

        const prefListener = props.preferenceService.onPreferenceChanged((change: any) => {
            if (change.preferenceName === 'workbench.startupEditor') {
                setStartupEditor(change.newValue);
            }
        });
        return () => prefListener.dispose();
    }, [props.preferenceService]);

    const isEnabled = startupEditor === 'welcomePage' || startupEditor === 'welcomePageInEmptyWorkbench';

    const handleToggle = () => {
        const newValue = isEnabled ? 'none' : 'welcomePage';
        // Update local state immediately for responsive UI
        setStartupEditor(newValue);
        // Use updateValue which properly persists to storage
        props.preferenceService.updateValue('workbench.startupEditor', newValue).catch((err: Error) => {
            console.error('[WelcomePreferences] Failed to update preference:', err);
        });
    };

    if (!isReady) {
        return (
            <div className='gs-preference' style={{ opacity: 0.5 }}>
                <div className='gs-toggle gs-toggle-off' />
                <span className='gs-preference-label'>
                    {nls.localizeByDefault('Show NukeIDE welcome page on startup')}
                </span>
            </div>
        );
    }

    return (
        <div className='gs-preference'>
            <div
                role="switch"
                aria-checked={isEnabled}
                onClick={handleToggle}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleToggle();
                    }
                }}
                tabIndex={0}
                className={`gs-toggle ${isEnabled ? 'gs-toggle-on' : 'gs-toggle-off'}`}
            >
                <div className={`gs-toggle-thumb ${isEnabled ? 'gs-toggle-thumb-on' : 'gs-toggle-thumb-off'}`} />
            </div>
            <span className='gs-preference-label' onClick={handleToggle}>
                {nls.localizeByDefault('Show NukeIDE welcome page on startup')}
            </span>
        </div>
    );
}
