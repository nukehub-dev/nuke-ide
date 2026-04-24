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
import { resolvePythonScript } from 'nuke-core/lib/node/utils/script-resolver';
import { NukeCoreBackendService, NukeCoreBackendServiceInterface } from 'nuke-core/lib/common/nuke-core-protocol';
import * as fs from 'fs';

// Use CommonJS require for Node.js modules to ensure proper externalization by webpack
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cp = require('child_process');

/** Supported CAD file formats */
export type CADFileFormat = 'step' | 'iges' | 'stp' | 'igs' | 'brep' | 'stl' | 'h5m' | 'dagmc';

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
        /** Whether to auto-adjust faceting tolerance for large models */
        autoAdjustTolerance?: boolean;
        /** Material assignment for imported geometry */
        materialId?: number;
        /** Universe to place the imported geometry in */
        universeId?: number;
    };
}

// Import DAGMCInfo from schema
import type { DAGMCInfo, DAGMCVolume, DAGMCMaterialInfo } from '../common/openmc-state-schema';
export { DAGMCInfo, DAGMCVolume, DAGMCMaterialInfo };

/** CAD import result */
export interface CADImportResult {
    /** Whether import was successful */
    success: boolean;
    /** Error message if failed */
    error?: string;
    /** Warning messages */
    warnings?: string[];
    /** Imported surfaces (CSG conversion) */
    surfaces?: {
        type: string;
        coefficients: number[];
        name?: string;
    }[];
    /** Imported cells (CSG conversion) */
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
        edgeCount?: number;
        vertexCount?: number;
        materials?: string[];
        facetingTolerance?: number;
        dagmc?: boolean;
        // DAGMC-specific fields
        fileName?: string;
        fileSizeMB?: number;
        volumeCount?: number;
        surfaceCount?: number;
        totalTriangles?: number;
        totalSurfaceArea?: number;
        materialsData?: Record<string, { volumeCount: number; totalTriangles: number }>;
        volumesData?: Array<{
            id: number;
            material: string;
            numTriangles: number;
            boundingBox?: { min: number[]; max: number[] };
        }>;
        groups?: string[];
    };
    /** Conversion summary */
    summary?: {
        surfacesCreated: number;
        cellsCreated: number;
        approximationsMade: number;
    };
    /** Whether NURBS were detected and DAGMC fallback was used */
    dagmc?: boolean;
    /** Path to generated DAGMC file when NURBS fallback is used */
    dagmcFile?: string;
    /** Whether NURBS surfaces were detected in the source CAD */
    nurbsDetected?: boolean;
    /** DAGMC model information (when importing .h5m files) */
    dagmcInfo?: DAGMCInfo;
}

/**
 * CAD Import Service for OpenMC
 *
 * Backend service for importing CAD files (STEP/IGES) and converting them
 * to OpenMC-compatible CSG geometry, or importing DAGMC files directly.
 *
 * Uses nuke-core's detectPythonWithRequirements for robust Python/CAD detection.
 *
 * @module openmc-studio/node
 * @see {@link OpenMCStudioBackendService.importCAD}
 * @see {@link OpenMCStudioBackendService.checkCADSupport}
 */
@injectable()
export class OpenMCCADImportService {

    @inject(NukeCoreBackendService)
    protected readonly coreService!: NukeCoreBackendServiceInterface;

    // ============================================================================
    // CAD Import
    // ============================================================================

