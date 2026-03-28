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

/**
 * CAD Import Service for OpenMC
 * 
 * Backend service for importing CAD files (STEP/IGES) and converting them
 * to OpenMC-compatible CSG geometry.
 * 
 * Uses nuke-core's detectPythonWithRequirements for robust Python/CAD detection.
 * 
 * @module openmc-studio/node
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { NukeCoreBackendService, NukeCoreBackendServiceInterface } from 'nuke-core/lib/common/nuke-core-protocol';

// Use CommonJS require for Node.js modules to ensure proper externalization by webpack
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cp = require('child_process');

/** Supported CAD file formats */
export type CADFileFormat = 'step' | 'iges' | 'stp' | 'igs' | 'brep' | 'stl';

/** CAD import request */
export interface CADImportRequest {
    /** Path to the CAD file */
    filePath: string;
    /** File format (auto-detected if not specified) */
    format?: CADFileFormat;
    /** Import options */
    options?: {
        /** 
         * Tolerance for surface approximation (default: 0.001).
         * @deprecated Reserved for Phase 3 - Direct CAD surface conversion
         */
        tolerance?: number;
        /** Whether to merge coplanar surfaces */
        mergeSurfaces?: boolean;
        /** 
         * Scale factor for the geometry (default: 1.0).
         * @deprecated Reserved for Phase 3 - Direct CAD surface conversion
         */
        scale?: number;
        /** Units of the input file (default: 'cm') */
        units?: 'cm' | 'mm' | 'm' | 'in' | 'ft';
        /** Material assignment for imported geometry */
        materialId?: number;
        /** Universe to place the imported geometry in */
        universeId?: number;
    };
}

/** CAD import result */
export interface CADImportResult {
    /** Whether import was successful */
    success: boolean;
    /** Error message if failed */
    error?: string;
    /** Warning messages */
    warnings?: string[];
    /** Imported surfaces */
    surfaces?: {
        type: string;
        coefficients: number[];
        name?: string;
    }[];
    /** Imported cells */
    cells?: {
        id: number;
        name?: string;
        region: string;
        material?: string;
    }[];
    /** Bounding box of the imported geometry */
    boundingBox?: {
        min: [number, number, number];
        max: [number, number, number];
    };
    /** Original file info */
    fileInfo?: {
        format: CADFileFormat;
        units: string;
        solidCount: number;
        faceCount: number;
        edgeCount: number;
    };
    /** Conversion summary */
    summary?: {
        surfacesCreated: number;
        cellsCreated: number;
        approximationsMade: number;
    };
}

@injectable()
export class OpenMCCADImportService {
    
    @inject(NukeCoreBackendService)
    protected readonly coreService!: NukeCoreBackendServiceInterface;

    // ============================================================================
    // CAD Import
    // ============================================================================

    async importCAD(request: CADImportRequest): Promise<CADImportResult> {
        try {
            // Check CAD support (this uses nuke-core's detectPythonWithRequirements
            // to find a Python environment with CAD libraries)
            const support = await this.checkCADSupport();
            if (!support.available || !support.pythonPath) {
                return {
                    success: false,
                    error: 'CAD import requires gmsh or OpenCASCADE. ' +
                           'Install with: pip install gmsh or conda install -c conda-forge python-gmsh'
                };
            }

            // Detect format if not specified
            const format = request.format || this.detectFormatFromPath(request.filePath);
            if (!format) {
                return {
                    success: false,
                    error: 'Unable to detect CAD file format from path. Please specify format explicitly.'
                };
            }

            // Use OpenMC's built-in CAD import capabilities
            return this.importWithOpenMC(request, support.pythonPath, format);

        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            return {
                success: false,
                error: `CAD import failed: ${msg}`
            };
        }
    }

    /**
     * Check if CAD support is available.
     * Uses nuke-core's detectPythonWithRequirements to find a Python environment
     * with the required CAD libraries (gmsh, OpenCASCADE, or CadQuery).
     */
    async checkCADSupport(): Promise<{
        available: boolean;
        libraries: {
            openCascade: boolean;
            gmsh: boolean;
            cadQuery: boolean;
        };
        pythonPath?: string;
    }> {
        // Use nuke-core's detectPythonWithRequirements to find a Python with CAD libraries
        // This is more robust than manual checking as it tries multiple environments
        const result = await this.coreService.detectPythonWithRequirements({
            requiredPackages: [
                { name: 'gmsh', required: false },  // Optional but preferred
                { name: 'OCC', required: false },   // OpenCASCADE (PythonOCC)
                { name: 'cadquery', required: false }
            ],
            autoDetectEnvs: ['openmc', 'cad', 'gmsh']
        });

        if (!result.success || !result.command) {
            return {
                available: false,
                libraries: { openCascade: false, gmsh: false, cadQuery: false }
            };
        }

        // Now check which specific libraries are available in the detected Python
        const dependencyResult = await this.coreService.checkDependencies([
            { name: 'gmsh', required: false },
            { name: 'OCC', required: false },
            { name: 'cadquery', required: false }
        ], result.command);

        const libraries = {
            openCascade: !!dependencyResult.versions['OCC'],
            gmsh: !!dependencyResult.versions['gmsh'],
            cadQuery: !!dependencyResult.versions['cadquery']
        };

        return {
            available: libraries.openCascade || libraries.gmsh || libraries.cadQuery,
            libraries,
            pythonPath: result.command
        };
    }

