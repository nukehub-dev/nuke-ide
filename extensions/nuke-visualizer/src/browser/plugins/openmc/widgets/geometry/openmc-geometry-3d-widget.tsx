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

import * as React from 'react';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { codicon } from '@theia/core/lib/browser/widgets/widget';
import { Message } from '@lumino/messaging';
import URI from '@theia/core/lib/common/uri';
import { MessageService } from '@theia/core/lib/common';
import './openmc-geometry-tree.css';

import { OpenMCService } from '../../openmc-service';
import { LoadingAnimations, FancyLoadingSpinner, ErrorDisplay, EmptyState } from 'nuke-essentials/lib/theme/browser/components/loading-spinner';
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components/tooltip';

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
        this.error = null;  // Clear any previous error
        this.isLoading = false;  // Reset loading state
        this.serverUrl = null;  // Reset server URL
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
                    <LoadingAnimations />
                    <ErrorDisplay message={this.error} />
                </div>
            );
        }

        if (this.isLoading) {
            return (
                <div className="geometry-3d-container loading">
                    <LoadingAnimations />
                    <FancyLoadingSpinner 
                        message="Loading 3D Geometry..." 
                        subMessage="Please wait" 
                    />
                </div>
            );
        }

        if (!this.serverUrl) {
            return (
                <div className="geometry-3d-container empty">
                    <EmptyState 
                        icon="globe" 
                        message="No geometry loaded" 
                    />
                </div>
            );
        }

        const fileName = this.geometryUri?.path.base || 'Geometry';

        return (
            <div className="geometry-3d-container">
                <div className="geometry-3d-header">
                    <Tooltip content={fileName} position="bottom">
                        <span className="file-name">
                            <i className={codicon('globe')}></i>
                            {fileName}
                        </span>
                    </Tooltip>
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
