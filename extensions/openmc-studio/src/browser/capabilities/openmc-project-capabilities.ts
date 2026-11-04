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
 * OpenMC Project Capabilities
 *
 * Creates a new OpenMC project from a template, saves it through the backend,
 * and installs it as the active project only after the save succeeds. Template,
 * path, and active-project checks run before any write so a rejected request
 * leaves the open project untouched.
 *
 * @module openmc-studio/browser/capabilities
 */

import * as path from 'path';
import { inject, injectable } from '@theia/core/shared/inversify';
import { URI } from '@theia/core/lib/common/uri';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import {
    NukeCapabilityContext,
    NukeCapabilityContribution,
    NukeCapabilityRegistry,
    NukeCapabilityResult,
    NukeJsonSchema
} from 'nuke-core/lib/common/nuke-capability-protocol';
import { deriveAnnotations, isWithinWorkspace } from 'nuke-core/lib/browser/capabilities/nuke-capability-registry';
import { OpenMCState } from '../../common/openmc-state-schema';
import { OpenMCStudioBackendService, ProjectSaveRequest } from '../../common/openmc-studio-protocol';
import { buildProjectTemplate, getProjectTemplate, PROJECT_TEMPLATE_DEFINITIONS } from '../../common/project-templates';
import { OpenMCStateManager } from '../openmc-state-manager';

/** Write capability that creates and installs a project from a template. */
export const CREATE_PROJECT_CAPABILITY_ID = 'nuke.openmc.createProject';

/** Read-only capability suggested after creating a project. */
const VALIDATE_PROJECT_CAPABILITY_ID = 'nuke.openmc.validateProject';

/** Template used when the request omits `templateId`. */
const DEFAULT_TEMPLATE_ID = 'blank';

/** Extension required for OpenMC project files. */
const PROJECT_FILE_EXTENSION = '.nuke-openmc';

/** Longest accepted project path. */
const MAX_PROJECT_PATH_LENGTH = 1024;

/** C0 control characters and DEL are never valid in a project path. */
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

const CREATE_PROJECT_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        name: { type: 'string', description: 'Project name stored in the project metadata.' },
        path: {
            type: 'string',
            description: 'Project file path ending in .nuke-openmc; absolute or relative to the first workspace root.'
        },
        templateId: { type: 'string', description: 'Template id from the project template catalog. Defaults to blank.' },
        parameters: {
            type: 'object',
            description: 'Numeric template parameter overrides keyed by parameter name.',
            additionalProperties: { type: 'number' }
        },
        replaceExisting: { type: 'boolean', description: 'Allow replacing a clean active project. Refused for a dirty project.' }
    },
    required: ['name', 'path'],
    additionalProperties: false
};

const CREATE_PROJECT_OUTPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        projectPath: { type: 'string', description: 'Absolute path of the saved project file.' },
        templateId: { type: 'string', description: 'Canonical template id used to build the project.' },
        counts: {
            type: 'object',
            properties: {
                materials: { type: 'integer' },
                surfaces: { type: 'integer' },
                cells: { type: 'integer' },
                universes: { type: 'integer' },
                lattices: { type: 'integer' }
            },
            required: ['materials', 'surfaces', 'cells', 'universes', 'lattices'],
            additionalProperties: false
        }
    },
    required: ['projectPath', 'templateId', 'counts'],
    additionalProperties: false
};

/** Result of reading the requested template id. */
type TemplateReadResult = { ok: true; templateId: string } | { ok: false; message: string };

/** Result of reading the optional numeric template parameters. */
type ParametersReadResult = { ok: true; parameters: Record<string, number> } | { ok: false; message: string };

/** Result of resolving and validating the target project path. */
type ProjectPathReadResult = { ok: true; projectPath: string } | { ok: false; message: string };

/** Read a structured capability input as a plain object. */
function readRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Read an optional string field from a capability input object. */
function readString(record: Record<string, unknown>, key: string): string | undefined {
    const value = record[key];
    return typeof value === 'string' ? value : undefined;
}

/** Extract a readable message from an unknown thrown value. */
function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Resolve the requested template id, defaulting to blank when it exists. */
function readTemplateId(record: Record<string, unknown>): TemplateReadResult {
    const validIds = PROJECT_TEMPLATE_DEFINITIONS.map((template) => template.id);
    const requested = readString(record, 'templateId')?.trim();
    const templateId = requested && requested.length > 0 ? requested : getProjectTemplate(DEFAULT_TEMPLATE_ID)?.id;
    if (!templateId) {
        return { ok: false, message: `templateId is required. Valid templates: ${validIds.join(', ')}.` };
    }

    const template = getProjectTemplate(templateId);
    if (!template) {
        return { ok: false, message: `Unknown project template "${templateId}". Valid templates: ${validIds.join(', ')}.` };
    }
    return { ok: true, templateId: template.id };
}