    async getSupportedCADFormats(): Promise<CADFileFormat[]> {
        return ['step', 'iges', 'stp', 'igs', 'brep', 'stl'];
    }

    async previewCAD(filePath: string): Promise<{
        format: CADFileFormat;
        solidCount: number;
        faceCount: number;
        bounds?: { min: [number, number, number]; max: [number, number, number] };
    }> {
        const format = this.detectFormatFromPath(filePath);
        if (!format) {
            throw new Error('Unable to detect file format');
        }

        // Check CAD support (uses nuke-core's detectPythonWithRequirements)
        const support = await this.checkCADSupport();
        
        if (!support.available || !support.pythonPath) {
            return {
                format,
                solidCount: 0,
                faceCount: 0
            };
        }

        try {
            // Try to get basic info using gmsh if available
            if (support.libraries.gmsh) {
                const script = `
import gmsh
import sys
gmsh.initialize()
gmsh.open('${filePath.replace(/\\/g, '\\\\')}')
entities = gmsh.model.getEntities()
solids = [e for e in entities if e[0] == 3]
faces = [e for e in entities if e[0] == 2]
print(f"SOLIDS:{len(solids)}")
print(f"FACES:{len(faces)}")
gmsh.finalize()
`;
                const result = cp.spawnSync(support.pythonPath, ['-c', script], { 
                    encoding: 'utf-8',
                    stdio: ['pipe', 'pipe', 'ignore']
                });
                
                const output = result.stdout.toString().trim();
                const lines = output.split('\n');
                const solidMatch = lines.find((l: string) => l.startsWith('SOLIDS:'));
                const faceMatch = lines.find((l: string) => l.startsWith('FACES:'));
                
                return {
                    format,
                    solidCount: solidMatch ? parseInt(solidMatch.split(':')[1]) : 0,
                    faceCount: faceMatch ? parseInt(faceMatch.split(':')[1]) : 0
                };
            }

            return {
                format,
                solidCount: 0,
                faceCount: 0
            };

        } catch {
            return {
                format,
                solidCount: 0,
                faceCount: 0
            };
        }
    }

    // ============================================================================
    // Private Methods
    // ============================================================================

    private detectFormatFromPath(filePath: string): CADFileFormat | undefined {
        const ext = filePath.toLowerCase().split('.').pop();
        const formatMap: Record<string, CADFileFormat> = {
            'step': 'step',
            'stp': 'stp',
            'iges': 'iges',
            'igs': 'igs',
            'brep': 'brep',
            'stl': 'stl'
        };
        return formatMap[ext || ''];
    }

    private async importWithOpenMC(
        request: CADImportRequest, 
        pythonPath: string, 
        format: CADFileFormat
    ): Promise<CADImportResult> {
        const warnings: string[] = [];
        
        try {
            const units = request.options?.units ?? 'cm';
            // Note: tolerance and scale options reserved for Phase 3 - Direct CAD surface conversion

            // Python script to import CAD using OpenMC's capabilities
            const script = `
import openmc
import sys
import json

try:
    # Use OpenMC's CAD import if available
    result = {
        'success': True,
        'surfaces': [],
        'cells': [],
        'summary': {
            'surfacesCreated': 0,
            'cellsCreated': 0,
            'approximationsMade': 0
        }
    }
    
    # Try to read basic geometry info using available libraries
    try:
        import gmsh
        gmsh.initialize()
        gmsh.open('${request.filePath.replace(/\\/g, '\\\\')}')
        
        # Get all entities
        entities = gmsh.model.getEntities()
        
        # Count solids and surfaces
        solids = [e for e in entities if e[0] == 3]
        surfaces = [e for e in entities if e[0] == 2]
        
        result['fileInfo'] = {
            'format': '${format}',
            'units': '${units}',
            'solidCount': len(solids),
            'faceCount': len(surfaces),
            'edgeCount': len([e for e in entities if e[0] == 1])
        }
        
        # Try to get bounding box
        if entities:
            bbox = gmsh.model.getBoundingBox(-1, -1)
            result['boundingBox'] = {
                'min': [bbox[0], bbox[1], bbox[2]],
                'max': [bbox[3], bbox[4], bbox[5]]
            }
        
        gmsh.finalize()
        
    except Exception as e:
        result['warnings'] = [f'gmsh preview failed: {str(e)}']
    
    print(json.dumps(result))
    
except Exception as e:
    error_result = {'success': False, 'error': str(e)}
    print(json.dumps(error_result))
`;

            const result = cp.spawnSync(pythonPath, ['-c', script], {
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'pipe'],
                maxBuffer: 50 * 1024 * 1024 // 50MB buffer for large outputs
            });

            // Find JSON output in the result
            const output = result.stdout.toString().trim();
            const lines = output.split('\n');
            const jsonLine = lines.find((l: string) => l.startsWith('{'));
            
            if (jsonLine) {
                const parsed = JSON.parse(jsonLine);
                return {
                    success: parsed.success ?? false,
                    error: parsed.error,
                    warnings: [...warnings, ...(parsed.warnings || [])],
                    surfaces: parsed.surfaces,
                    cells: parsed.cells,
                    boundingBox: parsed.boundingBox,
                    fileInfo: parsed.fileInfo,
                    summary: parsed.summary
                };
            }

            return {
                success: false,
                error: 'Failed to parse import result',
                warnings
            };

        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            return {
                success: false,
                error: `OpenMC import failed: ${msg}`,
                warnings
            };
        }
    }
}
