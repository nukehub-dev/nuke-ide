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
 * OpenMC Studio Backend Module
 * 
 * This is the entry point for the OpenMC Studio Theia extension on the backend (Node.js).
 * It configures dependency injection and registers the backend service.
 * 
 * @module openmc-studio/node
 */

import { ContainerModule, interfaces } from '@theia/core/shared/inversify';
import { ConnectionHandler, JsonRpcConnectionHandler } from '@theia/core/lib/common';
import { BackendApplicationContribution } from '@theia/core/lib/node';

// Protocol imports
import {
    OpenMCStudioBackendService,
    OPENMC_STUDIO_BACKEND_PATH,
    OpenMCStudioClient
} from '../common/openmc-studio-protocol';

// Service imports
import { OpenMCStudioBackendServiceImpl } from './openmc-studio-backend-service';
import { OpenMCRunnerService } from './openmc-runner-service';
import { XMLGenerationService } from './xml-generation-service';
import { OpenMCCADImportService } from './cad-import-service';
import { DAGMCEditorService } from './dagmc-editor-service';
import { OptimizationBackendService } from './optimization-backend-service';
import { OpenMCValidationBackendService } from './openmc-validation-backend-service';
import { RpcBufferConfiguration } from './rpc-buffer-config';

// ============================================================================
// Dependency Injection Bindings
// ============================================================================

export default new ContainerModule((bind: interfaces.Bind, unbind: interfaces.Unbind, isBound: interfaces.IsBound, rebind: interfaces.Rebind) => {
    console.log('[OpenMC Studio] Initializing backend module...');

    // ============================================================================
    // Backend Services
    // ============================================================================
    
    // XML generation service
    bind(XMLGenerationService).toSelf().inSingletonScope();
    
    // OpenMC runner service
    bind(OpenMCRunnerService).toSelf().inSingletonScope();
    
    // CAD import service (uses nuke-core for Python detection)
    bind(OpenMCCADImportService).toSelf().inSingletonScope();
    
    // DAGMC Editor service (uses pydagmc for DAGMC editing)
    bind(DAGMCEditorService).toSelf().inSingletonScope();
    
    // Optimization Backend service (for parameter sweeps)
    bind(OptimizationBackendService).toSelf().inSingletonScope();
    
    // OpenMC validation service (uses nuke-core for environment detection)
    bind(OpenMCValidationBackendService).toSelf().inSingletonScope();
    
    // Main backend service implementation
    bind(OpenMCStudioBackendServiceImpl).toSelf().inSingletonScope();
    
    // Bind the service interface to the implementation
    bind(OpenMCStudioBackendService).toService(OpenMCStudioBackendServiceImpl);

    // ============================================================================
    // JSON-RPC Connection Handler
    // ============================================================================
    
    // Create connection handler for frontend-backend communication
    bind<ConnectionHandler>(ConnectionHandler).toDynamicValue(({ container }) => 
        new JsonRpcConnectionHandler<OpenMCStudioClient>(OPENMC_STUDIO_BACKEND_PATH, client => {
            const backendService = container.get<OpenMCStudioBackendServiceImpl>(OpenMCStudioBackendServiceImpl);
            backendService.setClient(client);
            return backendService;
        })
    ).inSingletonScope();

    // ============================================================================
    // Application Contribution
    // ============================================================================
    
    // Configure RPC buffer limits to prevent "Max disconnected buffer size exceeded" errors
    bind(BackendApplicationContribution).to(RpcBufferConfiguration).inSingletonScope();
    
    // Contribute to backend application lifecycle
    bind(BackendApplicationContribution).toDynamicValue(({ container }) => 
        container.get(OpenMCStudioBackendServiceImpl)
    ).inSingletonScope();

    console.log('[OpenMC Studio] Backend module initialized');
});

// ============================================================================
// Re-export for convenience
// ============================================================================

export { OpenMCStudioBackendServiceImpl } from './openmc-studio-backend-service';
export { OpenMCRunnerService } from './openmc-runner-service';
export { XMLGenerationService } from './xml-generation-service';
export { OpenMCCADImportService } from './cad-import-service';
export { DAGMCEditorService } from './dagmc-editor-service';
export { OpenMCValidationBackendService, OpenMCValidationResult } from './openmc-validation-backend-service';
