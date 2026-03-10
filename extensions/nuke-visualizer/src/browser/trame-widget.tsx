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

import { ReactWidget, Message } from '@theia/core/lib/browser';
import { injectable, postConstruct, inject } from '@theia/core/shared/inversify';
import * as React from '@theia/core/shared/react';
import URI from '@theia/core/lib/common/uri';
import { TrameBackendService, PythonConfig } from '../common/trame-protocol';
import { VisualizerPreferences } from './trame-preferences';

@injectable()
export class TrameWidget extends ReactWidget {
    static readonly ID = 'nuke-visualizer.widget';
    static readonly LABEL = 'Nuke Visualizer';

    private serverUrl: string | null = null;
    private serverPort: number | null = null;
    private statusMessage: string = 'Initializing...';
    private checkInterval: number | null = null;
    private currentFile: string | null = null;

    @inject(TrameBackendService)
    protected readonly trameBackend: TrameBackendService;

    @inject(VisualizerPreferences)
    protected readonly preferences: VisualizerPreferences;

    @postConstruct()
    protected init(): void {
        this.id = TrameWidget.ID;
        this.title.label = TrameWidget.LABEL;
        this.title.caption = TrameWidget.LABEL;
        this.title.closable = true;
        this.update();
    }

    protected override onActivateRequest(msg: Message): void {
        super.onActivateRequest(msg);
        const iframe = this.node.querySelector('iframe');
        iframe?.focus();
    }

    protected render(): React.ReactNode {
        return (
            <div className='trame-container' style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
                {!this.serverUrl && (
                    <div style={{ 
                        padding: '20px', 
                        textAlign: 'center',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        height: '100%'
                    }}>
                        <div className='theia-preload theia-loading-spinner' style={{ marginBottom: '20px' }}></div>
                        <p>{this.statusMessage}</p>
                        {this.currentFile && (
                            <p style={{ fontSize: '12px', marginTop: '10px' }}>File: {this.currentFile}</p>
                        )}
                        <div style={{ marginTop: '10px', fontSize: '12px', color: 'var(--theia-descriptionForeground)' }}>
                            Configure Python path in Preferences → Nuke Visualizer
                        </div>
                    </div>
                )}
                {this.serverUrl && (
                    <iframe
                        key={this.serverUrl} // Force re-render when URL changes
                        src={this.serverUrl}
                        style={{ width: '100%', height: '100%', border: 'none', flex: 1 }}
                        title="Trame Visualization"
                        sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
                    />
                )}
            </div>
        );
    }

    public async loadFile(fileUri: URI): Promise<void> {
        const filePath = fileUri.path.toString();
        
        // If already showing this file, just activate
        if (this.currentFile === filePath && this.serverUrl) {
            return;
        }
        
        this.currentFile = filePath;
        this.title.label = `Trame: ${fileUri.path.base}`;
        
        // Stop existing server before starting new one
        await this.cleanupServer();
        
        // Reset state
        this.serverUrl = null;
        this.update();
        
        // Check if file is .h5m and needs conversion
        if (filePath.endsWith('.h5m')) {
            await this.convertAndLoadDAGMC(filePath);
        } else {
            await this.startTrameServer(filePath);
        }
    }

    private async cleanupServer(): Promise<void> {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
        
        if (this.serverPort) {
            try {
                await this.trameBackend.stopServer(this.serverPort);
                console.log(`[Trame] Stopped server on port ${this.serverPort}`);
            } catch (err) {
                console.error('[Trame] Failed to stop server:', err);
            }
            this.serverPort = null;
        }
        
        this.serverUrl = null;
    }

    private async convertAndLoadDAGMC(h5mPath: string): Promise<void> {
        this.statusMessage = `Converting DAGMC file: ${h5mPath}...`;
        this.update();
        
        try {
            console.warn(`[Trame] DAGMC conversion not yet implemented for: ${h5mPath}`);
            this.statusMessage = `DAGMC files require conversion. Please convert ${h5mPath} to VTK format using mbconvert.`;
            this.update();
            await this.startTrameServer();
        } catch (error) {
            console.error('[Trame] DAGMC conversion failed:', error);
            this.statusMessage = `Conversion failed: ${error}`;
            this.update();
            await this.startTrameServer();
        }
    }

    private async startTrameServer(filePath?: string): Promise<void> {
        this.statusMessage = 'Starting trame server...';
        this.update();

        try {
            // Build config from preferences
            const config: PythonConfig = {
                pythonPath: this.preferences['nuke.visualizer.pythonPath'] || undefined,
                condaEnv: this.preferences['nuke.visualizer.condaEnv'] || undefined,
            };
            
            console.log('[Trame] Requesting server start from backend...');
            console.log('[Trame] Config:', JSON.stringify(config, null, 2));
            
            const result = await this.trameBackend.startServer(filePath, config);
            
            this.serverPort = result.port;
            console.log(`[Trame] Server started on port ${result.port}, URL: ${result.url}`);
            
            this.statusMessage = `Server started on port ${result.port}. Waiting for it to be ready...`;
            this.update();
            
            // Poll to check if server is actually responding
            const timeout = (this.preferences['nuke.visualizer.serverTimeout'] || 30) * 1000;
            let attempts = 0;
            const maxAttempts = timeout / 1000;
            
            this.checkInterval = window.setInterval(async () => {
                attempts++;
                
                try {
                    // Use a simple image request to test connectivity
                    const testImg = new Image();
                    testImg.onload = () => {
                        this.serverUrl = result.url;
                        this.statusMessage = `Server ready at ${result.url}`;
                        this.update();
                        
                        if (this.checkInterval) {
                            clearInterval(this.checkInterval);
                            this.checkInterval = null;
                        }
                    };
                    testImg.onerror = () => {
                        // Image failed, but server might still be starting
                    };
                    testImg.src = `${result.url}/favicon.ico?${Date.now()}`;
                    
                    // Also try fetch as backup
                    await fetch(result.url, { 
                        method: 'HEAD',
                        mode: 'no-cors'
                    });
                    
                    // If we get here, server is responding
                    if (!this.serverUrl) {
                        this.serverUrl = result.url;
                        this.statusMessage = `Server ready at ${result.url}`;
                        this.update();
                        
                        if (this.checkInterval) {
                            clearInterval(this.checkInterval);
                            this.checkInterval = null;
                        }
                    }
                } catch (e) {
                    if (attempts % 5 === 0) {
                        console.log(`[Trame] Waiting for server... attempt ${attempts}/${maxAttempts}`);
                    }
                    
                    if (attempts >= maxAttempts) {
                        if (this.checkInterval) {
                            clearInterval(this.checkInterval);
                            this.checkInterval = null;
                        }
                        this.statusMessage = `Server not responding after ${maxAttempts}s. Check backend logs and Python configuration.`;
                        this.update();
                        console.error('[Trame] Server startup timeout');
                    }
                }
            }, 1000);
            
        } catch (error) {
            console.error('[Trame] Failed to start server:', error);
            this.statusMessage = `Failed to start server: ${error}. Check Preferences → Nuke Visualizer.`;
            this.update();
        }
    }

    protected override onCloseRequest(msg: Message): void {
        this.cleanupServer().then(() => {
            super.onCloseRequest(msg);
        });
    }
}
