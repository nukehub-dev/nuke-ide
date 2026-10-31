// *****************************************************************************
// Copyright (C) 2026 NukeHub and others.
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
 * Nuke Capability Delegate Client
 *
 * Frontend implementation of the MCP delegate. It projects enabled
 * capabilities from the nuke-core registry and invokes them with the same
 * validation and ambient context as the in-process AI tool bridge. Resource
 * reads go through `NukeResourceService`, which owns the scoped `nuke://`
 * catalog; the backend never reads files directly.
 *
 * @module nuke-ai/browser/mcp
 */

import { inject, injectable } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { RemoteConnectionProvider, ServiceConnectionProvider } from '@theia/core/lib/browser/messaging';
import {
    NukeCapability,
    NukeCapabilityContextService,
    NukeCapabilityRegistry,
    NukeCapabilityResult
} from 'nuke-core/lib/common/nuke-capability-protocol';
import { validateCapabilityInput } from 'nuke-core/lib/browser/capabilities/nuke-capability-registry';
import {
    NukeCapabilityDelegate,
    NukeCapabilityDelegateClient,
    NukeCapabilityDescriptor,
    NukeCapabilityDelegatePath
} from '../../common/nuke-capability-delegate';
import { NukeResourceService } from '../resources/nuke-resource-service';

/** Project a live capability to the handler-free shape sent over RPC. */
export function toCapabilityDescriptor(capability: NukeCapability): NukeCapabilityDescriptor {
    return {
        id: capability.id,
        title: capability.title,
        description: capability.description,
        category: capability.category,
        inputSchema: capability.inputSchema,
        outputSchema: capability.outputSchema,
        risk: capability.risk,
        annotations: capability.annotations,
        requiresConfirmation: capability.requiresConfirmation,
        undoable: capability.undoable,
        tags: capability.tags,
        examples: capability.examples
    };
}

/** Serve the MCP backend's list/invoke/resource calls from the frontend. */
@injectable()
export class NukeCapabilityDelegateClientImpl implements NukeCapabilityDelegateClient {
    constructor(
        @inject(NukeCapabilityRegistry) protected readonly capabilityRegistry: NukeCapabilityRegistry,
        @inject(NukeCapabilityContextService) protected readonly contextService: NukeCapabilityContextService,
        @inject(NukeResourceService) protected readonly resourceService: NukeResourceService
    ) {}

    async listCapabilities(): Promise<NukeCapabilityDescriptor[]> {
        await this.capabilityRegistry.ready;
        const context = await this.contextService.getContext();
        return this.capabilityRegistry.getEnabled(context).map(toCapabilityDescriptor);
    }

    async invoke(capabilityId: string, input: unknown): Promise<NukeCapabilityResult> {
        await this.capabilityRegistry.ready;
        const capability = this.capabilityRegistry.get(capabilityId);
        if (!capability) {
            return { ok: false, message: `Unknown capability: ${capabilityId}.` };
        }
        let context;
        try {
            context = await this.contextService.getContext();
        } catch (error) {
            return { ok: false, message: `Unable to collect NukeIDE context: ${errorMessage(error)}` };
        }
        if (capability.when) {
            try {
                if (!capability.when(context)) {
                    return { ok: false, message: `Capability ${capabilityId} is not available in the current context.` };
                }
            } catch (error) {
                return { ok: false, message: `Capability ${capabilityId} availability check failed: ${errorMessage(error)}` };
            }
        }
        const validationErrors = validateCapabilityInput(capability, input);
        if (validationErrors.length > 0) {
            return { ok: false, message: `Invalid input for ${capabilityId}: ${validationErrors.join('; ')}` };
        }
        try {
            return await capability.invoke(input, context);
        } catch (error) {
            return { ok: false, message: `Capability ${capabilityId} failed: ${errorMessage(error)}` };
        }
    }

    readResource(uri: string): Promise<string> {
        return this.resourceService.read(uri);
    }
}

/**
 * Open the delegate RPC channel once the application starts. The proxy keeps
 * the frontend client registered with the backend so the MCP endpoint can call
 * capabilities while the IDE is running.
 */
@injectable()
export class NukeCapabilityDelegateConnectionContribution implements FrontendApplicationContribution {
    protected proxy: NukeCapabilityDelegate | undefined;

    constructor(
        @inject(RemoteConnectionProvider) protected readonly connectionProvider: ServiceConnectionProvider,
        @inject(NukeCapabilityDelegateClient) protected readonly client: NukeCapabilityDelegateClient
    ) {}

    onStart(): void {
        this.proxy = this.connectionProvider.createProxy<NukeCapabilityDelegate>(NukeCapabilityDelegatePath, this.client);
    }

    onStop(): void {
        this.proxy = undefined;
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
