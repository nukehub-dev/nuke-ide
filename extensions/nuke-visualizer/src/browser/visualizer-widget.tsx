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

import { injectable, postConstruct, inject } from '@theia/core/shared/inversify';
import * as React from '@theia/core/shared/react';
import URI from '@theia/core/lib/common/uri';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import { VisualizerBackendService } from '../common/base-visualizer-protocol';
import { NativeVtkViewerWidget } from './plugins/openmc/widgets/native-vtk-viewer-widget';
import { parseNativeVtk, readVtkText } from './plugins/openmc/widgets/native-vtk/native-vtk-data';

/**
 * Generic single-file visualizer (native-only): arbitrary VTK/DAGMC/STEP/Gmsh
 * files render in the three.js viewer after a `parseNativeVtk` probe.
 * DAGMC/STEP/Gmsh inputs convert first (convert-then-probe); anything the
 * native parser rejects (binary VTK, `.stl`/`.ply`/`.obj` meshes, unparseable
 * files) renders an error panel naming the supported kinds instead of
 * starting a visualization server. There is no served/iframe path — widget
 * ID, open-handler claims, and the DAGMC sibling logic are unchanged.
 */
@injectable()
export class VisualizerWidget extends NativeVtkViewerWidget {
    static override readonly ID = 'nuke-visualizer.widget';
    static override readonly LABEL = 'Visualizer';

    private currentFile: string | null = null;
    private currentFileUri: URI | null = null;
    private currentLoadId: number = 0;
    private highlightVolumeId: number | undefined = undefined;

    @inject(VisualizerBackendService)
    protected readonly visualizerBackend: VisualizerBackendService;

    @inject(FileDialogService)
    protected readonly fileDialogService: FileDialogService;

    constructor(options?: any) {
        super(options);
        this.scrollOptions = undefined;
    }

    @postConstruct()
    protected init(): void {
        this.id = VisualizerWidget.ID;
        this.title.label = VisualizerWidget.LABEL;
        this.title.caption = VisualizerWidget.LABEL;
        this.title.closable = true;
        this.update();
    }

    /**
     * Set the file URI and update the widget ID to be unique.
     * This should be called by the factory or contribution to differentiate widgets.
     */
    public setUri(uri: URI, volumeId?: number): void {
        this.currentFileUri = uri;
        this.currentFile = uri.path.toString();
        this.highlightVolumeId = volumeId;
        // Use a unique ID based on the file path so Theia can manage multiple instances
        this.id = `${VisualizerWidget.ID}:${this.currentFile}`;
        this.title.label = `Visualizer: ${uri.path.base}`;
        this.title.caption = `Visualizer: ${this.currentFile}`;
        this.update();
    }

    /**
     * Header reload/retry buttons call `setVtkFile(this.fileUri)`; re-run the
     * full convert-then-probe load so DAGMC/STEP/Gmsh inputs convert again, and
     * keep the generic visualizer identity (the base implementation rebrands
     * to the native viewer ID).
     */
    override async setVtkFile(uri: URI): Promise<void> {
        await this.loadFile(uri, this.highlightVolumeId);
        const path = this.currentFileUri?.path.toString();
        if (path) {
            this.id = `${VisualizerWidget.ID}:${path}`;
            this.title.label = `Visualizer: ${this.currentFileUri?.path.base}`;
            this.title.caption = `Visualizer: ${path}`;
            this.update();
        }
    }

