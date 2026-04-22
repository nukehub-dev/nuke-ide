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

import { PackageDependency } from 'nuke-core/lib/common';

export const VisualizerBackendService = Symbol('VisualizerBackendService');

/** Default package requirements for base visualizer (VTK/Paraview) operations */
export const BASE_VISUALIZER_REQUIREMENTS: PackageDependency[] = [
    { name: 'trame', submodule: 'app', required: true },
    { name: 'paraview', submodule: 'simple', required: true, condaOnly: true },
    { name: 'pydagmc', required: false, installCommand: 'pip install git+https://github.com/svalinn/pydagmc' },
    { name: 'moab', required: false, extraIndexUrl: 'https://shimwell.github.io/wheels' },
    { name: 'gmsh', required: false }
];

export interface PythonConfig {
    pythonPath?: string;
    condaEnv?: string;
}

export interface EnvironmentInfo {
    pythonPath: string;
    pythonVersion: string;
    paraviewInstalled: boolean;
    paraviewVersion?: string;
    trameInstalled: boolean;
    trameVersion?: string;
    moabInstalled: boolean;
    moabVersion?: string;
    warning?: string;
}

/**
 * Visualization state for interactive controls.
 * Mirrors the state in Python backend (server.py base.serve).
 */
export interface VisualizationState {
    /** Opacity value between 0.0 and 1.0 */
    opacity: number;

    /** Surface representation type */
    representation: RepresentationType;

    /** Field to color by, or 'Solid Color' */
    colorBy: string;

    /** Available data arrays for coloring */
    availableArrays: string[];

    /** Color map preset name */
    colorMap: string;

    /** Whether to show the scalar bar/legend */
    showScalarBar: boolean;

    /** Whether the clip plane is enabled */
    clipEnabled: boolean;

    /** Clip plane origin coordinates */
    clipOrigin: [number, number, number];

    /** Clip plane normal vector */
    clipNormal: [number, number, number];

    /** Whether to invert the clip */
    clipInvert: boolean;

    /** Background color [R, G, B] with values 0-1 */
    backgroundColor: [number, number, number];
}

/** Surface representation types */
export type RepresentationType =
    | 'Surface'
    | 'Surface with Edges'
    | 'Wireframe'
    | 'Points';

/** Camera preset views */
export type CameraViewType =
    | 'isometric'
    | 'front'
    | 'back'
    | 'left'
    | 'right'
    | 'top'
    | 'bottom';

/** Screenshot export options */
export interface ScreenshotOptions {
    /** Output format */
    format: 'png' | 'jpg' | 'svg' | 'pdf';

    /** Resolution [width, height] or null for current viewport */
    resolution?: [number, number];

    /** Use transparent background */
    transparent?: boolean;
}

/** Screenshot export result */
export interface ScreenshotResult {
    /** Base64 encoded image data */
    base64?: string;

    /** File path if saved to disk */
    filePath?: string;

    /** Error message if failed */
    error?: string;
}

export interface ServerInfo {
    port: number;
    url: string;
    warning?: string;
}

/**
 * Backend RPC service for the base 3D mesh/DAGMC visualizer.
 *
 * Implemented by `VisualizerBackendServiceImpl` in the Node backend.
 * Frontend accesses it via WebSocket RPC proxy bound to {@link VISUALIZER_BACKEND_PATH}.
 *
 * @see src/node/visualizer-backend-service.ts
 */
export interface VisualizerBackendService {
    // === Server Management ===

    /**
     * Start a new Trame visualizer server for the given file.
     * Spawns a Python process running `python/server.py base.serve`.
     *
     * @param filePath Path to file to visualize (VTK, H5M, STL, etc.)
     * @param config Optional Python environment override
     * @param theme UI theme — 'dark' or 'light', propagated to the Trame app
     * @returns Server info including allocated port and URL
     */
    startServer(filePath?: string, config?: PythonConfig, theme?: string): Promise<ServerInfo>;

    /**
     * Stop the visualizer server running on the given port.
     * Kills the associated Python process and frees the port.
     */
    stopServer(port: number): Promise<void>;

