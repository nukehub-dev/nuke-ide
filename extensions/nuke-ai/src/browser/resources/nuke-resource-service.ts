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
 * Nuke Resource Service
 *
 * Exposes read-only `nuke://` descriptors for the active workspace and the
 * packaged skills. Context and project summaries come from the nuke-core
 * capability registry, so this service never imports a domain extension and
 * never guesses at a handler. Skill reads are scoped to the backend-provided
 * skill roots.
 *
 * @module nuke-ai/browser/resources
 */

import { inject, injectable } from '@theia/core/shared/inversify';
import { ILogger } from '@theia/core/lib/common/logger';
import { URI } from '@theia/core/lib/common/uri';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { isValidSkillName, SKILL_FILE_NAME } from '@theia/ai-core/lib/common/skill';
import { isWithinWorkspace } from 'nuke-core/lib/browser/capabilities/nuke-capability-registry';
import {
    NukeCapabilityContext,
    NukeCapabilityContextService,
    NukeCapabilityRegistry,
    NukeCapabilityResult
} from 'nuke-core/lib/common/nuke-capability-protocol';
import { NukeSkillRootCache } from '../skills/nuke-skill-root-cache';

/** A read-only resource offered to external and in-process consumers. */
export interface NukeResourceDescriptor {
    readonly uri: string;
    readonly name: string;
    readonly description: string;
    readonly mimeType: string;
    read(): Promise<string>;
}

const CONTEXT_URI = 'nuke://context';
const CAD_URI = 'nuke://cad/document';
const OPENMC_URI = 'nuke://openmc/project';
const VISUALIZER_URI = 'nuke://visualizer/dataset';
const SKILL_URI_PREFIX = 'nuke://skills/';

const CAD_CAPABILITY = 'nuke.cad.summarizeDocument';
const OPENMC_CAPABILITY = 'nuke.openmc.summarizeProject';
const VISUALIZER_CAPABILITY = 'nuke.viz.summarizeStatepoint';

/** Build resource descriptors and read them on demand. */
@injectable()
export class NukeResourceService {
    constructor(
        @inject(NukeCapabilityContextService) protected readonly contextService: NukeCapabilityContextService,
        @inject(NukeCapabilityRegistry) protected readonly capabilityRegistry: NukeCapabilityRegistry,
        @inject(FileService) protected readonly fileService: FileService,
        @inject(NukeSkillRootCache) protected readonly skillRootCache: NukeSkillRootCache,
        @inject(ILogger) protected readonly logger: ILogger
    ) {}

    /** Return only the descriptors whose condition is currently satisfied. */
    async getResources(): Promise<NukeResourceDescriptor[]> {
        const descriptors: NukeResourceDescriptor[] = [this.contextResource()];
        const context = await this.readContext();
        if (context) {
            this.appendCapabilityResource(
                descriptors,
                context,
                CAD_URI,
                'Nuke CAD document',
                'Build counts, selection, manifest, and diagnostics for the active CAD document.',
                CAD_CAPABILITY,
                context.activeCadDocument,
                'no active CAD document'
            );
            this.appendCapabilityResource(
                descriptors,
                context,
                OPENMC_URI,
                'Nuke OpenMC project',
                'Project name, entity counts, and run settings for the active OpenMC project.',
                OPENMC_CAPABILITY,
                context.activeOpenmcProject,
                'no active OpenMC project'
            );
            this.appendCapabilityResource(
                descriptors,
                context,
                VISUALIZER_URI,
                'Nuke visualizer dataset',
                'Batches, k-effective, and tallies for the active visualizer dataset.',
                VISUALIZER_CAPABILITY,
                context.activeDataset,
                'no active visualizer dataset'
            );
        }
        descriptors.push(...(await this.getSkillResources()));
        return descriptors;
    }