    protected render(): React.ReactNode {
        // Empty state before any file is opened: the base viewer would show a
        // bare "No dataset loaded" viewarea, so keep the rich empty UI with
        // the file browser entry point. Everything else (loading spinner,
        // native canvas, error panel) comes from the base implementation.
        if (!this.currentFileUri && !this.model && !this.isLoading && !this.error) {
            return (
                <div className="visualizer-container" style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
                    <div
                        style={{
                            padding: '24px',
                            textAlign: 'center',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            height: '100%'
                        }}
                    >
                        <div
                            style={{
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                                justifyContent: 'center',
                                padding: '48px 32px',
                                background: 'var(--theia-editorWidget-background)',
                                height: '80%',
                                width: '80%'
                            }}
                        >
                            <div style={{ fontSize: '64px', marginBottom: '24px', color: 'var(--theia-foreground)', opacity: 0.8 }}>
                                <span className="codicon codicon-symbol-misc" style={{ fontSize: '64px' }} />
                            </div>
                            <h3 style={{ margin: '0 0 12px 0', fontSize: '22px', fontWeight: 600, color: 'var(--theia-foreground)' }}>
                                No Visualization Loaded
                            </h3>
                            <p
                                style={{
                                    margin: '0 0 24px 0',
                                    fontSize: '14px',
                                    color: 'var(--theia-descriptionForeground)',
                                    textAlign: 'center',
                                    maxWidth: '320px',
                                    lineHeight: 1.6
                                }}
                            >
                                Open a VTK, DAGMC, or mesh file to visualize geometry and results in interactive 3D
                            </p>
                            <button
                                className="visualizer-empty-button"
                                style={{
                                    padding: '12px 24px',
                                    backgroundColor: 'var(--theia-button-background)',
                                    color: 'var(--theia-button-foreground)',
                                    border: '1px solid var(--theia-button-border)',
                                    borderRadius: '8px',
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '8px',
                                    fontSize: '14px',
                                    fontWeight: 500
                                }}
                                onClick={() => this.browseAndOpen()}
                            >
                                <span className="codicon codicon-folder-opened" />
                                Browse Files
                            </button>
                            <div
                                style={{
                                    marginTop: '32px',
                                    padding: '16px 20px',
                                    background: 'rgba(100,100,100,0.05)',
                                    borderRadius: '8px',
                                    fontSize: '12px',
                                    color: 'var(--theia-descriptionForeground)',
                                    border: '1px solid var(--theia-panel-border)'
                                }}
                            >
                                <div style={{ fontWeight: 500, marginBottom: '6px' }}>Supported formats (native rendering):</div>
                                <div>VTK XML (.vtp, .vtr, .vti)</div>
                                <div>H5M (DAGMC — converted)</div>
                                <div>STEP, STP, BREP (CAD — converted)</div>
                                <div>MSH (Gmsh — converted)</div>
                            </div>
                        </div>
                    </div>
                </div>
            );
        }
        return super.render();
    }

    public async loadFile(fileUri: URI, volumeId?: number): Promise<void> {
        const loadId = ++this.currentLoadId;
        const filePath = fileUri.path.toString();

        // Ensure URI and ID are set correctly
        this.setUri(fileUri, volumeId);

        this.update();

        // Check if file needs conversion before visualization
        if (filePath.endsWith('.h5m')) {
            await this.convertAndLoadDAGMC(filePath, loadId);
        } else if (/\.(step|stp|brep)$/i.test(filePath)) {
            await this.convertAndLoadSTEP(filePath, loadId);
        } else if (/\.msh$/i.test(filePath)) {
            await this.convertAndLoadGmsh(filePath, loadId);
        } else {
            await this.loadNativeFile(filePath, loadId);
        }
    }

    private async browseAndOpen(): Promise<void> {
        const fileUri = await this.fileDialogService.showOpenDialog({
            title: 'Select File to Visualize',
            openLabel: 'Open',
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: {
                'VTK Files': ['vtk', 'vtu', 'vtp', 'vts', 'vtr', 'pvtu', 'pvtp'],
                'DAGMC Files': ['h5m'],
                'CAD Files': ['step', 'stp', 'brep'],
                'Gmsh Mesh': ['msh'],
                'Mesh Files': ['stl', 'ply', 'obj'],
                'All Files': ['*']
            }
        });

        if (fileUri) {
            const uri = Array.isArray(fileUri) ? fileUri[0] : fileUri;
            await this.loadFile(uri);
        }
    }

    private async convertAndLoadDAGMC(h5mPath: string, loadId: number): Promise<void> {
        if (loadId !== this.currentLoadId) return;

        const volumeInfo = this.highlightVolumeId !== undefined ? ` (volume ${this.highlightVolumeId})` : '';
        this.isLoading = true;
        this.error = undefined;
        this.statusMessage = `Converting DAGMC file: ${h5mPath}${volumeInfo}...`;
        this.update();

        try {
            // Use backend service to convert DAGMC to VTK
            // Pass volumeId to extract only that volume if specified
            const vtkPath = await this.visualizerBackend.convertDagmc(h5mPath, this.highlightVolumeId);

            // Check if still the active load
            if (loadId !== this.currentLoadId) return;

            this.statusMessage = `Conversion successful. Loading visualization...`;
            this.update();

            // Probe the converted file for native rendering
            await this.loadNativeFile(vtkPath, loadId);
        } catch (error) {
            if (loadId !== this.currentLoadId) return;
            console.error('[Visualizer] DAGMC conversion failed:', error);
            this.isLoading = false;
            this.error = error instanceof Error ? error.message : String(error);
            this.update();
        }
    }

