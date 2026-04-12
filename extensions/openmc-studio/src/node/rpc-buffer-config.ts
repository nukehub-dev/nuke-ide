/*******************************************************************************
 * Copyright (C) 2024 NukeHub and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * SPDX-License-Identifier: EPL-2.0
 *******************************************************************************/

import { injectable } from '@theia/core/shared/inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';

/**
 * Configures RPC buffer limits to prevent "Max disconnected buffer size exceeded" errors.
 * 
 * This error occurs when the frontend disconnects but the backend keeps sending messages.
 * The messages accumulate in a buffer until it overflows (default 100MB).
 * 
 * Solution: Increase the buffer size limit for disconnected clients.
 */
@injectable()
export class RpcBufferConfiguration implements BackendApplicationContribution {
    initialize(): void {
        // Set environment variable to increase disconnected buffer size to 500MB
        // This prevents crashes during long-running simulations when user refreshes/closes browser
        if (!process.env.THEIA_RPC_MAX_BUFFER_SIZE) {
            process.env.THEIA_RPC_MAX_BUFFER_SIZE = '524288000'; // 500MB in bytes
        }
        
        // Also set the disconnected buffer size
        if (!process.env.THEIA_RPC_MAX_DISCONNECTED_BUFFER_SIZE) {
            process.env.THEIA_RPC_MAX_DISCONNECTED_BUFFER_SIZE = '524288000'; // 500MB
        }
        
        console.log('[OpenMC] RPC buffer limits configured for simulation workloads');
    }
}