    /**
     * Convert a DAGMC H5M file to VTK format for visualization.
     * Runs `python server.py base.convert-dagmc` via MOAB/PyDAGMC.
     *
     * @param filePath Path to the H5M file
     * @param volumeId Optional volume ID to extract only that volume
     * @returns Path to the generated VTK file
     */
    convertDagmc(filePath: string, volumeId?: number): Promise<string>;

    /**
     * Convert a STEP/STP/BREP CAD file to VTK format for visualization.
     * Runs `python server.py base.convert-step` via gmsh.
     *
     * @param filePath Path to the STEP/STP/BREP file
     * @returns Path to the generated VTK file
     */
    convertStep(filePath: string): Promise<string>;

    /**
     * Check the configured Python environment for base visualizer dependencies.
     * Reports versions of trame, paraview, and moab if available.
     */
    checkEnvironment(config?: PythonConfig): Promise<EnvironmentInfo>;

    /**
     * Set the client for receiving log messages and server lifecycle events.
     * Called by the RPC framework when a frontend connects.
     */
    setClient(client: VisualizerClient): void;

    // === Visualization Controls (Future API) ===

    /** Get current visualization state from a running server. Placeholder for external control API. */
    getVisualizationState(port: number): Promise<VisualizationState>;

    /** Update visualization state (opacity, representation, etc.). Placeholder for external control API. */
    updateVisualizationState(port: number, state: Partial<VisualizationState>): Promise<void>;

    /** Reset camera to default position. Placeholder for external control API. */
    resetCamera(port: number): Promise<boolean>;

    /** Set camera to a preset view. Placeholder for external control API. */
    setCameraView(port: number, viewType: CameraViewType): Promise<boolean>;

    // === Export ===

    /** Capture screenshot of current view. Placeholder for external control API. */
    captureScreenshot(port: number, options: ScreenshotOptions): Promise<ScreenshotResult>;
}

/**
 * Client-side interface for receiving log streams and lifecycle events
 * from the backend. The frontend provides an implementation of this
 * interface when creating the RPC proxy.
 *
 * @see src/browser/visualizer-frontend-module.ts for the client implementation
 */
export interface VisualizerClient {
    /** Log a standard message (stdout from Python). */
    log(message: string): void;

    /** Log an error message (stderr from Python or backend failure). */
    error(message: string): void;

    /** Show a warning toast to the user. */
    warn(message: string): void;

    /** Called when a visualization server process exits. */
    onServerStop(port: number): void;
}

export const VISUALIZER_BACKEND_PATH = '/services/visualizer';

/** Generic Plotly figure definition for scientific plotting */
export interface PlotlyFigure {
    data: Partial<Plotly.Data>[];
    layout: Partial<Plotly.Layout>;
    config?: Partial<Plotly.Config>;
    title?: string;
    id?: string;
}

/** Available color map presets matching ParaView presets */
export const COLOR_MAP_PRESETS = [
    'Viridis',
    'Plasma',
    'Inferno',
    'Magma',
    'Cividis',
    'Cool to Warm',
    'Cool to Warm (Extended)',
    'Warm to Cool',
    'Black-Body Radiation',
    'X Ray',
    'Blue to Red Rainbow',
    'Red to Blue Rainbow',
    'Rainbow Desaturated',
    'Rainbow Uniform',
    'Jet',
    'Hot',
    'Cool',
    'Spectral',
    'RdYlBu',
    'RdYlGn',
    'PuOr',
    'PRGn',
    'BrBG',
    'PiYG',
    'RdBu',
    'Seismic',
    'Balance',
    'Twilight',
    'Haze',
    'Earth',
    'Ocean',
] as const;

/** Default visualization state */
export const DEFAULT_VISUALIZATION_STATE: VisualizationState = {
    opacity: 1.0,
    representation: 'Surface',
    colorBy: 'Solid Color',
    availableArrays: ['Solid Color'],
    colorMap: 'Cool to Warm',
    showScalarBar: true,
    clipEnabled: false,
    clipOrigin: [0, 0, 0],
    clipNormal: [1, 0, 0],
    clipInvert: false,
    backgroundColor: [0.1, 0.1, 0.15],
};
