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
import { VisualizerBackendService, PythonConfig } from '../common/visualizer-protocol';
import { VisualizerPreferences } from './visualizer-preferences';

@injectable()
export class VisualizerWidget extends ReactWidget {
    static readonly ID = 'nuke-visualizer.widget';
    static readonly LABEL = 'Nuke Visualizer';

    private static instances: Set<VisualizerWidget> = new Set();

    public static onServerStop(port: number): void {
        for (const instance of VisualizerWidget.instances) {
            instance.handleServerStop(port);
        }
    }

    private serverUrl: string | null = null;
    private serverPort: number | null = null;
    private statusMessage: string = 'No file loaded';
    private warningMessage: string | null = null;
    private checkInterval: number | null = null;
    private currentFile: string | null = null;
    private currentFileUri: URI | null = null;
    private currentLoadId: number = 0;

    @inject(VisualizerBackendService)
    protected readonly visualizerBackend: VisualizerBackendService;

    @inject(VisualizerPreferences)
    protected readonly preferences: VisualizerPreferences;

    @postConstruct()
    protected init(): void {
        console.log(`[VisualizerWidget] Initializing widget instance`);
        this.id = VisualizerWidget.ID;
        this.title.label = VisualizerWidget.LABEL;
        this.title.caption = VisualizerWidget.LABEL;
        this.title.closable = true;
        VisualizerWidget.instances.add(this);
        this.update();
    }

    private handleServerStop(port: number): void {
        if (this.serverPort === port) {
            console.log(`[Visualizer] Server on port ${port} stopped, updating widget state`);
            this.serverUrl = null;
            this.serverPort = null;
            this.statusMessage = 'Visualizer server stopped unexpectedly. Check logs for details.';
            if (this.checkInterval) {
                clearInterval(this.checkInterval);
                this.checkInterval = null;
            }
            this.update();
        }
    }

    /**
     * Set the file URI and update the widget ID to be unique.
     * This should be called by the factory or contribution to differentiate widgets.
     */
    public setUri(uri: URI): void {
        this.currentFileUri = uri;
        this.currentFile = uri.path.toString();
        // Use a unique ID based on the file path so Theia can manage multiple instances
        this.id = `${VisualizerWidget.ID}:${this.currentFile}`;
        this.title.label = `Visualizer: ${uri.path.base}`;
        this.title.caption = `Visualizer: ${this.currentFile}`;
        this.update();
    }

    /**
     * Set the server URL directly (for when server is already running, e.g., OpenMC).
     */
    public setServerUrl(url: string, port: number): void {
        console.log(`[VisualizerWidget] Setting server URL: ${url}, port: ${port}`);
        this.serverUrl = url;
        this.serverPort = port;
        this.statusMessage = `Server ready at ${url}`;
        this.update();
    }

    /**
     * Get the current server port.
     */
    public getServerPort(): number | null {
        return this.serverPort;
    }

    protected override onActivateRequest(msg: Message): void {
        super.onActivateRequest(msg);
        const iframe = this.node.querySelector('iframe');
        iframe?.focus();
    }

    protected override onAfterShow(msg: Message): void {
        super.onAfterShow(msg);
        console.log('[VisualizerWidget] Widget shown, forcing update');
        this.update();
    }

