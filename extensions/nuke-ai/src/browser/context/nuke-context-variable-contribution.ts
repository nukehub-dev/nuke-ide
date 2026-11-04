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
 * Nuke Context Variable
 *
 * Resolves `#nukeContext` to a compact Markdown snapshot of the active CAD
 * document, OpenMC project, visualizer dataset, and workspace roots. The
 * snapshot is intentionally small so it can stay attached to every chat
 * request without duplicating the capability summaries.
 *
 * @module nuke-ai/browser/context
 */

import { inject, injectable } from '@theia/core/shared/inversify';
import { ILogger } from '@theia/core/lib/common/logger';
import * as path from 'path';
import {
    AIVariable,
    AIVariableContext,
    AIVariableContribution,
    AIVariableResolutionRequest,
    AIVariableResolver,
    AIVariableService,
    ResolvedAIVariable
} from '@theia/ai-core/lib/common/variable-service';
import { NukeCapabilityContext, NukeCapabilityContextService } from 'nuke-core/lib/common/nuke-capability-protocol';
import { isWithinWorkspace } from 'nuke-core/lib/browser/capabilities/nuke-capability-registry';

/** The chat variable that exposes the active NukeIDE context. */
export const NUKE_CONTEXT_VARIABLE: AIVariable = {
    id: 'nuke.context',
    name: 'nukeContext',
    description: 'Active NukeIDE CAD document, OpenMC project, dataset, and workspace roots.',
    isContextVariable: true
};

/** Value returned when the context service cannot provide a snapshot. */
export const CONTEXT_UNAVAILABLE = 'context unavailable';

/** Register and resolve the `#nukeContext` chat variable. */
@injectable()
export class NukeContextVariableContribution implements AIVariableContribution, AIVariableResolver {
    constructor(
        @inject(NukeCapabilityContextService) protected readonly contextService: NukeCapabilityContextService,
        @inject(ILogger) protected readonly logger: ILogger
    ) {}

    registerVariables(service: AIVariableService): void {
        service.registerVariable(NUKE_CONTEXT_VARIABLE);
        service.registerResolver(NUKE_CONTEXT_VARIABLE, this);
    }

    canResolve(request: AIVariableResolutionRequest): number {
        return request.variable.id === NUKE_CONTEXT_VARIABLE.id ? 100 : 0;
    }

    async resolve(request: AIVariableResolutionRequest, _context: AIVariableContext): Promise<ResolvedAIVariable | undefined> {
        try {
            const context = await this.contextService.getContext();
            return { variable: request.variable, value: formatNukeContext(context) };
        } catch (error) {
            this.logger.error('[NukeAi] Failed to resolve #nukeContext:', error);
            return { variable: request.variable, value: CONTEXT_UNAVAILABLE };
        }
    }
}

/** Render the exact compact Markdown block used for `#nukeContext`. */
export function formatNukeContext(context: NukeCapabilityContext): string {
    const roots = context.workspaceRoots ?? [];
    const rootLines = roots.length > 0 ? roots.map((root) => `- ${sanitizeContextValue(root)}`) : ['- none'];
    return [
        `Active CAD document: ${scopedPath(context.activeCadDocument, roots)}`,
        `Active OpenMC project: ${scopedPath(context.activeOpenmcProject, roots)}`,
        `Active dataset: ${scopedPath(context.activeDataset, roots)}`,
        'Workspace roots:',
        ...rootLines
    ].join('\n');
}

/** Never expose an absolute path that lies outside every workspace root. */
function scopedPath(value: string | undefined, roots: readonly string[]): string {
    if (!value) {
        return 'none';
    }
    if (path.isAbsolute(value) && !isWithinWorkspace(value, roots)) {
        return 'none';
    }
    return sanitizeContextValue(value);
}

/** Strip control characters, code ticks, and excessive length from prompt text. */
function sanitizeContextValue(value: string): string {
    const sanitized = value
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/`/g, "'")
        .trim();
    return sanitized.length > 512 ? `${sanitized.slice(0, 509)}...` : sanitized || 'none';
}
