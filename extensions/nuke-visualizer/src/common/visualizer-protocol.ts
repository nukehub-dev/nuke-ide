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

export const VisualizerBackendService = Symbol('VisualizerBackendService');

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
 * Mirrors the state in Python backend (visualizer_app.py).
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

export interface VisualizerBackendService {
    // === Server Management ===
    
    /** Start a new visualizer server for the given file */
    startServer(filePath?: string, config?: PythonConfig): Promise<ServerInfo>;
    
    /** Stop the visualizer server on the given port */
    stopServer(port: number): Promise<void>;
    
    /** Convert DAGMC .h5m file to VTK format */
    convertDagmc(filePath: string): Promise<string>;
    
    /** Check Python environment for dependencies */
    checkEnvironment(config?: PythonConfig): Promise<EnvironmentInfo>;
    
    /** Set the client for receiving log messages */
    setClient(client: VisualizerClient): void;
    
    // === Visualization Controls ===
    
    /** Get current visualization state from a running server */
    getVisualizationState(port: number): Promise<VisualizationState>;
    
    /** Update visualization state (opacity, representation, etc.) */
    updateVisualizationState(port: number, state: Partial<VisualizationState>): Promise<void>;
    
    /** Reset camera to default position */
    resetCamera(port: number): Promise<boolean>;
    
    /** Set camera to a preset view */
    setCameraView(port: number, viewType: CameraViewType): Promise<boolean>;
    
    // === Export ===
    
    /** Capture screenshot of current view */
    captureScreenshot(port: number, options: ScreenshotOptions): Promise<ScreenshotResult>;
}

export interface VisualizerClient {
    log(message: string): void;
    error(message: string): void;
    onServerStop(port: number): void;
}

export const VISUALIZER_BACKEND_PATH = '/services/visualizer';

// === Color Map Presets ===

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