    protected render(): React.ReactNode {
        const statusLower = this.statusMessage.toLowerCase();
        const isError = statusLower.includes('failed') || statusLower.includes('error') || 
                        statusLower.includes('unable') || statusLower.includes('unavailable') ||
                        statusLower.includes('not found') || statusLower.includes('missing') ||
                        statusLower.includes('invalid') || statusLower.includes('timeout') ||
                        statusLower.includes('cannot') || statusLower.includes('not responding') ||
                        statusLower.includes('no suitable') || statusLower.includes('not installed') ||
                        statusLower.includes('cannot find') || statusLower.includes('unexpected');
        const isLoading = !this.serverUrl && 
                         (statusLower.includes('starting') || statusLower.includes('waiting') || 
                          statusLower.includes('initializing') || statusLower.includes('converting') ||
                          statusLower === 'initializing...' || statusLower.includes('server started'));
        const hasWarning = this.warningMessage !== null;
        return (
            <div className='visualizer-container' style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
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
                        {isLoading && (
                        <div style={{ marginBottom: '30px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                            {/* Inline spinner with all necessary styles */}
                            <div style={{ 
                                width: '50px', 
                                height: '50px', 
                                border: '4px solid var(--theia-scrollbarSlider-background, rgba(100,100,100,0.3))',
                                borderTop: '4px solid var(--theia-focusBorder, #007fd4)',
                                borderRadius: '50%',
                                animation: 'spin 1s linear infinite',
                                marginBottom: '15px'
                            }}></div>
                            <style>{`
                                @keyframes spin {
                                    0% { transform: rotate(0deg); }
                                    100% { transform: rotate(360deg); }
                                }
                            `}</style>
                            <div style={{ 
                                fontSize: '14px', 
                                color: 'var(--theia-descriptionForeground)'
                            }}>
                                Starting visualization server...
                            </div>
                        </div>
                    )}
                    {hasWarning && (
                        <div style={{ 
                            color: 'var(--theia-foreground)',
                            backgroundColor: 'var(--theia-inputValidation-warningBackground, #fffbe6)',
                            border: '1px solid var(--theia-inputValidation-warningBorder, #ffcc00)',
                            padding: '15px',
                            borderRadius: '4px',
                            marginBottom: '20px',
                            maxWidth: '600px',
                            textAlign: 'left'
                        }}>
                            <div style={{ fontWeight: 'bold', marginBottom: '8px', color: 'var(--theia-warningForeground, #b58900)' }}>Warning</div>
                            <div style={{ fontFamily: 'monospace', fontSize: '12px', whiteSpace: 'pre-wrap' }}>{this.warningMessage}</div>
                        </div>
                    )}
                    {isError && (
                        <div style={{ 
                            color: 'var(--theia-errorForeground)',
                            backgroundColor: 'var(--theia-inputValidation-errorBackground)',
                            border: '1px solid var(--theia-inputValidation-errorBorder)',
                            padding: '15px',
                            borderRadius: '4px',
                            marginBottom: '20px',
                            maxWidth: '600px',
                            textAlign: 'left'
                        }}>
                            <div style={{ fontWeight: 'bold', marginBottom: '8px' }}>Error</div>
                            <div style={{ fontFamily: 'monospace', fontSize: '12px', whiteSpace: 'pre-wrap' }}>{this.statusMessage}</div>
                        </div>
                        )}
                        {!isError && (
                        <p>{this.statusMessage}</p>
                        )}
                        {this.currentFile && (

                            <p style={{ fontSize: '12px', marginTop: '10px' }}>File: {this.currentFile}</p>
                        )}
                        <div style={{ marginTop: '10px', fontSize: '12px', color: 'var(--theia-descriptionForeground)' }}>
                            Configure Python path in Preferences → Settings → Extensions → Nuke Visualizer
                        </div>
                        {isError && (
                            <button 
                                style={{ 
                                    marginTop: '15px',
                                    padding: '8px 16px',
                                    backgroundColor: 'var(--theia-button-background)',
                                    color: 'var(--theia-button-foreground)',
                                    border: '1px solid var(--theia-button-border)',
                                    borderRadius: '3px',
                                    cursor: 'pointer'
                                }}
                                onClick={() => this.retry()}
                            >
                                Retry
                            </button>
                        )}
                    </div>
                )}
                {this.serverUrl && (
                    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                        {this.warningMessage && (
                            <div style={{ 
                                color: 'var(--theia-foreground)',
                                backgroundColor: 'var(--theia-inputValidation-warningBackground, #fffbe6)',
                                border: '1px solid var(--theia-inputValidation-warningBorder, #ffcc00)',
                                padding: '8px 12px',
                                borderRadius: '4px',
                                marginBottom: '8px',
                                fontSize: '12px',
                                textAlign: 'left'
                            }}>
                                <div style={{ fontWeight: 'bold', marginBottom: '4px', color: 'var(--theia-warningForeground, #b58900)' }}>⚠️ Warning</div>
                                <div style={{ fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>{this.warningMessage}</div>
                            </div>
                        )}
                        <iframe
                            key={`${this.serverUrl}-${this.currentLoadId}`} // Force re-render when URL or load session changes
                            src={this.serverUrl}
                            style={{ width: '100%', height: '100%', border: 'none', flex: 1 }}
                            title="Visualizer Visualization"
                            sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
                        />
                    </div>
                )}
            </div>
        );
    }

    public async loadFile(fileUri: URI): Promise<void> {
        const loadId = ++this.currentLoadId;
        const filePath = fileUri.path.toString();
        
        // If already showing this file, just activate
        if (this.currentFile === filePath && this.serverUrl) {
            console.log(`[Visualizer] File ${filePath} already loaded, skipping reload`);
            this.ensureClosable();
            this.update();
            return;
        }
        
        console.log(`[Visualizer] Loading file: ${filePath} (loadId: ${loadId})`);
        
        // Ensure URI and ID are set correctly
        if (!this.currentFileUri || this.currentFileUri.toString() !== fileUri.toString()) {
            this.setUri(fileUri);
        }

        this.ensureClosable();
        this.update();
        
        // Check if file is .h5m and needs conversion
        if (filePath.endsWith('.h5m')) {
            await this.convertAndLoadDAGMC(filePath, loadId);
        } else {
            await this.startVisualizerServer(filePath, loadId);
        }
    }

    private async cleanupServer(): Promise<void> {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
        
        const portToStop = this.serverPort;
        
        // Reset all widget state IMMEDIATELY to avoid race conditions in UI
        this.serverUrl = null;
        this.serverPort = null;
        this.statusMessage = 'No file loaded';
        this.warningMessage = null;
        this.currentFile = null;
        this.currentFileUri = null;
        this.title.label = VisualizerWidget.LABEL;
        this.title.closable = true;
        this.update();
        
        if (portToStop) {
            try {
                console.log(`[Visualizer] Stopping server on port ${portToStop}...`);
                await this.visualizerBackend.stopServer(portToStop);
                console.log(`[Visualizer] Stopped server on port ${portToStop}`);
            } catch (err) {
                console.error('[Visualizer] Failed to stop server:', err);
            }
        }
    }

    private ensureClosable(): void {
        if (!this.title.closable) {
            this.title.closable = true;
        }
    }

    private async retry(): Promise<void> {
        console.log('[Visualizer] Retry requested');
        const uri = this.currentFileUri;
        this.warningMessage = null;
        this.statusMessage = 'Retrying...';
        this.update();
        
        await this.cleanupServer();
        
        if (uri) {
            await this.loadFile(uri);
        } else {
            await this.startVisualizerServer();
        }
    }

    private async convertAndLoadDAGMC(h5mPath: string, loadId: number): Promise<void> {
        if (loadId !== this.currentLoadId) return;

        this.statusMessage = `Converting DAGMC file: ${h5mPath}...`;
        this.update();
        
        try {
            // Use backend service to convert DAGMC to VTK
            const vtkPath = await this.visualizerBackend.convertDagmc(h5mPath);
            
            // Check if still the active load
            if (loadId !== this.currentLoadId) return;
            
            console.log(`[Visualizer] DAGMC conversion successful: ${vtkPath}`);
            this.statusMessage = `Conversion successful. Loading visualization...`;
            this.update();
            
            // Start visualizer server with the converted VTK file
            await this.startVisualizerServer(vtkPath, loadId);
        } catch (error) {
            console.error('[Visualizer] DAGMC conversion failed:', error);
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.statusMessage = errorMsg;
            this.update();
            this.ensureClosable();
            // Still try to start server with default visualization
            await this.startVisualizerServer(undefined, loadId);
        }
    }

    private async startVisualizerServer(filePath?: string, loadId?: number): Promise<void> {
        const currentId = loadId ?? ++this.currentLoadId;
        if (currentId !== this.currentLoadId) {
            console.log(`[Visualizer] startVisualizerServer cancelled for loadId ${currentId}`);
            return;
        }

        if (!filePath) {
            // If no filePath provided and we don't already have an error message, set it
            const statusLower = this.statusMessage.toLowerCase();
            const alreadyHasError = statusLower.includes('failed') || statusLower.includes('error');
            if (!alreadyHasError) {
                this.statusMessage = 'No file loaded';
            }
            this.warningMessage = null;
            this.update();
            return;
        }

        this.statusMessage = 'Starting visualizer server...';
        this.warningMessage = null;
        this.update();

        try {
            // Build config from preferences
            const config: PythonConfig = {
                pythonPath: this.preferences['nukeVisualizer.pythonPath'] || undefined,
                condaEnv: this.preferences['nukeVisualizer.condaEnv'] || undefined,
            };
            
            // Detect current theme using multiple methods
            let theme = 'dark'; // default
            try {
                // Method 1: Check CSS classes
                const body = document.body;
                const classes = body?.className || '';
                
                // Method 2: Check computed background color
                const computedStyle = window.getComputedStyle(body);
                const bgColor = computedStyle.backgroundColor;
                
                // Method 3: Check matchMedia for system preference
                const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
                
                console.log(`[Visualizer] Theme detection - classes: "${classes}", bg: ${bgColor}, prefersDark: ${prefersDark}`);
                
                // Determine theme based on evidence
                if (classes.includes('theia-light') || classes.includes('light-theia')) {
                    theme = 'light';
                } else if (classes.includes('theia-dark') || classes.includes('dark-theia') || classes.includes('vs-dark')) {
                    theme = 'dark';
                } else if (bgColor && (bgColor.includes('255') || bgColor.includes('rgb(255'))) {
                    // Light background (rgb(255, 255, 255) or similar)
                    theme = 'light';
                } else if (bgColor && (bgColor.includes('0, 0, 0') || bgColor.includes('30') || bgColor.includes('37'))) {
                    // Dark background
                    theme = 'dark';
                } else if (prefersDark) {
                    theme = 'dark';
                }
            } catch (e) {
                console.log(`[Visualizer] Theme detection failed: ${e}, using default`);
            }
            console.log(`[Visualizer] Using theme: ${theme}`);
            
            console.log('[Visualizer] Requesting server start from backend...');
            const result = await this.visualizerBackend.startServer(filePath, config, theme);
            
            // Check again after async call
            if (currentId !== this.currentLoadId) {
                console.log(`[Visualizer] Load ${currentId} cancelled while starting server, killing new server on port ${result.port}`);
                this.visualizerBackend.stopServer(result.port);
                return;
            }

            this.serverPort = result.port;
            console.log(`[Visualizer] Server started on port ${result.port}, URL: ${result.url}`);
            
            if (result.warning) {
                this.warningMessage = result.warning;
                console.log(`[Visualizer] Warning from backend: ${result.warning}`);
                this.ensureClosable();
            }
            
            this.statusMessage = `Server started on port ${result.port}. Waiting for it to be ready...`;
            this.update();
            this.ensureClosable();
            
            // Poll to check if server is actually responding
            const timeout = (this.preferences['nukeVisualizer.serverTimeout'] || 30) * 1000;
            let attempts = 0;
            const maxAttempts = timeout / 1000;
            
            // Wait a moment before first poll to let server initialize
            await new Promise(resolve => setTimeout(resolve, 1500));

            this.checkInterval = window.setInterval(async () => {
                // Check if this load is still active
                if (currentId !== this.currentLoadId) {
                    if (this.checkInterval) {
                        clearInterval(this.checkInterval);
                        this.checkInterval = null;
                    }
                    return;
                }

                attempts++;
                try {
                    // Use an image request to test connectivity - most robust cross-origin probe
                    const testImg = new Image();
                    
                    const setReady = () => {
                        if (currentId !== this.currentLoadId) return;
                        
                        if (!this.serverUrl) {
                            console.log(`[Visualizer] Server at ${result.url} is ready (attempt ${attempts})`);
                            // Append theme to URL so trame knows which theme to use
                            this.serverUrl = `${result.url}?theme=${theme}`;
                            this.statusMessage = `Server ready at ${result.url}`;
                            this.update();
                            this.ensureClosable();

                            // Once ready, we can stop the probing interval as we now rely on 
                            // the backend to notify us of process exit via onServerStop
                            if (this.checkInterval) {
                                clearInterval(this.checkInterval);
                                this.checkInterval = null;
                            }
                        }
                    };

                    testImg.onload = setReady;
                    
                    testImg.onerror = () => {
                        if (currentId !== this.currentLoadId) return;
                        
                        // If we haven't reached serverUrl yet, any error (including 404/403) 
                        // means the server is at least responding at the network level
                        if (!this.serverUrl) {
                            console.log(`[Visualizer] Image probe got response (error/success) from ${result.url}, considering server started`);
                            setReady();
                        }
                    };

                    testImg.src = `${result.url}/favicon.ico?${Date.now()}`;
                    
                    if (!this.serverUrl && attempts >= maxAttempts) {
                        if (this.checkInterval) {
                            clearInterval(this.checkInterval);
                            this.checkInterval = null;
                        }
                        this.statusMessage = `Server not responding after ${maxAttempts}s. Check backend logs.`;
                        this.update();
                        this.ensureClosable();
                    }
                    
                } catch (e) {
                    // Handle unexpected errors in polling
                }
            }, 2000); // Check every 2 seconds
            
        } catch (error) {
            if (currentId !== this.currentLoadId) return;
            
            console.error('[Visualizer] Failed to start server:', error);
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.statusMessage = `Failed to start server: ${errorMsg}`;
            this.update();
            this.ensureClosable();
        }
    }

    protected override onCloseRequest(msg: Message): void {
        console.log('[VisualizerWidget] Close requested, cleaning up server...');
        VisualizerWidget.instances.delete(this);
        this.cleanupServer();
        super.onCloseRequest(msg);
    }
}
