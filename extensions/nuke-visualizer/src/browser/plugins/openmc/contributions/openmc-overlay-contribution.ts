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

import { injectable, inject } from '@theia/core/shared/inversify';
import { MessageService } from '@theia/core/lib/common';
import { QuickInputService, QuickPickValue } from '@theia/core/lib/browser';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import URI from '@theia/core/lib/common/uri';
import { OpenMCService, TallyVisualizationOptions } from '../openmc-service';
import { OpenMCSliceOptions } from '../../../../common/openmc-protocol';
import { OpenMCTallySelector } from '../widgets/statepoint/tally-selector';
import { OpenMCFileDiscovery } from './openmc-file-discovery';

@injectable()
export class OpenMCOverlayContribution {
    @inject(OpenMCService)
    protected readonly openmcService: OpenMCService;

    @inject(QuickInputService)
    protected readonly quickInput: QuickInputService;

    @inject(MessageService)
    protected readonly messageService: MessageService;

    @inject(FileDialogService)
    protected readonly fileDialogService: FileDialogService;

    @inject(FileService)
    protected readonly fileService: FileService;

    @inject(OpenMCFileDiscovery)
    protected readonly fileDiscovery: OpenMCFileDiscovery;

    async overlayTallyCommand(): Promise<void> {
        // 1. Get statepoint file first
        const statepointFiles = await this.fileDiscovery.getStatepointFiles();

        const statepointOptions: QuickPickValue<string>[] = [
            {
                value: '__browse__',
                label: '$(folder-opened) Browse for statepoint file...',
                description: 'Select statepoint.h5 file from any location'
            }
        ];

        if (statepointFiles.length > 0) {
            statepointOptions.push({ type: 'separator', label: 'Workspace Files' } as any, ...statepointFiles);
        }

        const statepointSelection = await this.quickInput.showQuickPick(statepointOptions, {
            title: 'Select Statepoint File',
            placeholder: statepointFiles.length > 0 ? 'Choose a file or browse...' : 'Browse for statepoint.h5 file...'
        });

        if (!statepointSelection) return;

        let statepointUri: URI;
        if (statepointSelection.value === '__browse__') {
            this.quickInput.hide();
            await new Promise((resolve) => setTimeout(resolve, 300));
            try {
                const fileUri = await this.fileDialogService.showOpenDialog({
                    title: 'Select Statepoint File',
                    openLabel: 'Select',
                    canSelectFiles: true,
                    canSelectFolders: false,
                    canSelectMany: false,
                    filters: {
                        'Statepoint Files': ['h5'],
                        'All Files': ['*']
                    }
                });
                if (!fileUri) return;
                statepointUri = Array.isArray(fileUri) ? fileUri[0] : fileUri;
            } catch (error) {
                this.messageService.error(`File picker failed: ${error}`);
                return;
            }
        } else {
            statepointUri = new URI(statepointSelection.value);
        }

        // 2. Auto-detect geometry from statepoint folder
        const spDir = statepointUri.parent;
        let geometryUri = await this.fileDiscovery.autoDetectGeometry(spDir);

        // Ask user to confirm or override
        if (geometryUri) {
            const confirm = await this.quickInput.showQuickPick(
                [
                    { value: 'use', label: `$(check) Use detected: ${geometryUri.path.base}`, description: geometryUri.path.toString() },
                    {
                        value: 'browse',
                        label: '$(folder-opened) Browse for different geometry...',
                        description: 'Select another .h5m or .xml file'
                    }
                ],
                {
                    title: 'Geometry File Detected',
                    placeholder: 'Use auto-detected geometry or browse for another'
                }
            );

            if (!confirm) return;
            if (confirm.value === 'browse') {
                geometryUri = undefined;
            }
        }

        // If no auto-detected geometry, browse
        if (!geometryUri) {
            const fileUri = await this.fileDialogService.showOpenDialog({
                title: 'Select Geometry File',
                openLabel: 'Select',
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: {
                    'Geometry Files': ['h5m', 'xml'],
                    'All Files': ['*']
                }
            });
            if (!fileUri) return;
            geometryUri = Array.isArray(fileUri) ? fileUri[0] : fileUri;
        }

        if (!geometryUri) return;

        // 3. Use shared prompt for overlay options
        const overlayOptions = await this.openmcService.promptOverlayOptions(geometryUri);
        if (!overlayOptions) return;

        await this.showTallySelectorForOverlay(
            geometryUri,
            statepointUri,
            overlayOptions.mode,
            overlayOptions.sliceOptions,
            overlayOptions.options.pixelated,
            overlayOptions.options.filterGraveyard
        );
    }