    /** Read one resource by URI. Failures are returned as text, never thrown. */
    async read(uri: string): Promise<string> {
        try {
            switch (uri) {
                case CONTEXT_URI:
                    return await this.readContextJson();
                case CAD_URI:
                    return await this.readCapabilitySummary(CAD_CAPABILITY, uri, 'no active CAD document');
                case OPENMC_URI:
                    return await this.readCapabilitySummary(OPENMC_CAPABILITY, uri, 'no active OpenMC project');
                case VISUALIZER_URI:
                    return await this.readCapabilitySummary(VISUALIZER_CAPABILITY, uri, 'no active visualizer dataset');
                default:
                    if (uri.startsWith(SKILL_URI_PREFIX)) {
                        return await this.readSkill(uri.slice(SKILL_URI_PREFIX.length), uri);
                    }
                    return `Unknown resource: ${uri}`;
            }
        } catch (error) {
            this.logger.error(`[NukeAi] Failed to read resource ${uri}:`, error);
            return `Unable to read ${uri}: ${errorMessage(error)}`;
        }
    }

    protected contextResource(): NukeResourceDescriptor {
        return {
            uri: CONTEXT_URI,
            name: 'Nuke context',
            description: 'Active NukeIDE workspace roots, CAD document, OpenMC project, and visualizer dataset.',
            mimeType: 'application/json',
            read: () => this.read(CONTEXT_URI)
        };
    }

    protected appendCapabilityResource(
        descriptors: NukeResourceDescriptor[],
        context: NukeCapabilityContext,
        uri: string,
        name: string,
        description: string,
        capabilityId: string,
        activePath: string | undefined,
        missingReason: string
    ): void {
        if (!activePath) {
            return;
        }
        if (!this.isCapabilityEnabled(capabilityId, context)) {
            return;
        }
        descriptors.push({
            uri,
            name,
            description,
            mimeType: 'application/json',
            read: () => this.readCapabilitySummary(capabilityId, uri, missingReason)
        });
    }

    protected async readContext(): Promise<NukeCapabilityContext | undefined> {
        try {
            return await this.contextService.getContext();
        } catch (error) {
            this.logger.error('[NukeAi] Failed to read context for resources:', error);
            return undefined;
        }
    }

    protected async readContextJson(): Promise<string> {
        try {
            return JSON.stringify(await this.contextService.getContext(), null, 2);
        } catch (error) {
            this.logger.error('[NukeAi] Failed to read the nuke://context resource:', error);
            return `Unable to read ${CONTEXT_URI}: ${errorMessage(error)}`;
        }
    }

    protected async readCapabilitySummary(capabilityId: string, uri: string, missingReason: string): Promise<string> {
        let context: NukeCapabilityContext;
        try {
            context = await this.contextService.getContext();
        } catch (error) {
            return `Unable to read ${uri}: context unavailable (${errorMessage(error)})`;
        }
        if (!this.isActivityPresent(uri, context)) {
            return `Resource ${uri} is not available: ${missingReason}.`;
        }
        if (!this.isCapabilityEnabled(capabilityId, context)) {
            return `Unable to read ${uri}: the required capability ${capabilityId} is not available.`;
        }
        const capability = this.capabilityRegistry.get(capabilityId);
        if (!capability) {
            return `Unable to read ${uri}: the required capability ${capabilityId} is not available.`;
        }
        let result: NukeCapabilityResult;
        try {
            result = await capability.invoke({}, context);
        } catch (error) {
            this.logger.error(`[NukeAi] Capability ${capabilityId} failed while reading ${uri}:`, error);
            return `Unable to read ${uri}: ${errorMessage(error)}`;
        }
        if (!result.ok) {
            return `Unable to read ${uri}: ${result.message ?? 'the capability reported an error.'}`;
        }
        return formatResourceData(result, uri);
    }

