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

export const TrameBackendService = Symbol('TrameBackendService');

export interface PythonConfig {
    pythonPath?: string;
    condaEnv?: string;
}

export interface TrameBackendService {
    startServer(filePath?: string, config?: PythonConfig): Promise<{ port: number; url: string }>;
    stopServer(port: number): Promise<void>;
}

export const TRAME_BACKEND_PATH = '/services/trame';
