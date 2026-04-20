// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

import { injectable, inject } from '@theia/core/shared/inversify';
import URI from '@theia/core/lib/common/uri';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { OpenMCFileSet } from '../openmc-service';
import { OpenMCTallyInfo } from '../../../../common/openmc-protocol';

@injectable()
export class OpenMCFileDiscoveryService {
    @inject(FileService)
    protected readonly fileService: FileService;

    /**
     * Discover related OpenMC files in a directory.
     */
    async discoverFilesInDirectory(directoryUri: URI): Promise<OpenMCFileSet> {
        const result: OpenMCFileSet = {};
        try {
            const stat = await this.fileService.resolve(directoryUri);
            if (stat.children) {
                for (const child of stat.children) {
                    const name = child.name.toLowerCase();
                    if (name.endsWith('.h5m') || name.endsWith('.vtk')) {
                        result.geometry = child.resource;
                    } else if (name.startsWith('statepoint') && name.endsWith('.h5')) {
                        result.statepoint = child.resource;
                    } else if (name === 'source.h5') {
                        result.source = child.resource;
                    }
                }
            }
        } catch (error) {
            console.error('[OpenMC] Error discovering files:', error);
        }
        return result;
    }

    /**
     * Suggest the best visualization for a file.
     */
    async suggestVisualization(fileUri: URI): Promise<string | null> {
        const fileName = fileUri.path.base.toLowerCase();
        if (fileName.startsWith('statepoint') && fileName.endsWith('.h5')) {
            return 'statepoint';
        } else if (fileName === 'source.h5') {
            return 'source';
        } else if (fileName.endsWith('.h5m')) {
            return 'geometry';
        } else if (fileName.includes('depletion') && fileName.endsWith('.h5')) {
            return 'depletion';
        } else if (fileName === 'geometry.xml') {
            return 'geometry-hierarchy';
        } else if (fileName === 'materials.xml') {
            return 'materials';
        }
        return null;
    }

    /**
     * Check if a file name indicates a depletion results file.
     */
    isDepletionFile(fileName: string): boolean {
        const lower = fileName.toLowerCase();
        return lower.includes('depletion') && lower.endsWith('.h5');
    }

    /**
     * Verify that a URI exists and is a file.
     */
    async checkFileExists(uri: URI): Promise<boolean> {
        try {
            const stat = await this.fileService.resolve(uri);
            return !stat.isDirectory;
        } catch {
            return false;
        }
    }

    getFilterDescription(filter: { type: string; bins: number; meshDimensions?: number[] }): string {
        if (filter.type === 'mesh' && filter.meshDimensions) {
            return `Mesh (${filter.meshDimensions.join('×')})`;
        }
        return `${filter.type} (${filter.bins} bins)`;
    }

    getTallyDescription(tally: OpenMCTallyInfo): string {
        const parts: string[] = [];
        if (tally.scores.length > 0) {
            parts.push(tally.scores.join(', '));
        }
        if (tally.nuclides.length > 0 && !tally.nuclides.includes('total')) {
            parts.push(tally.nuclides.join(', '));
        }
        const filterDesc = tally.filters.map((f: any) => this.getFilterDescription(f)).join(', ');
        if (filterDesc) {
            parts.push(filterDesc);
        }
        return parts.join(' | ') || 'Tally';
    }
}
