// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0.
//
// This Source Code may also be available under the following Secondary
// Licenses when the conditions for such availability set forth in the Eclipse
// Public License v. 2.0 are satisfied: GNU General Public License, version 2
// with the GNU Classpath Exception which is available at
// https://www.gnu.org/software/classpath/license.html.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

import * as React from 'react';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { codicon } from '@theia/core/lib/browser/widgets/widget';
import { Message } from '@lumino/messaging';
import URI from '@theia/core/lib/common/uri';
import { MessageService } from '@theia/core/lib/common';
import './openmc-geometry-tree.css';

import { OpenMCService } from './openmc-service';

@injectable()
export class OpenMCGeometry3DWidget extends ReactWidget {
    static readonly ID = 'openmc-geometry-3d-widget';
    static readonly LABEL = 'OpenMC Geometry 3D View';

    @inject(MessageService)
    protected readonly messageService!: MessageService;

    @inject(OpenMCService)
    protected readonly openmcService!: OpenMCService;

    private geometryUri: URI | null = null;
    private serverUrl: string | null = null;
    private serverPort: number | null = null;
    private highlightedCell: number | null = null;
    private isLoading = false;
    private error: string | null = null;

    @postConstruct()
    protected init(): void {
        this.id = OpenMCGeometry3DWidget.ID;
        this.title.label = OpenMCGeometry3DWidget.LABEL;
        this.title.caption = OpenMCGeometry3DWidget.LABEL;
        this.title.iconClass = codicon('globe');
        this.title.closable = true;
        this.node.tabIndex = 0;
    }

    setGeometry(uri: URI): void {
        this.geometryUri = uri;
        this.update();
    }

    setServerInfo(url: string, port: number): void {
        this.serverUrl = url;
        this.serverPort = port;
        this.isLoading = false;
        this.update();
    }

    setHighlightedCell(cellId: number | null): void {
        this.highlightedCell = cellId;
        this.update();
    }

    setLoading(loading: boolean): void {
        this.isLoading = loading;
        this.update();
    }

    setError(error: string | null): void {
        this.error = error;
        this.isLoading = false;
        this.update();
    }

    getServerPort(): number | null {
        return this.serverPort;
    }

    protected render(): React.ReactNode {
        if (this.error) {
            return (
                <div className="geometry-3d-container error">
                    <div className="error-message">
                        <i className={codicon('error')}></i>
                        <div>{this.error}</div>
                    </div>
                </div>
            );
        }

        if (this.isLoading) {
            return (
                <div className="geometry-3d-container loading">
                    <div className="loading-spinner">
                        <i className={codicon('loading')}></i>
                        <div>Loading 3D Geometry...</div>
                    </div>
                </div>
            );
        }

        if (!this.serverUrl) {
            return (
                <div className="geometry-3d-container empty">
                    <div className="empty-message">
                        <i className={codicon('globe')}></i>
                        <div>No geometry loaded</div>
                    </div>
                </div>
            );
        }

        const fileName = this.geometryUri?.path.base || 'Geometry';

        return (
            <div className="geometry-3d-container">
                <div className="geometry-3d-header">
                    <span className="file-name" title={fileName}>
                        <i className={codicon('globe')}></i>
                        {fileName}
                    </span>
                    {this.highlightedCell !== null && (
                        <span className="highlight-badge">
                            Cell {this.highlightedCell} highlighted
                        </span>
                    )}
                </div>
                <div className="geometry-3d-viewer">
                    <iframe
                        src={this.serverUrl}
                        className="geometry-iframe"
                        sandbox="allow-scripts allow-same-origin allow-forms"
                        title="OpenMC Geometry 3D View"
                    />
                </div>
            </div>
        );
    }

    protected onCloseRequest(msg: Message): void {
        // Stop the server when widget is closed
        if (this.serverPort) {
            console.log(`[OpenMC3D] Closing widget, stopping server on port ${this.serverPort}`);
            this.openmcService.stopServer(this.serverPort).catch((err: any) => {
                console.error(`[OpenMC3D] Failed to stop server on port ${this.serverPort}:`, err);
            });
        }
        super.onCloseRequest(msg);
    }

    protected onActivateRequest(msg: Message): void {
        super.onActivateRequest(msg);
        this.node.focus();
    }
}