/** Read the optional template parameters, rejecting non-numeric values. */
function readParameters(value: unknown): ParametersReadResult {
    if (value === undefined) {
        return { ok: true, parameters: {} };
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, message: 'parameters must be an object of numeric template parameter values.' };
    }

    const parameters: Record<string, number> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (typeof entry !== 'number' || !Number.isFinite(entry)) {
            return { ok: false, message: `Template parameter "${key}" must be a finite number.` };
        }
        parameters[key] = entry;
    }
    return { ok: true, parameters };
}

/** Find the workspace root that contains an absolute path. */
function findWorkspaceRoot(candidate: string, roots: readonly string[]): string | undefined {
    return roots.find((root) => isWithinWorkspace(candidate, [root]));
}

/** Filesystem stat plus the real path a provider may report after following a link. */
type ResolvedPathStat = { readonly isSymbolicLink: boolean; readonly realPath?: string };

/** True when a provider-reported real path points away from the logical entry. */
function resolvedElsewhere(stat: ResolvedPathStat, logicalPath: string): boolean {
    return typeof stat.realPath === 'string' && stat.realPath.length > 0 && path.resolve(stat.realPath) !== path.resolve(logicalPath);
}

/** Return the first path segment below the root that is a symbolic link. */
async function findSymlinkSegment(fileService: FileService, root: string, projectPath: string): Promise<string | undefined> {
    let current = root;
    for (const segment of path.relative(root, projectPath).split(path.sep)) {
        if (segment.length === 0) {
            continue;
        }
        current = path.join(current, segment);
        let stat: Awaited<ReturnType<FileService['resolve']>>;
        try {
            stat = await fileService.resolve(new URI(current));
        } catch {
            // The remaining path does not exist; the parent check reports it.
            return undefined;
        }
        if (stat.isSymbolicLink || resolvedElsewhere(stat, current)) {
            return current;
        }
    }
    return undefined;
}

/** Resolve and validate a target project file path before writing anything. */
async function readProjectPath(value: unknown, roots: readonly string[], fileService: FileService): Promise<ProjectPathReadResult> {
    const requested = typeof value === 'string' ? value.trim() : undefined;
    if (!requested) {
        return { ok: false, message: 'path is required.' };
    }
    if (CONTROL_CHARACTER_PATTERN.test(requested)) {
        return { ok: false, message: 'Project path must not contain control characters.' };
    }

    const firstRoot = roots[0];
    if (!path.isAbsolute(requested) && !firstRoot) {
        return { ok: false, message: 'Relative project paths need an open workspace.' };
    }
    const projectPath = firstRoot && !path.isAbsolute(requested) ? path.resolve(firstRoot, requested) : path.resolve(requested);
    if (projectPath.length > MAX_PROJECT_PATH_LENGTH) {
        return { ok: false, message: `Project path must be ${MAX_PROJECT_PATH_LENGTH} characters or fewer.` };
    }
    if (path.extname(projectPath) !== PROJECT_FILE_EXTENSION) {
        return { ok: false, message: `Project path must end with ${PROJECT_FILE_EXTENSION}.` };
    }
    if (!isWithinWorkspace(projectPath, roots)) {
        return { ok: false, message: 'Project path must be inside the workspace.' };
    }

    const root = findWorkspaceRoot(projectPath, roots);
    if (!root) {
        return { ok: false, message: 'Project path must be inside the workspace.' };
    }
    const symlinkSegment = await findSymlinkSegment(fileService, root, projectPath);
    if (symlinkSegment) {
        return { ok: false, message: `Project path crosses a symbolic link: ${symlinkSegment}` };
    }

    const parent = path.dirname(projectPath);
    let parentIsDirectory = false;
    try {
        parentIsDirectory = (await fileService.resolve(new URI(parent))).isDirectory;
    } catch {
        return { ok: false, message: `Project directory does not exist: ${parent}` };
    }
    if (!parentIsDirectory) {
        return { ok: false, message: `Project parent is not a directory: ${parent}` };
    }

    let targetExists = false;
    try {
        targetExists = await fileService.exists(new URI(projectPath));
    } catch {
        targetExists = false;
    }
    if (targetExists) {
        return { ok: false, message: `A file already exists at ${projectPath}.` };
    }
    return { ok: true, projectPath };
}

