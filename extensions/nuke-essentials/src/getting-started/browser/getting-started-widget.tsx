// *****************************************************************************
// Copyright (C) 2018 Ericsson and others.
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

import { codicon, CommonCommands, Key, KeyCode, LabelProvider, Message, PreferenceService, ReactWidget } from '@theia/core/lib/browser';
import { FrontendApplicationConfigProvider } from '@theia/core/lib/browser/frontend-application-config-provider';
import { WindowService } from '@theia/core/lib/browser/window/window-service';
import { CommandRegistry, environment, isOSX, Path } from '@theia/core/lib/common';
import { ApplicationInfo, ApplicationServer } from '@theia/core/lib/common/application-protocol';
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import { nls } from '@theia/core/lib/common/nls';
import URI from '@theia/core/lib/common/uri';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import * as React from '@theia/core/shared/react';
import { KeymapsCommands } from '@theia/keymaps/lib/browser';
import { WorkspaceCommands, WorkspaceService } from '@theia/workspace/lib/browser';

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

    protected readonly quotes = [
        {
            text: "The unleashed power of the atom has changed everything save our modes of thinking and we thus drift toward unparalleled catastrophe.",
            author: "Albert Einstein"
        },
        {
            text: "The history of science shows that theories are perishable. With every new truth that is revealed we get a better understanding of Nature and our conceptions and views are modified.",
            author: "Nikola Tesla"
        },
        {
            text: "Nothing in life is to be feared, it is only to be understood. Now is the time to understand more, so that we may fear less.",
            author: "Marie Curie"
        }
    ];

    protected selectedQuote: { text: string, author: string };

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
        this.selectedQuote = this.quotes[Math.floor(Math.random() * this.quotes.length)];
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
                        <svg
                            version="1.1"
                            viewBox="0 0 256 256"
                            id="svg18"
                        >
                            <g
                                transform="matrix(0.7,0,0,0.7,38.4,38.4)"
                                id="g16"
                            >
                                <g
                                    fillRule="nonzero"
                                    stroke="none"
                                    strokeWidth="1"
                                    strokeLinecap="butt"
                                    strokeLinejoin="miter"
                                    strokeMiterlimit="10"
                                    strokeDasharray=""
                                    strokeDashoffset="0"
                                    fontFamily="none"
                                    fontWeight="none"
                                    fontSize="none"
                                    textAnchor="none"
                                    id="g14"
                                >
                                    <g
                                        transform="matrix(0.25,0,0,0.25,-0.16216,-0.29601)"
                                        id="g12"
                                    >
                                        <g
                                            transform="matrix(3.13459,0,0,3.16815,-1119.1055,-1093.7635)"
                                            id="g10485"
                                        >
                                            <path
                                                d="m 385.12,463.48 c -4.44,13.5 -25.32,10.98 -24.58,-4.84 0.29333,-6.28667 1.87,-13.10333 4.73,-20.45 16.22,-41.66 43.4,-67.32 82.87,-86.81 6.57,-3.23 16,-4.4 21.9,0.25 5.87,4.63 5.15,14.67 0.11,19.81 -1.34,1.36667 -3.99667,2.91667 -7.97,4.65 -31.59,13.76 -60.02,40.66 -72.02,72.97 -1.76667,4.77333 -3.44667,9.58 -5.04,14.42 z"
                                                id="path8881"
                                            />
                                            <path
                                                d="m 580.69,375.81 c -8.55,-5.25 -6.46,-18.71 1.13,-23.07 6.21,-3.57 12.23,-1.85 18.21,1.5 36.82,20.65 69.97,55.47 81.05,96.48 1.62,5.99 0.63,13.94 -4.29,18.16 -6.47,5.53 -16.75,4.78 -20.87,-3.61 -0.83333,-1.69333 -2.21667,-5.51 -4.15,-11.45 -9.63,-29.5 -29.11,-51.99 -55.74,-68.53 -5.10667,-3.16667 -10.22,-6.32667 -15.34,-9.48 z"
                                                id="path8883"
                                            />
                                            <path
                                                d="m 451.17,494.48 c -14.33,-0.17 -28.77,-0.93 -43.06,-0.06 -0.32667,0.02 -0.47667,-0.13333 -0.45,-0.46 1.7,-19.31 7.65,-39.22 19.23,-54.92 12.16,-16.48 28.66,-31.06 47.76,-38.88 10.7,-4.38667 21.79667,-7.53 33.29,-9.43 0.34,-0.0533 0.50667,0.09 0.5,0.43 l -0.29,44.63 c -0.005,0.35847 -0.29165,0.64934 -0.65,0.66 -2.34,0.0933 -4.6,0.49667 -6.78,1.21 -26.17,8.65 -44.06,28.88 -48.96,56.32 -0.06,0.33333 -0.25667,0.5 -0.59,0.5 z"
                                                id="path8885"
                                            />
                                            <path
                                                d="m 532.87,436.7 c -0.24916,-0.0528 -0.42553,-0.27537 -0.42,-0.53 l 0.17,-44.11 c 0.007,-0.32 0.17,-0.46667 0.49,-0.44 25.88667,2.45333 47.95,12.80333 66.19,31.05 7.21333,7.22 13.57667,15.11 19.09,23.67 9.72,15.09 12.84,30.4 14.66,48.33 0.04,0.36667 -0.12333,0.53667 -0.49,0.51 -15.1,-1.06 -30.21,-1.27 -45.33,-0.63 -0.35333,0.0133 -0.56,-0.15333 -0.62,-0.5 -1.97,-11.27 -5.31,-22.23 -12.18,-31.28 -10.14667,-13.35333 -24,-22.04333 -41.56,-26.07 z"
                                                id="path8887"
                                            />
                                            <path
                                                d="m 486.45,544.05 c -29.77,-27.76 -18.47,-74.32 19.6,-86.26 15.79,-4.95 34.04,-0.2 46.42,10.55 19.84,17.25 21.61,44.46 7.24,66.3 -16.4,24.94 -51.06,30.11 -73.26,9.41 z m 39.37,-44.52 c 0,-9.72021 -7.87979,-17.6 -17.6,-17.6 -9.72021,0 -17.6,7.87979 -17.6,17.6 0,9.72021 7.87979,17.6 17.6,17.6 9.72021,0 17.6,-7.87979 17.6,-17.6 z"
                                                id="path8889"
                                            />
                                            <path
                                                d="m 633.48,518.74 c 0.10004,0.005 0.19375,0.0505 0.25971,0.12588 0.066,0.0754 0.0985,0.17429 0.0903,0.27412 -4.98,56.3 -45.11,97.31 -100.96,104.1 -0.18667,0.02 -0.28,-0.0667 -0.28,-0.26 l -0.12,-45.12 c -4.4e-4,-0.32148 0.21815,-0.60193 0.53,-0.68 28.34,-7.07 48.76,-28.83 52.71,-57.94 0.0342,-0.27655 0.26678,-0.48801 0.55,-0.5 15.74,-0.71333 31.48,-0.71333 47.22,0 z"
                                                id="path8893"
                                            />
                                            <path
                                                d="m 486.73,617.78 c -43.89,-14.64 -74.82,-51.87 -78.6,-98.46 -0.0267,-0.32 0.12,-0.48333 0.44,-0.49 12.47333,-0.25333 24.95,-0.36667 37.43,-0.34 1.77333,0 3.53667,0.11667 5.29,0.35 0.32667,0.0467 0.50333,0.23 0.53,0.55 2.95,28.92 29.37,51.88 56,58.18 0.25333,0.06 0.38333,0.22333 0.39,0.49 l 0.33,44.69 c 0,0.30667 -0.15,0.42667 -0.45,0.36 -9.55333,-1.99333 -16.67333,-3.77 -21.36,-5.33 z"
                                                id="path8895"
                                            />
                                            <path
                                                d="m 443.36,660.71 c -35.69,-19.39 -67.56,-50.9 -81.31,-89.23 -1.72,-4.8 -3.6,-10.45 -2.27,-15.38 1.65333,-6.11333 5.62333,-9.5 11.91,-10.16 7.83,-0.82 12,3.87 14.26,10.85 2.92667,9.04 7.81333,18.68 14.66,28.92 16.87,25.23 38.11,40.65 64.92,54.16 15.45,7.78 8.04,27.95 -7.79,25.88 -4.48667,-0.59333 -9.28,-2.27333 -14.38,-5.04 z"
                                                id="path8897"
                                            />
                                            <path
                                                d="m 587.87,665.74 c -5.5,-0.8 -11.2,-4.91 -12.2,-10.7 -1.66,-9.57 2.87,-13.24 10.96,-17.83 30.8,-17.47 56.29,-41.82 66.53,-76.66 1.46667,-4.97333 2.73,-8.14 3.79,-9.5 3.35,-4.27 8.78,-5.73 14.1,-4.55 14.04,3.14 10.56,17.53 6.89,27.99 -13.54,38.63 -40.24,65.15 -74.67,86.01 -4.92,2.97 -9.83,6.06 -15.4,5.24 z"
                                                id="path8899"
                                            />
                                        </g>
                                    </g>
                                </g>
                            </g>
                        </svg>
                        <div className='gs-quote'>
                            <p>"{this.selectedQuote.text}"</p>
                            <p className='gs-quote-author'>- {this.selectedQuote.author}</p>
                        </div>
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
     * Renders the title `{applicationName} Getting Started`.
     */
    protected renderHeader(): React.ReactNode {
        return <div className='gs-header'>
            <h1>
                <div className="gs-header-text">
                    {this.applicationName}<span className='gs-sub-header'>{' ' + GettingStartedWidget.LABEL}</span>
                </div>
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
            <a
                role={'button'}
                tabIndex={0}
                onClick={this.doCreateFile}
                onKeyDown={this.doCreateFileEnter}>
                {nls.localizeByDefault('New File...')}
            </a>
        </div>;

        const open = requireSingleOpen && <div className='gs-action-container'>
            <a
                role={'button'}
                tabIndex={0}
                onClick={this.doOpen}
                onKeyDown={this.doOpenEnter}>
                {nls.localizeByDefault('Open')}
            </a>
        </div>;

        const openFile = !requireSingleOpen && <div className='gs-action-container'>
            <a
                role={'button'}
                tabIndex={0}
                onClick={this.doOpenFile}
                onKeyDown={this.doOpenFileEnter}>
                {nls.localizeByDefault('Open File')}
            </a>
        </div>;

        const openFolder = !requireSingleOpen && <div className='gs-action-container'>
            <a
                role={'button'}
                tabIndex={0}
                onClick={this.doOpenFolder}
                onKeyDown={this.doOpenFolderEnter}>
                {nls.localizeByDefault('Open Folder')}
            </a>
        </div>;

        const openWorkspace = (
            <a
                role={'button'}
                tabIndex={0}
                onClick={this.doOpenWorkspace}
                onKeyDown={this.doOpenWorkspaceEnter}>
                {nls.localizeByDefault('Open Workspace')}
            </a>
        );

        return <div className='gs-section'>
            <h3 className='gs-section-header'><i className={codicon('folder-opened')}></i>{nls.localizeByDefault('Start')}</h3>
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
            <div className='gs-action-container' key={index}>
                <a
                    role={'button'}
                    tabIndex={0}
                    onClick={() => this.open(new URI(items[index]))}
                    onKeyDown={(e: React.KeyboardEvent) => this.openEnter(e, new URI(items[index]))}>
                    {this.labelProvider.getName(new URI(items[index]))}
                </a>
                <span className='gs-action-details'>
                    {item}
                </span>
            </div>
        );
        // If the recently used workspaces list exceeds the limit, display `More...` which triggers the recently used workspaces quick-open menu upon selection.
        const more = paths.length > this.recentLimit && <div className='gs-action-container'>
            <a
                role={'button'}
                tabIndex={0}
                onClick={this.doOpenRecentWorkspace}
                onKeyDown={this.doOpenRecentWorkspaceEnter}>
                {nls.localizeByDefault('More...')}
            </a>
        </div>;
        return <div className='gs-section'>
            <h3 className='gs-section-header'>
                <i className={codicon('history')}></i>{nls.localizeByDefault('Recent')}
            </h3>
            {items.length > 0 ? content : <p className='gs-no-recent'>
                {nls.localizeByDefault('You have no recent folders,') + ' '}
                <a
                    role={'button'}
                    tabIndex={0}
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
        return <div className='gs-section'>
            <h3 className='gs-section-header'>
                <i className={codicon('settings-gear')}></i>
                {nls.localizeByDefault('Settings')}
            </h3>
            <div className='gs-action-container'>
                <a
                    role={'button'}
                    tabIndex={0}
                    onClick={this.doOpenPreferences}
                    onKeyDown={this.doOpenPreferencesEnter}>
                    {nls.localizeByDefault('Open Settings')}
                </a>
            </div>
            <div className='gs-action-container'>
                <a
                    role={'button'}
                    tabIndex={0}
                    onClick={this.doOpenKeyboardShortcuts}
                    onKeyDown={this.doOpenKeyboardShortcutsEnter}>
                    {nls.localizeByDefault('Open Keyboard Shortcuts')}
                </a>
            </div>
        </div>;
    }

    /**
     * Render the help section.
     */
    protected renderHelp(): React.ReactNode {
        return <div className='gs-section'>
            <h3 className='gs-section-header'>
                <i className={codicon('question')}></i>
                {nls.localizeByDefault('Help')}
            </h3>
            <div className='gs-action-container'>
                <a
                    role={'button'}
                    tabIndex={0}
                    onClick={() => this.doOpenExternalLink(this.documentationUrl)}
                    onKeyDown={(e: React.KeyboardEvent) => this.doOpenExternalLinkEnter(e, this.documentationUrl)}>
                    {nls.localizeByDefault('NukeIDE Documentation')}
                </a>
            </div>
            <div className='gs-action-container'>
                <a
                    role={'button'}
                    tabIndex={0}
                    onClick={() => this.doOpenExternalLink(this.neutronicsWorkshopUrl)}
                    onKeyDown={(e: React.KeyboardEvent) => this.doOpenExternalLinkEnter(e, this.neutronicsWorkshopUrl)}>
                    {nls.localizeByDefault('Nuclear Simulation Workshop')}
                </a>
            </div>
        </div>;
    }

    /**
     * Render the version section.
     */
    protected renderVersion(): React.ReactNode {
        return <div className='gs-section'>
            <div className='gs-action-container'>
                <p className='gs-sub-header' >
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
    const [startupEditor, setStartupEditor] = React.useState<string>(
        props.preferenceService.get('workbench.startupEditor', 'welcomePage')
    );
    React.useEffect(() => {
        const prefListener = props.preferenceService.onPreferenceChanged(change => {
            if (change.preferenceName === 'workbench.startupEditor') {
                const prefValue = change.newValue;
                setStartupEditor(prefValue);
            }
        });
        return () => prefListener.dispose();
    }, [props.preferenceService]);
    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newValue = e.target.checked ? 'welcomePage' : 'none';
        props.preferenceService.updateValue('workbench.startupEditor', newValue);
    };
    return (
        <div className='gs-preference'>
            <input
                type="checkbox"
                className="theia-input"
                id="startupEditor"
                onChange={handleChange}
                checked={startupEditor === 'welcomePage' || startupEditor === 'welcomePageInEmptyWorkbench'}
            />
            <label htmlFor="startupEditor">
                {nls.localizeByDefault('Show NukeIDE welcome page on startup')}
            </label>
        </div>
    );
}