    async showTallySelectorForOverlay(
        geometryUri: URI,
        statepointUri: URI,
        mode: 'slice' | 'full' = 'slice',
        sliceOptions?: OpenMCSliceOptions,
        pixelated?: boolean,
        filterGraveyard?: boolean
    ): Promise<void> {
        // Load tallies from statepoint
        console.log(`[OpenMC] Loading tallies from: ${statepointUri.toString()}`);
        try {
            await this.openmcService.loadTallyList(statepointUri);
        } catch (error) {
            console.error('[OpenMC] Error loading tally list:', error);
            this.messageService.error(`Failed to load tallies: ${error}`);
            return;
        }

        const tallies = this.openmcService.getCurrentTallies();
        console.log(`[OpenMC] Found ${tallies.length} tallies:`, tallies.map((t) => `Tally ${t.id}`).join(', '));

        if (tallies.length === 0) {
            this.messageService.warn('No tallies found in statepoint file');
            return;
        }

        const selector = new OpenMCTallySelector(this.quickInput);
        const selection = await selector.show(tallies);

        if (selection) {
            // Validate tally exists
            const tallyExists = tallies.some((t) => t.id === selection.tallyId);
            if (!tallyExists) {
                this.messageService.error(
                    `Tally ${selection.tallyId} not found in statepoint. Available: ${tallies.map((t) => t.id).join(', ')}`
                );
                return;
            }

            const options: TallyVisualizationOptions = {
                tallyId: selection.tallyId,
                score: selection.score,
                nuclide: selection.nuclide,
                colorMap: selection.colorMap
            };

            if (mode === 'slice' && sliceOptions) {
                await this.openmcService.visualizeTallySlice(geometryUri, statepointUri, options, sliceOptions);
            } else {
                options.pixelated = pixelated !== false;
                options.filterGraveyard = filterGraveyard !== false;
                await this.openmcService.visualizeTallyOnGeometry(geometryUri, statepointUri, options);
            }
        }
    }

    async handleOverlayOnGeometry(selection: any, statepointUri: URI, knownGeometryUri?: URI, withSource: boolean = false): Promise<void> {
        let geometryUri: URI | undefined;

        // If geometry is already known (from file manager), use it directly
        if (knownGeometryUri) {
            console.log(`[OpenMC] Using known geometry: ${knownGeometryUri.toString()}`);
            geometryUri = knownGeometryUri;
        } else {
            // Auto-detect from statepoint folder first
            geometryUri = await this.fileDiscovery.autoDetectGeometry(statepointUri.parent);

            if (!geometryUri) {
                // Fall back to manual selection
                const geometryFiles = await this.fileDiscovery.getGeometryFiles();
                const geometryOptions: QuickPickValue<string>[] = [
                    {
                        value: '__browse__',
                        label: '$(folder-opened) Browse for geometry file...',
                        description: 'Select .h5m or .xml file from any location'
                    }
                ];
                if (geometryFiles.length > 0) {
                    geometryOptions.push({ type: 'separator', label: 'Workspace Files' } as any, ...geometryFiles);
                }
                const geometrySelection = await this.quickInput.showQuickPick(geometryOptions, {
                    title: 'Select Geometry File',
                    placeholder: geometryFiles.length > 0 ? 'Choose a file or browse...' : 'Browse for .h5m or .xml file...'
                });
                if (!geometrySelection) return;
                if (geometrySelection.value === '__browse__') {
                    this.quickInput.hide();
                    await new Promise((resolve) => setTimeout(resolve, 300));
                    try {
                        const fileUri = await this.fileDialogService.showOpenDialog({
                            title: 'Select Geometry File',
                            openLabel: 'Select',
                            canSelectFiles: true,
                            canSelectFolders: false,
                            canSelectMany: false,
                            filters: {
                                'Geometry Files': ['h5m', 'xml'],
                                'All Files': ['*']
                            }
                        });
                        if (!fileUri) return;
                        geometryUri = Array.isArray(fileUri) ? fileUri[0] : fileUri;
                    } catch (error) {
                        this.messageService.error(`File picker failed: ${error}`);
                        return;
                    }
                } else {
                    geometryUri = new URI(geometrySelection.value);
                }
            }
        }

        if (!geometryUri) return;

        // Source overlay bypasses all prompts and uses defaults
        if (withSource) {
            const baseOptions: TallyVisualizationOptions = {
                tallyId: selection.tallyId,
                score: selection.score,
                nuclide: selection.nuclide,
                filterGraveyard: true
            };
            try {
                await this.openmcService.visualizeTallyAndSourceOnGeometry(geometryUri, statepointUri, baseOptions);
            } catch (error) {
                console.error('[OpenMC] Overlay error:', error);
                this.messageService.error(`Failed to overlay tally with source: ${error}`);
            }
            return;
        }

        // Use shared prompt for overlay options (regular overlay only)
        const overlayOptions = await this.openmcService.promptOverlayOptions(geometryUri);
        if (!overlayOptions) return;

        const baseOptions: TallyVisualizationOptions = {
            ...overlayOptions.options,
            tallyId: selection.tallyId,
            score: selection.score,
            nuclide: selection.nuclide
        };

        try {
            if (overlayOptions.mode === 'slice') {
                await this.openmcService.visualizeTallySlice(geometryUri, statepointUri, baseOptions, overlayOptions.sliceOptions!);
            } else {
                await this.openmcService.visualizeTallyOnGeometry(geometryUri, statepointUri, baseOptions);
            }
        } catch (error) {
            console.error('[OpenMC] Overlay error:', error);
            this.messageService.error(`Failed to overlay tally: ${error}`);
        }
    }
}
