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

export interface VisualizerBackendService {
    startServer(filePath?: string, config?: PythonConfig): Promise<{ port: number, url: string, warning?: string }>;
    stopServer(port: number): Promise<void>;
    convertDagmc(filePath: string): Promise<string>;
    checkEnvironment(config?: PythonConfig): Promise<EnvironmentInfo>;
    setClient(client: VisualizerClient): void;
}

export interface VisualizerClient {
    log(message: string): void;
    error(message: string): void;
    onServerStop(port: number): void;
}

export const VISUALIZER_BACKEND_PATH = '/services/visualizer';