    /**
     * Import a CAD file and convert to OpenMC-compatible geometry.
     * @param request - CAD import request with file path and options
     * @returns Import result with surfaces, cells, and metadata
     */
    async importCAD(request: CADImportRequest): Promise<CADImportResult> {
        try {
            // Detect format if not specified
            const format = request.format || this.detectFormatFromPath(request.filePath);
            if (!format) {
                return {
                    success: false,
                    error: 'Unable to detect CAD file format from path. Please specify format explicitly.'
                };
            }

            // Handle DAGMC files differently - they are used directly, not converted
            if (format === 'h5m' || format === 'dagmc') {
                return this.importDAGMC(request.filePath);
            }

            // Check CAD support for non-DAGMC formats
            const support = await this.checkCADSupport();
            if (!support.available || !support.pythonPath) {
                return {
                    success: false,
                    error: 'CAD import requires gmsh or OpenCASCADE.'
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

            // Pass faceting tolerance through if provided
            if (request.options?.tolerance !== undefined) {
                args.push('--faceting-tol', request.options.tolerance.toString());
            }

            // Disable auto-adjustment if requested
            if (request.options?.autoAdjustTolerance === false) {
                args.push('--no-auto-adjust-tol');
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
                    const result: CADImportResult = {
                        success: parsed.success ?? false,
                        error: parsed.error,
                        warnings: [...warnings, ...(parsed.warnings || [])],
                        surfaces: parsed.surfaces,
                        cells: parsed.cells,
                        boundingBox: parsed.boundingBox,
                        fileInfo: parsed.fileInfo,
                        summary: parsed.summary,
                        dagmc: parsed.dagmc ?? false,
                        dagmcFile: parsed.dagmcFile,
                        nurbsDetected: parsed.nurbsDetected ?? false,
                    };

                    // If DAGMC fallback was used, populate dagmcInfo from the generated file
                    if (result.dagmc && result.dagmcFile && fs.existsSync(result.dagmcFile)) {
                        try {
                            const dagmcResult = await this.importDAGMC(result.dagmcFile);
                            if (dagmcResult.success && dagmcResult.dagmcInfo) {
                                result.dagmcInfo = dagmcResult.dagmcInfo;
                                // Merge fileInfo from DAGMC import
                                if (dagmcResult.fileInfo) {
                                    result.fileInfo = { ...result.fileInfo, ...dagmcResult.fileInfo };
                                }
                            }
                        } catch (dagmcErr) {
                            const msg = dagmcErr instanceof Error ? dagmcErr.message : String(dagmcErr);
                            result.warnings = result.warnings || [];
                            result.warnings.push(`DAGMC info extraction failed: ${msg}`);
                        }
                    }

                    return result;
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
        return ['step', 'iges', 'stp', 'igs', 'brep', 'stl', 'h5m', 'dagmc'];
    }

    /**
     * Import DAGMC file (.h5m).
     * DAGMC files are used directly in OpenMC, not converted to CSG.
     * We just extract information about the file.
     */
    private async importDAGMC(filePath: string): Promise<CADImportResult> {
        const warnings: string[] = [];
        
        try {
            // Find Python with pydagmc/pymoab
            const result = await this.coreService.detectPythonWithRequirements({
                requiredPackages: [
                    { name: 'pymoab', required: false },
                    { name: 'pydagmc', required: false }
                ],
            });

            if (!result.success || !result.command) {
                return {
                    success: false,
                    error: 'DAGMC import requires pydagmc and pymoab.'
                };
            }

            const pythonPath = result.command;
            
            // Find the DAGMC info script
            const scriptPath = this.findDAGMCInfoScript();
            if (!fs.existsSync(scriptPath)) {
                return {
                    success: false,
                    error: `DAGMC info script not found at: ${scriptPath}`
                };
            }

            // Execute DAGMC info script
            const args = [scriptPath, filePath, '--output-json'];
            
            const execResult = cp.spawnSync(pythonPath, args, {
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'pipe'],
                maxBuffer: 50 * 1024 * 1024
            });

            if (execResult.stderr) {
                const stderr = execResult.stderr.toString().trim();
                if (stderr) {
                    warnings.push(`pymoab stderr: ${stderr.substring(0, 200)}`);
                }
            }

            // Parse JSON output
            const output = execResult.stdout.toString().trim();
            const lines = output.split('\n');
            const jsonLine = lines.find((l: string) => l.startsWith('{') && l.includes('"success"'));
            
            if (jsonLine) {
                const parsed = JSON.parse(jsonLine);
                
                if (!parsed.success) {
                    return {
                        success: false,
                        error: parsed.error || 'Failed to read DAGMC file',
                        warnings
                    };
                }

                // Build DAGMCInfo object
                const dagmcInfo: DAGMCInfo = {
                    filePath: filePath,
                    fileName: parsed.fileName || filePath.split('/').pop() || 'unknown.h5m',
                    volumeCount: parsed.volumeCount || 0,
                    surfaceCount: parsed.surfaceCount || 0,
                    vertices: parsed.totalTriangles || 0,
                    materials: parsed.materials || {},
                    volumes: (parsed.volumes || []).map((v: any) => ({
                        id: v.id,
                        material: v.material,
                        numTriangles: v.numTriangles,
                        boundingBox: {
                            min: v.boundingBox?.min || [0, 0, 0],
                            max: v.boundingBox?.max || [0, 0, 0]
                        }
                    })),
                    boundingBox: {
                        min: parsed.boundingBox?.min || [0, 0, 0],
                        max: parsed.boundingBox?.max || [0, 0, 0]
                    },
                    fileSizeMB: parsed.fileSizeMB,
                    totalSurfaceArea: parsed.totalSurfaceArea
                };

                return {
                    success: true,
                    warnings,
                    fileInfo: {
                        format: 'h5m',
                        units: 'cm',
                        solidCount: parsed.volumeCount || 0,
                        faceCount: parsed.surfaceCount || 0,
                        vertexCount: parsed.totalTriangles || 0,
                        materials: parsed.materials ? Object.keys(parsed.materials) : [],
                        facetingTolerance: parsed.facetingTolerance,
                        dagmc: true,
                        // Rich DAGMC-specific data
                        fileName: parsed.fileName,
                        fileSizeMB: parsed.fileSizeMB,
                        volumeCount: parsed.volumeCount,
                        surfaceCount: parsed.surfaceCount,
                        totalTriangles: parsed.totalTriangles,
                        totalSurfaceArea: parsed.totalSurfaceArea,
                        materialsData: parsed.materials,
                        volumesData: parsed.volumes,
                        groups: parsed.groups
                    },
                    boundingBox: parsed.boundingBox,
                    dagmcInfo
                };
            }

            return {
                success: false,
                error: 'Failed to parse DAGMC info result',
                warnings
            };

        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            return {
                success: false,
                error: `DAGMC import failed: ${msg}`,
                warnings
            };
        }
    }

    /**
     * Find the DAGMC info Python script.
     */
    private findDAGMCInfoScript(): string {
        const resolved = resolvePythonScript({ packageName: 'openmc-studio', scriptName: 'dagmc_info.py' });
        if (!resolved) {
            throw new Error('Python script not found: dagmc_info.py');
        }
        return resolved;
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
            'stl': 'stl',
            'h5m': 'h5m'
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
     */
    private findCADImporterScript(): string {
        const resolved = resolvePythonScript({ packageName: 'openmc-studio', scriptName: 'cad_importer.py' });
        if (!resolved) {
            throw new Error('Python script not found: cad_importer.py');
        }
        return resolved;
    }


}