    private async convertAndLoadSTEP(stepPath: string, loadId: number): Promise<void> {
        if (loadId !== this.currentLoadId) return;

        this.isLoading = true;
        this.error = undefined;
        this.statusMessage = `Converting CAD file: ${stepPath}...`;
        this.update();

        try {
            // Use backend service to convert STEP to VTK
            const vtkPath = await this.visualizerBackend.convertStep(stepPath);

            // Check if still the active load
            if (loadId !== this.currentLoadId) return;

            this.statusMessage = `Conversion successful. Loading visualization...`;
            this.update();

            // Probe the converted file for native rendering
            await this.loadNativeFile(vtkPath, loadId);
        } catch (error) {
            if (loadId !== this.currentLoadId) return;
            console.error('[Visualizer] STEP conversion failed:', error);
            this.isLoading = false;
            this.error = `CAD conversion failed: ${error instanceof Error ? error.message : String(error)}`;
            this.update();
        }
    }

    private async convertAndLoadGmsh(mshPath: string, loadId: number): Promise<void> {
        if (loadId !== this.currentLoadId) return;

        this.isLoading = true;
        this.error = undefined;
        this.statusMessage = `Converting Gmsh mesh: ${mshPath}...`;
        this.update();

        try {
            // Import the existing Gmsh mesh and export legacy ASCII VTK
            const vtkPath = await this.visualizerBackend.convertGmsh(mshPath);

            // Check if still the active load
            if (loadId !== this.currentLoadId) return;

            this.statusMessage = `Gmsh conversion successful. Loading visualization...`;
            this.update();

            // Probe the converted file for native rendering
            await this.loadNativeFile(vtkPath, loadId);
        } catch (error) {
            if (loadId !== this.currentLoadId) return;
            console.error('[Visualizer] Gmsh conversion failed:', error);
            this.isLoading = false;
            this.error = `Gmsh conversion failed: ${error instanceof Error ? error.message : String(error)}`;
            this.update();
        }
    }

    /**
     * Render `filePath` natively: read through Theia's FileService, probe
     * with `parseNativeVtk`, and render with instant color-by on success.
     * Anything the native parser rejects (binary VTK, `.stl`/`.ply`/`.obj`
     * meshes, unparseable files) surfaces an error panel naming the supported
     * kinds — there is no server fallback. Stale loads bail out instead of
     * touching widget state.
     */
    private async loadNativeFile(filePath: string, loadId: number): Promise<void> {
        this.isLoading = true;
        this.error = undefined;
        this.statusMessage = 'Reading file...';
        this.update();

        let text: string;
        try {
            text = await readVtkText(this.fileService, new URI(filePath));
        } catch (readError) {
            if (loadId !== this.currentLoadId) return;
            this.isLoading = false;
            this.error = `Cannot read '${new URI(filePath).path.base}': ${readError instanceof Error ? readError.message : readError}`;
            this.update();
            return;
        }
        if (loadId !== this.currentLoadId) {
            return;
        }
        // Probe the native reader first (XML kinds plus legacy ASCII .vtk,
        // covering .vtp/.vtr/.vti/.vtu/.vts/.vtk): files outside the probe
        // set throw here and surface the supported-kinds error below.
        try {
            await parseNativeVtk(text, filePath);
        } catch (probeError) {
            if (loadId !== this.currentLoadId) return;
            console.warn(
                `[Visualizer] Native VTK parse failed for ${filePath}:`,
                probeError instanceof Error ? probeError.message : probeError
            );
            this.isLoading = false;
            this.error =
                `Cannot preview '${new URI(filePath).path.base}' in the native viewer ` +
                `(${probeError instanceof Error ? probeError.message : probeError}). ` +
                `Supported kinds: XML VTK (.vtp, .vtr, .vti, .vtu, .vts) and legacy ASCII .vtk; ` +
                `.h5m (DAGMC), .step/.stp/.brep (CAD), and .msh (Gmsh) convert automatically to VTK.`;
            this.update();
            return;
        }
        if (loadId !== this.currentLoadId) {
            return;
        }
        // Point the native header at the opened file (not the converted temp
        // file) and render the probed text.
        this.fileUri = this.currentFileUri ?? new URI(filePath);
        await this.setVtkText(text);
        if (loadId !== this.currentLoadId) {
            return;
        }
        this.fileUri = this.currentFileUri ?? new URI(filePath);
        this.update();
    }
}
