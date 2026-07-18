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
import { LabelProvider } from '@theia/core/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import URI from '@theia/core/lib/common/uri';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { QuickPickValue } from '@theia/core/lib/browser';

@injectable()
export class OpenMCFileDiscovery {
    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;

    @inject(FileService)
    protected readonly fileService: FileService;

    @inject(LabelProvider)
    protected readonly labelProvider: LabelProvider;

    /**
     * Generic file discovery method that recursively searches workspace for files matching criteria.
     */
    private async discoverFiles(matcher: (name: string) => boolean, maxFiles: number = 20): Promise<QuickPickValue<string>[]> {
        const workspace = this.workspaceService.workspace;
        if (!workspace) {
            return [];
        }

        const files: QuickPickValue<string>[] = [];

        try {
            const rootUri = workspace.resource;

            const collectFiles = async (uri: URI): Promise<void> => {
                if (files.length >= maxFiles) return;

                try {
                    const dirStat = await this.fileService.resolve(uri);
                    if (dirStat.children) {
                        for (const child of dirStat.children) {
                            if (child.isFile && matcher(child.name)) {
                                files.push({
                                    value: child.resource.toString(),
                                    label: child.name,
                                    description: this.labelProvider.getLongName(child.resource)
                                });
                                if (files.length >= maxFiles) return;
                            } else if (child.isDirectory && !child.name.startsWith('.')) {
                                await collectFiles(child.resource);
                                if (files.length >= maxFiles) return;
                            }
                        }
                    }
                } catch (e) {
                    // Ignore errors for individual directories
                }
            };

            await collectFiles(rootUri);
        } catch (e) {
            console.error('[OpenMC] Failed to search for files:', e);
        }

        return files;
    }

    async getStatepointFiles(): Promise<QuickPickValue<string>[]> {
        return this.discoverFiles((name) => name.startsWith('statepoint') && name.endsWith('.h5'));
    }

    async getSourceFiles(): Promise<QuickPickValue<string>[]> {
        return this.discoverFiles((name) => name === 'source.h5');
    }

    async getGeometryFiles(): Promise<QuickPickValue<string>[]> {
        const workspace = this.workspaceService.workspace;
        if (!workspace) {
            return [];
        }

        const dagmcFiles: QuickPickValue<string>[] = [];
        const geometryXmlFiles: QuickPickValue<string>[] = [];

        try {
            const rootUri = workspace.resource;

            const collectGeometryFiles = async (uri: URI): Promise<void> => {
                if (dagmcFiles.length >= 20 && geometryXmlFiles.length >= 20) return;

                try {
                    const dirStat = await this.fileService.resolve(uri);
                    if (dirStat.children) {
                        for (const child of dirStat.children) {
                            if (child.isFile) {
                                if (child.name.endsWith('.h5m') && dagmcFiles.length < 20) {
                                    dagmcFiles.push({
                                        value: child.resource.toString(),
                                        label: child.name,
                                        description: this.labelProvider.getLongName(child.resource)
                                    });
                                } else if (child.name === 'geometry.xml' && geometryXmlFiles.length < 20) {
                                    geometryXmlFiles.push({
                                        value: child.resource.toString(),
                                        label: child.name,
                                        description: this.labelProvider.getLongName(child.resource)
                                    });
                                }
                            } else if (child.isDirectory && !child.name.startsWith('.')) {
                                await collectGeometryFiles(child.resource);
                            }
                        }
                    }
                } catch (e) {
                    // Ignore errors for individual directories
                }
            };

            await collectGeometryFiles(rootUri);
        } catch (e) {
            console.error('[OpenMC] Failed to search for geometry files:', e);
        }

        // Combine DAGMC and geometry.xml files
        const files: QuickPickValue<string>[] = [];

        if (dagmcFiles.length > 0) {
            files.push({ type: 'separator', label: 'DAGMC Files (.h5m)' } as any, ...dagmcFiles);
        }

        if (geometryXmlFiles.length > 0) {
            if (files.length > 0) {
                files.push({ type: 'separator', label: 'OpenMC Geometry (.xml)' } as any);
            }
            files.push(...geometryXmlFiles);
        }

        return files;
    }

    async getDepletionFiles(): Promise<QuickPickValue<string>[]> {
        return this.discoverFiles((name) => name.includes('depletion') && name.endsWith('.h5'));
    }

    async autoDetectGeometry(directory: URI): Promise<URI | undefined> {
        const candidates = [directory.resolve('geometry.h5m'), directory.resolve('dagmc.h5m'), directory.resolve('geometry.xml')];

        for (const uri of candidates) {
            try {
                const stat = await this.fileService.resolve(uri);
                if (stat.isFile) {
                    return uri;
                }
            } catch {
                // File doesn't exist
            }
        }
        return undefined;
    }
}