/** Return the template counts reported after a project is installed. */
function projectCounts(state: OpenMCState): Record<string, number> {
    return {
        materials: state.materials.length,
        surfaces: state.geometry.surfaces.length,
        cells: state.geometry.cells.length,
        universes: state.geometry.universes.length,
        lattices: state.geometry.lattices.length
    };
}

/**
 * Registers the OpenMC project creation capability with the nuke-core registry.
 */
@injectable()
export class OpenMCProjectCapabilities implements NukeCapabilityContribution {
    constructor(
        @inject(OpenMCStateManager) protected readonly stateManager: OpenMCStateManager,
        @inject(OpenMCStudioBackendService) protected readonly backendService: OpenMCStudioBackendService,
        @inject(FileService) protected readonly fileService: FileService
    ) {}

    registerCapabilities(registry: NukeCapabilityRegistry): void {
        registry.register({
            id: CREATE_PROJECT_CAPABILITY_ID,
            title: 'Create OpenMC project',
            description:
                'Create a new OpenMC project from a template, save it to a workspace path, and install it as the active project. Existing files are never overwritten.',
            category: ['OpenMC', 'Project'],
            inputSchema: CREATE_PROJECT_INPUT_SCHEMA,
            outputSchema: CREATE_PROJECT_OUTPUT_SCHEMA,
            risk: 'write',
            annotations: deriveAnnotations('write'),
            requiresConfirmation: true,
            undoable: false,
            examples: [
                {
                    description: 'Create a blank project at the workspace root.',
                    input: { name: 'Pincell', path: 'pincell.nuke-openmc' }
                },
                {
                    description: 'Create a 17x17 assembly project with 4.2% enrichment.',
                    input: {
                        name: 'Assembly',
                        path: 'projects/assembly.nuke-openmc',
                        templateId: 'fuel-assembly',
                        parameters: { enrichmentPct: 4.2 }
                    }
                }
            ],
            when: () => true,
            invoke: async (input, context) => this.createProject(input, context)
        });
    }

    /**
     * Validate the template, target path, and active-project state, then save
     * the new project and adopt it only after the backend confirms the write.
     */
    protected async createProject(input: unknown, context: NukeCapabilityContext): Promise<NukeCapabilityResult> {
        const record = readRecord(input);
        const name = readString(record, 'name')?.trim();
        if (!name) {
            return { ok: false, message: 'Project name is required.' };
        }

        const template = readTemplateId(record);
        if (!template.ok) {
            return { ok: false, message: template.message };
        }

        const parameters = readParameters(record.parameters);
        if (!parameters.ok) {
            return { ok: false, message: parameters.message };
        }

        const target = await readProjectPath(record.path, context.workspaceRoots, this.fileService);
        if (!target.ok) {
            return { ok: false, message: target.message };
        }

        if (this.stateManager.projectPath !== undefined) {
            if (this.stateManager.isDirty) {
                return { ok: false, message: 'Save or discard the current project first.' };
            }
            if (record.replaceExisting !== true) {
                return {
                    ok: false,
                    message: 'An OpenMC project is already open. Set replaceExisting to true to create a new project.'
                };
            }
        }

        const state = buildProjectTemplate(template.templateId, parameters.parameters);
        state.metadata.name = name;

        const request: ProjectSaveRequest = { projectPath: target.projectPath, state };
        let saved: { success: boolean; error?: string };
        try {
            saved = await this.backendService.saveProject(request);
        } catch (error) {
            return { ok: false, message: `Failed to save the OpenMC project: ${errorMessage(error)}` };
        }
        if (!saved.success) {
            return { ok: false, message: saved.error ?? 'Failed to save the OpenMC project.' };
        }

        this.stateManager.setState(state);
        this.stateManager.setProjectPath(target.projectPath);
        this.stateManager.markClean();

        return {
            ok: true,
            data: {
                projectPath: target.projectPath,
                templateId: template.templateId,
                counts: projectCounts(state)
            },
            nextActions: [
                {
                    capability: VALIDATE_PROJECT_CAPABILITY_ID,
                    reason: 'Validate the new project before adding geometry or starting a run.'
                }
            ]
        };
    }
}
