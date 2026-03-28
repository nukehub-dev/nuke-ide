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
import * as path from 'path';
import * as fs from 'fs';

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
         * Tolerance for surface approximation in cm (default: 0.001).
         * Surfaces with deviation less than this will be converted to exact primitives.
         */
        tolerance?: number;
        /** Whether to merge coplanar surfaces */
        mergeSurfaces?: boolean;
        /** 
         * Scale factor for the geometry (default: 1.0).
         * Applied after unit conversion.
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

            // Find the Python script
            const scriptPath = this.findCADImporterScript();
            if (!fs.existsSync(scriptPath)) {
                return {
                    success: false,
                    error: `CAD importer script not found at: ${scriptPath}`
                };
            }

            // Build arguments for Python script
            const units = request.options?.units ?? 'cm';
            const tolerance = request.options?.tolerance ?? 0.001;
            const scale = request.options?.scale ?? 1.0;
            const materialId = request.options?.materialId;
            const universeId = request.options?.universeId ?? 0;
            
            const unitFactor = this.getUnitFactor(units) * scale;

            const args = [
                scriptPath,
                request.filePath,
                '--unit-factor', unitFactor.toString(),
                '--tolerance', tolerance.toString(),
                '--universe-id', universeId.toString(),
                '--output-json'
            ];

            if (materialId !== undefined) {
                args.push('--material-id', materialId.toString());
            }

            // Execute Python script
            const result = cp.spawnSync(support.pythonPath, args, {
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'pipe'],
                maxBuffer: 100 * 1024 * 1024 // 100MB buffer for large geometries
            });

            const warnings: string[] = [];

            if (result.stderr) {
                const stderr = result.stderr.toString().trim();
                if (stderr && !stderr.includes('Warning')) {
                    warnings.push(`Python stderr: ${stderr.substring(0, 500)}`);
                }
            }

            // Parse JSON output
            const output = result.stdout.toString().trim();
            const lines = output.split('\n');
            const jsonLine = lines.find((l: string) => l.startsWith('{') && l.includes('"success"'));
            
            if (jsonLine) {
                try {
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
                } catch (parseError) {
                    const msg = parseError instanceof Error ? parseError.message : String(parseError);
                    warnings.push(`JSON parse error: ${msg}`);
                }
            }

            // If no JSON found, return error with partial output
            return {
                success: false,
                error: `Failed to parse CAD import result. Output: ${output.substring(0, 200)}...`,
                warnings
            };

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

    private getUnitFactor(units: string): number {
        const factors: Record<string, number> = {
            'mm': 0.1,
            'cm': 1.0,
            'm': 100.0,
            'in': 2.54,
            'ft': 30.48
        };
        return factors[units] ?? 1.0;
    }

    /**
     * Find the CAD importer Python script.
     * Follows the same pattern as nuke-visualizer.
     */
    private findCADImporterScript(): string {
        const extensionPath = this.getExtensionPath();
        const scriptPath = path.resolve(extensionPath, 'python/cad_importer.py');
        
        if (fs.existsSync(scriptPath)) {
            return scriptPath;
        }

        // Fallback search in common locations
        const fallbackPaths = [
            path.resolve(__dirname, '../../python/cad_importer.py'),
            path.resolve(process.cwd(), 'extensions/openmc-studio/python/cad_importer.py'),
            path.resolve(__dirname, '../../../../extensions/openmc-studio/python/cad_importer.py'),
        ];
        
        for (const fp of fallbackPaths) {
            if (fs.existsSync(fp)) {
                return fp;
            }
        }

        return scriptPath;
    }

    /**
     * Get the extension root path.
     */
    private getExtensionPath(): string {
        try {
            return path.dirname(require.resolve('openmc-studio/package.json'));
        } catch (e) {
            // Fallback to __dirname if require.resolve fails
            return path.resolve(__dirname, '../..');
        }
    }
}