    protected isActivityPresent(uri: string, context: NukeCapabilityContext): boolean {
        switch (uri) {
            case CAD_URI:
                return Boolean(context.activeCadDocument);
            case OPENMC_URI:
                return Boolean(context.activeOpenmcProject);
            case VISUALIZER_URI:
                return Boolean(context.activeDataset);
            default:
                return true;
        }
    }

    protected isCapabilityEnabled(capabilityId: string, context: NukeCapabilityContext): boolean {
        try {
            if (!this.capabilityRegistry.get(capabilityId)) {
                return false;
            }
            return this.capabilityRegistry.getEnabled(context).some((capability) => capability.id === capabilityId);
        } catch (error) {
            this.logger.error(`[NukeAi] Failed to inspect capability ${capabilityId} for resources:`, error);
            return false;
        }
    }

    protected async getSkillResources(): Promise<NukeResourceDescriptor[]> {
        let roots: string[];
        try {
            roots = await this.skillRootCache.getRoots();
        } catch (error) {
            this.logger.error('[NukeAi] Failed to read skill roots for resources:', error);
            return [];
        }
        const resources: NukeResourceDescriptor[] = [];
        const seen = new Set<string>();
        for (const root of roots) {
            for (const name of await this.listSkillNames(root)) {
                if (seen.has(name)) {
                    continue;
                }
                seen.add(name);
                const uri = `${SKILL_URI_PREFIX}${name}`;
                resources.push({
                    uri,
                    name,
                    description: `Skill instructions for ${name}.`,
                    mimeType: 'text/markdown',
                    read: () => this.readSkill(name, uri)
                });
            }
        }
        return resources.sort((left, right) => left.uri.localeCompare(right.uri));
    }

    protected async listSkillNames(root: string): Promise<string[]> {
        const names: string[] = [];
        let children;
        try {
            const stat = await this.fileService.resolve(URI.fromFilePath(root));
            children = stat.children ?? [];
        } catch (error) {
            this.logger.error(`[NukeAi] Failed to list skill root ${root}:`, error);
            return names;
        }
        for (const child of children) {
            if (!child.isDirectory || !isValidSkillName(child.name)) {
                continue;
            }
            try {
                if (await this.fileService.exists(child.resource.resolve(SKILL_FILE_NAME))) {
                    names.push(child.name);
                }
            } catch (error) {
                this.logger.error(`[NukeAi] Failed to inspect skill directory ${child.name}:`, error);
            }
        }
        return names.sort();
    }

    protected async readSkill(name: string, uri: string): Promise<string> {
        if (!isValidSkillName(name)) {
            return `Unable to read ${uri}: invalid skill name.`;
        }
        let roots: string[];
        try {
            roots = await this.skillRootCache.getRoots();
        } catch (error) {
            this.logger.error('[NukeAi] Failed to read skill roots:', error);
            return `Unable to read ${uri}: the skill service is unavailable.`;
        }
        let lastError: string | undefined;
        for (const root of roots) {
            const rootUri = URI.fromFilePath(root);
            const rootPath = rootUri.path.toString();
            const target = rootUri.resolve(name).resolve(SKILL_FILE_NAME);
            const targetPath = target.path.toString();
            if (!isWithinWorkspace(targetPath, [rootPath])) {
                return `Unable to read ${uri}: the path escapes the skill root.`;
            }
            try {
                if (!(await this.fileService.exists(target))) {
                    continue;
                }
                return (await this.fileService.read(target)).value;
            } catch (error) {
                lastError = errorMessage(error);
                this.logger.error(`[NukeAi] Failed to read skill ${name} at ${targetPath}:`, error);
            }
        }
        return lastError ? `Unable to read ${uri}: ${lastError}` : `Skill not found: ${name}.`;
    }
}

/** Render capability data as a JSON resource, falling back to its message. */
function formatResourceData(result: NukeCapabilityResult, uri: string): string {
    if (result.data !== undefined) {
        return typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2);
    }
    return result.message ?? `No summary is available for ${uri}.`;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
