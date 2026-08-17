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
 * JSON-RPC protocol shared between the nuke-cad frontend and backend.
 *
 * @module nuke-cad/common
 */

export const NukeCadBackendServicePath = '/services/nuke-cad';

export const NukeCadBackendService = Symbol('NukeCadBackendService');

/** Axis-aligned bounding box returned by the geometry service. */
export interface CadBoundingBox {
    readonly min: number[];
    readonly max: number[];
}

/** Mesh quality report returned by the meshing service. */
export interface MeshQualityReport {
    readonly elementCount: number;
    readonly nodeCount: number;
    readonly elementTypes: Record<string, number>;
    readonly blocks: { readonly name: string; readonly elementCount: number; readonly dimension: number }[];
    readonly quality: {
        readonly minDihedralDeg: number;
        readonly maxDihedralDeg: number;
        readonly minAspectRatio: number;
        readonly maxAspectRatio: number;
        readonly meanAspectRatio: number;
    };
}

/** Result of a geometry build request. */
export interface GeometryBuildResult {
    /** Whether the build succeeded. */
    readonly success: boolean;
    /** Human-readable error message when ``success`` is false. */
    readonly error?: string;
    /** Full traceback when available. */
    readonly traceback?: string;
    /** Absolute path to the source script. */
    readonly scriptPath?: string;
    /** Absolute path to the output directory. */
    readonly outputDirectory?: string;
    /** Absolute path to the generated STEP file. */
    readonly stepPath?: string;
    /** Absolute path to the generated tessellation stream. */
    readonly tessPath?: string;
    /** Number of solid volumes in the model. */
    readonly solidCount?: number;
    /** Total number of faces across all solids. */
    readonly faceCount?: number;
    /** Total number of triangles in the tessellation. */
    readonly triangleCount?: number;
    /** Model bounding box. */
    readonly boundingBox?: CadBoundingBox;
    /** Diagnostics and non-fatal issues. */
    readonly warnings?: string[];
    /** Region manifest payload when one exists and is valid. */
    readonly regionManifest?: RegionManifestData;
    /** Mapping of selector -> 1-based solid indices. */
    readonly selectorMap?: Record<string, number[]>;
    /** Absolute path to the generated DAGMC .h5m file. */
    readonly dagmcPath?: string;
    /** Whether the DAGMC export succeeded (non-fatal if false). */
    readonly dagmcSuccess?: boolean;
    /** DAGMC export warnings. */
    readonly dagmcWarnings?: string[];
    /** DAGMC export error when dagmcSuccess is false. */
    readonly dagmcError?: string;
    /** Absolute path to the generated gmsh native mesh. */
    readonly meshPath?: string;
    /** Absolute path to the generated ExodusII mesh. */
    readonly exodusPath?: string;
    /** Absolute path to the generated CalculiX/Abaqus input. */
    readonly inpPath?: string;
    /** Absolute path to the generated VTK unstructured grid. */
    readonly vtkPath?: string;
    /** Absolute path to the generated mesh quality report. */
    readonly meshReportPath?: string;
    /** Whether the FEM mesh export succeeded (non-fatal if false). */
    readonly meshSuccess?: boolean;
    /** FEM mesh export warnings. */
    readonly meshWarnings?: string[];
    /** FEM mesh export error when meshSuccess is false. */
    readonly meshError?: string;
    /** FEM mesh quality report. */
    readonly meshReport?: MeshQualityReport;
    /** Captured stderr/stdout from the geometry service. */
    output?: string;
}

/** Request to build/update geometry from a script. */
export interface GeometryBuildRequest {
    /** Absolute path to the build123d/CadQuery script. */
    readonly scriptPath: string;
    /** Optional output directory; defaults to the script's directory. */
    readonly outputDirectory?: string;
    /** BRepMesh faceting tolerance. */
    readonly tolerance?: number;
    /** Meshing engine: ``gmsh`` or ``netgen``. */
    readonly meshEngine?: string;
    /** Global target element size for the volume mesh. */
    readonly meshSize?: number;
    /** Minimum element size for the volume mesh. */
    readonly meshMinSize?: number;
    /** Maximum element size for the volume mesh. */
    readonly meshMaxSize?: number;
    /** Element order (1 = linear, 2 = quadratic). */
    readonly meshOrder?: number;
}

/** Single volume entry in the region manifest. */
export interface RegionManifestVolume {
    readonly selector: string;
    readonly name?: string;
    readonly material?: string;
    readonly tags?: string[];
    /** Optional per-region target element size for meshing. */
    readonly meshSize?: number;
}

/** Single surface entry in the region manifest. */
export interface RegionManifestSurface {
    readonly selector: string;
    readonly name?: string;
    readonly role?: string;
}

/** Region manifest payload. */
export interface RegionManifestData {
    readonly version: number;
    readonly volumes: RegionManifestVolume[];
    readonly surfaces: RegionManifestSurface[];
}

/** Backend service exposed via JSON-RPC. */
export interface NukeCadBackendService {
    /**
     * Build/update geometry from a script and return artifact paths + metadata.
     */
    buildGeometry(request: GeometryBuildRequest): Promise<GeometryBuildResult>;

    /**
     * Check whether the active Python environment has the CAD toolchain.
     */
    checkCadEnvironment(): Promise<{ readonly ready: boolean; readonly missing: string[] }>;
}
