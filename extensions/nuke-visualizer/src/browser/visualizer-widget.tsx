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

import { ReactWidget, Message, CommonCommands } from '@theia/core/lib/browser';
import { injectable, postConstruct, inject } from '@theia/core/shared/inversify';
import * as React from '@theia/core/shared/react';
import URI from '@theia/core/lib/common/uri';
import { CommandRegistry } from '@theia/core/lib/common/command';
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

    @inject(CommandRegistry)
    protected readonly commandRegistry: CommandRegistry;

    @postConstruct()
    protected init(): void {

        this.id = VisualizerWidget.ID;
        this.title.label = VisualizerWidget.LABEL;
        this.title.caption = VisualizerWidget.LABEL;
        this.title.closable = true;
        VisualizerWidget.instances.add(this);
        this.update();
    }

    private handleServerStop(port: number): void {
        if (this.serverPort === port) {

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
                          statusLower.includes('loading') || statusLower.includes('initializing') || 
                          statusLower.includes('converting') || statusLower.includes('overlay') ||
                          statusLower === 'initializing...' || statusLower.includes('server started'));
        const hasWarning = this.warningMessage !== null;
        
        // Inject global styles for animations
        const globalStyles = `
            @keyframes visualizer-spin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }
            @keyframes visualizer-pulse {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.5; }
            }
            @keyframes visualizer-fadeIn {
                from { opacity: 0; transform: translateY(10px); }
                to { opacity: 1; transform: translateY(0); }
            }
            @keyframes visualizer-shimmer {
                0% { background-position: -200% 0; }
                100% { background-position: 200% 0; }
            }
        `;
        
        return (
            <div className='visualizer-container' style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
                <style>{globalStyles}</style>
                {!this.serverUrl && (
                    <div style={{ 
                        padding: '24px', 
                        textAlign: 'center',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        height: '100%',
                        animation: 'visualizer-fadeIn 0.3s ease-out'
                    }}>
                        {isLoading && (
                        <div style={{ 
                            marginBottom: '32px', 
                            display: 'flex', 
                            flexDirection: 'column', 
                            alignItems: 'center',
                            padding: '32px',
                            background: 'var(--theia-editorWidget-background, rgba(100,100,100,0.1))',
                            borderRadius: '12px',
                            border: '1px solid var(--theia-panel-border)'
                        }}>
                            {/* Animated spinner with gradient */}
                            <div style={{ 
                                width: '56px', 
                                height: '56px', 
                                position: 'relative',
                                marginBottom: '20px'
                            }}>
                                <div style={{
                                    position: 'absolute',
                                    inset: '0',
                                    borderRadius: '50%',
                                    border: '3px solid transparent',
                                    borderTopColor: 'var(--theia-focusBorder, #007fd4)',
                                    borderRightColor: 'var(--theia-focusBorder, #007fd4)',
                                    animation: 'visualizer-spin 1s linear infinite'
                                }}></div>
                                <div style={{
                                    position: 'absolute',
                                    inset: '6px',
                                    borderRadius: '50%',
                                    border: '3px solid transparent',
                                    borderBottomColor: 'var(--theia-charts-blue, #3794ff)',
                                    borderLeftColor: 'var(--theia-charts-blue, #3794ff)',
                                    animation: 'visualizer-spin 1.5s linear infinite reverse'
                                }}></div>
                            </div>
                            <div style={{ 
                                fontSize: '15px', 
                                fontWeight: 500,
                                color: 'var(--theia-foreground)',
                                marginBottom: '8px'
                            }}>
                                {this.statusMessage || 'Starting visualization server...'}
                            </div>
                            <div style={{
                                fontSize: '12px',
                                color: 'var(--theia-descriptionForeground)',
                                animation: 'visualizer-pulse 2s ease-in-out infinite'
                            }}>
                                Please wait
                            </div>
                        </div>
                    )}
                    {hasWarning && (
                        <div style={{ 
                            color: 'var(--theia-foreground)',
                            backgroundColor: 'var(--theia-inputValidation-warningBackground, rgba(255, 204, 0, 0.1))',
                            border: '1px solid var(--theia-inputValidation-warningBorder, #ffcc00)',
                            padding: '16px 20px',
                            borderRadius: '8px',
                            marginBottom: '20px',
                            maxWidth: '640px',
                            textAlign: 'left',
                            animation: 'visualizer-fadeIn 0.3s ease-out',
                            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)'
                        }}>
                            <div style={{ 
                                fontWeight: 600, 
                                marginBottom: '10px', 
                                color: 'var(--theia-warningForeground, #b58900)',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '8px',
                                fontSize: '14px'
                            }}>
                                <span className='codicon codicon-warning' style={{ fontSize: '16px' }} />
                                Warning
                            </div>
                            <div style={{ 
                                fontFamily: 'var(--theia-code-font-family, monospace)', 
                                fontSize: '12px', 
                                whiteSpace: 'pre-wrap',
                                lineHeight: '1.5',
                                opacity: 0.9
                            }}>{this.warningMessage}</div>
                        </div>
                    )}
                    {isError && (
                        <div style={{ 
                            color: 'var(--theia-errorForeground)',
                            backgroundColor: 'var(--theia-inputValidation-errorBackground, rgba(244, 67, 54, 0.1))',
                            border: '1px solid var(--theia-inputValidation-errorBorder, #f44336)',
                            padding: '16px 20px',
                            borderRadius: '8px',
                            marginBottom: '20px',
                            maxWidth: '640px',
                            textAlign: 'left',
                            animation: 'visualizer-fadeIn 0.3s ease-out',
                            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)'
                        }}>
                            <div style={{ 
                                fontWeight: 600, 
                                marginBottom: '10px',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '8px',
                                fontSize: '14px'
                            }}>
                                <span className='codicon codicon-error' style={{ fontSize: '16px' }} />
                                Error
                            </div>
                            <div style={{ 
                                fontFamily: 'var(--theia-code-font-family, monospace)', 
                                fontSize: '12px', 
                                whiteSpace: 'pre-wrap',
                                lineHeight: '1.5',
                                opacity: 0.9
                            }}>{this.statusMessage}</div>
                        </div>
                        )}
                        {!isLoading && !isError && !hasWarning && (
                        <div style={{
                            padding: '24px',
                            background: 'var(--theia-editorWidget-background, rgba(100,100,100,0.05))',
                            borderRadius: '8px',
                            border: '1px solid var(--theia-panel-border)',
                            animation: 'visualizer-fadeIn 0.3s ease-out'
                        }}>
                            <p style={{ 
                                margin: 0,
                                fontSize: '14px',
                                color: 'var(--theia-foreground)'
                            }}>{this.statusMessage}</p>
                        </div>
                        )}
                        {this.currentFile && (
                            <div style={{ 
                                marginTop: '16px',
                                padding: '8px 16px',
                                background: 'var(--theia-badge-background, rgba(100,100,100,0.2))',
                                borderRadius: '16px',
                                fontSize: '12px',
                                color: 'var(--theia-badge-foreground)',
                                fontFamily: 'var(--theia-code-font-family, monospace)',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '6px'
                            }}>
                                <span className='codicon codicon-file' />
                                <span style={{ 
                                    maxWidth: '400px',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap'
                                }}>{this.currentFile}</span>
                            </div>
                        )}
                        {isError && (
                            <div style={{ marginTop: '24px', display: 'flex', gap: '12px', flexDirection: 'column', alignItems: 'center' }}>
                                <button 
                                    style={{ 
                                        padding: '10px 20px',
                                        backgroundColor: 'var(--theia-button-background)',
                                        color: 'var(--theia-button-foreground)',
                                        border: '1px solid var(--theia-button-border)',
                                        borderRadius: '6px',
                                        cursor: 'pointer',
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '8px',
                                        fontSize: '13px',
                                        fontWeight: 500,
                                        transition: 'all 0.2s ease',
                                        boxShadow: '0 2px 4px rgba(0, 0, 0, 0.1)'
                                    }}
                                    onMouseEnter={(e) => {
                                        e.currentTarget.style.transform = 'translateY(-1px)';
                                        e.currentTarget.style.boxShadow = '0 4px 8px rgba(0, 0, 0, 0.15)';
                                    }}
                                    onMouseLeave={(e) => {
                                        e.currentTarget.style.transform = 'translateY(0)';
                                        e.currentTarget.style.boxShadow = '0 2px 4px rgba(0, 0, 0, 0.1)';
                                    }}
                                    onClick={() => this.retry()}
                                >
                                    <span className='codicon codicon-refresh' />
                                    Retry
                                </button>
                                <button 
                                    style={{ 
                                        padding: '10px 20px',
                                        backgroundColor: 'var(--theia-button-secondaryBackground, transparent)',
                                        color: 'var(--theia-button-secondaryForeground)',
                                        border: '1px solid var(--theia-button-border)',
                                        borderRadius: '6px',
                                        cursor: 'pointer',
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '8px',
                                        fontSize: '13px',
                                        fontWeight: 500,
                                        transition: 'all 0.2s ease'
                                    }}
                                    onMouseEnter={(e) => {
                                        e.currentTarget.style.backgroundColor = 'var(--theia-button-hoverBackground, rgba(100,100,100,0.1))';
                                    }}
                                    onMouseLeave={(e) => {
                                        e.currentTarget.style.backgroundColor = 'var(--theia-button-secondaryBackground, transparent)';
                                    }}
                                    onClick={() => this.openSettings()}
                                >
                                    <span className='codicon codicon-settings-gear' />
                                    Configure Python Path
                                </button>
                            </div>
                        )}
                    </div>
                )}
                {this.serverUrl && (
                    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', animation: 'visualizer-fadeIn 0.3s ease-out' }}>
                        {this.warningMessage && (
                            <div style={{ 
                                color: 'var(--theia-foreground)',
                                backgroundColor: 'var(--theia-inputValidation-warningBackground, rgba(255, 204, 0, 0.1))',
                                border: '1px solid var(--theia-inputValidation-warningBorder, #ffcc00)',
                                padding: '10px 16px',
                                borderRadius: '6px',
                                margin: '8px 8px 0 8px',
                                fontSize: '12px',
                                textAlign: 'left',
                                display: 'flex',
                                alignItems: 'flex-start',
                                gap: '8px'
                            }}>
                                <span className='codicon codicon-warning' style={{ 
                                    color: 'var(--theia-warningForeground, #b58900)',
                                    marginTop: '2px',
                                    flexShrink: 0
                                }} />
                                <div style={{ 
                                    fontFamily: 'var(--theia-code-font-family, monospace)',
                                    whiteSpace: 'pre-wrap',
                                    flex: 1
                                }}>{this.warningMessage}</div>
                            </div>
                        )}
                        <iframe
                            key={`${this.serverUrl}-${this.currentLoadId}`}
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

            this.ensureClosable();
            this.update();
            return;
        }
        

        
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

    private openSettings(): void {
        // Open the preferences view
        this.commandRegistry.executeCommand(CommonCommands.OPEN_PREFERENCES.id);
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

            }
            console.log('[Visualizer] Requesting server start from backend...');
            const result = await this.visualizerBackend.startServer(filePath, config, theme);
            
            // Check again after async call
            if (currentId !== this.currentLoadId) {

                this.visualizerBackend.stopServer(result.port);
                return;
            }

            this.serverPort = result.port;

            
            if (result.warning) {
                this.warningMessage = result.warning;

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

        VisualizerWidget.instances.delete(this);
        this.cleanupServer();
        super.onCloseRequest(msg);
    }
}
