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
 * OpenMC Script Capabilities
 *
 * Export the active OpenMC project as Python source through the existing
 * {@link OpenMCPythonExporter}. The capability resolves and validates an
 * explicit workspace path so callers can export without opening a save
 * dialog, while the exporter keeps ownership of code generation and file
 * writing. Every path is checked for workspace containment, parent
 * existence, symlink segments, and accidental overwrites before the exporter
 * runs.
 *
 * @module openmc-studio/browser/capabilities
 */

import * as path from 'path';
import { inject, injectable } from '@theia/core/shared/inversify';
import { URI } from '@theia/core/lib/common/uri';
import type { FileStat } from '@theia/filesystem/lib/common/files';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import {
    NukeCapabilityContribution,
    NukeCapabilityRegistry,
    NukeCapabilityResult,
    NukeJsonSchema
} from 'nuke-core/lib/common/nuke-capability-protocol';
import { deriveAnnotations, isWithinWorkspace } from 'nuke-core/lib/browser/capabilities/nuke-capability-registry';
import { OpenMCStateManager } from '../openmc-state-manager';
import { OpenMCPythonExporter, PythonExportOptions } from '../script-generator/python-exporter';

/** Write capability that exports the active project as Python source. */
export const EXPORT_PYTHON_CAPABILITY_ID = 'nuke.openmc.exportPython';

/** Maximum accepted length of an export target path. */
export const MAX_EXPORT_PATH_LENGTH = 1024;

/** Control characters rejected in every export target path. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

const EXPORT_PYTHON_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        path: {
            type: 'string',
            description:
                'Absolute path, or a path relative to the first workspace root. Single mode writes this .py file; separate mode writes into this directory. Defaults to model.py or the project directory.'
        },
        mode: { type: 'string', enum: ['single', 'separate'], default: 'single' },
        includeComments: { type: 'boolean', default: true },
        includeShebang: { type: 'boolean', default: true },
        overwrite: { type: 'boolean', default: false, description: 'Replace an existing .py file in single mode.' }
    },
    additionalProperties: false
};

const EXPORT_PYTHON_OUTPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of every written file.' },
        fileCount: { type: 'integer' },
        bytes: { type: 'integer', description: 'Combined size of the written files when every size is known.' }
    },
    required: ['paths', 'fileCount'],
    additionalProperties: false
};

/** Target kind accepted by the path policy. */
type ExportTargetKind = 'file' | 'directory';

/** Successful validation of an export target. */
interface ExportTargetSuccess {
    readonly ok: true;
    readonly path: string;
}

/** Rejection of an export target. */
interface ExportTargetFailure {
    readonly ok: false;
    readonly message: string;
}

/** Validation result for an export target. */
type ExportTargetResult = ExportTargetSuccess | ExportTargetFailure;

/**
 * A resolved filesystem entry plus the real path a provider may report for it.
 * Theia's `FileStat` has no `realPath`, but filesystem providers that follow a
 * link surface the destination there, which catches links the provider does
 * not flag with `isSymbolicLink`.
 */
type ResolvedExportStat = FileStat & { readonly realPath?: string };

/** Read a structured capability input as a plain object. */
function readRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Read an optional string field from a capability input object. */
function readString(record: Record<string, unknown>, key: string): string | undefined {
    const value = record[key];
    return typeof value === 'string' ? value : undefined;
}

/** Read an optional boolean field, falling back to the supplied default. */
function readBoolean(record: Record<string, unknown>, key: string, fallback: boolean): boolean {
    const value = record[key];
    return typeof value === 'boolean' ? value : fallback;
}

/** Build a failed target validation. */
function targetFailure(message: string): ExportTargetFailure {
    return { ok: false, message };
}

/** True when a provider-reported real path points away from the logical entry. */
function resolvedElsewhere(stat: ResolvedExportStat, logicalPath: string): boolean {
    return typeof stat.realPath === 'string' && stat.realPath.length > 0 && path.resolve(stat.realPath) !== path.resolve(logicalPath);
}

/** Deepest workspace root containing the candidate. */
function containingRoot(candidate: string, roots: readonly string[]): string | undefined {
    return roots
        .filter((root) => isWithinWorkspace(candidate, [root]))
        .map((root) => path.resolve(root))
        .sort((left, right) => right.length - left.length)[0];
}

/**
 * Validate and canonicalize an export target.
 *
 * Relative paths resolve against the first workspace root. The target must
 * stay inside a workspace root and reach its destination through non-symlink
 * entries. A file target must use the `.py` extension, must sit in an existing
 * directory, and must not already exist unless `overwrite` is set. A directory
 * target must already exist.
 *
 * @param fileService - Workspace filesystem service.
 * @param requested - Requested path, absolute or workspace-relative.
 * @param workspaceRoots - Roots the target must stay inside.
 * @param kind - Whether the target is a file or a directory.
 * @param overwrite - Whether an existing file may be replaced.
 * @returns The canonical absolute path or a clear rejection message.
 */
export async function validateExportTarget(
    fileService: FileService,
    requested: string,
    workspaceRoots: readonly string[],
    kind: ExportTargetKind,
    overwrite: boolean
): Promise<ExportTargetResult> {
    const input = typeof requested === 'string' ? requested.trim() : '';
    if (input.length === 0) {
        return targetFailure('Enter a path for the Python export.');
    }
    if (CONTROL_CHARACTERS.test(input)) {
        return targetFailure('The export path must not contain control characters.');
    }
    if (input.length > MAX_EXPORT_PATH_LENGTH) {
        return targetFailure(`The export path is longer than ${MAX_EXPORT_PATH_LENGTH} characters.`);
    }

    const roots = (Array.isArray(workspaceRoots) ? workspaceRoots : []).filter(
        (root): root is string => typeof root === 'string' && root.length > 0 && path.isAbsolute(root)
    );
    if (roots.length === 0) {
        return targetFailure('Open a folder or workspace before exporting a Python script.');
    }

    const canonical = path.resolve(roots[0], input);
    if (canonical.length > MAX_EXPORT_PATH_LENGTH) {
        return targetFailure(`The export path is longer than ${MAX_EXPORT_PATH_LENGTH} characters.`);
    }
    if (!isWithinWorkspace(canonical, roots)) {
        return targetFailure('The export path is outside every workspace root.');
    }
    if (kind === 'file' && path.extname(canonical).toLowerCase() !== '.py') {
        return targetFailure('Python scripts must use the .py file extension.');
    }

    const root = containingRoot(canonical, roots);
    if (root === undefined) {
        return targetFailure('The export path is outside every workspace root.');
    }
    const relative = path.relative(root, canonical);
    if (relative.length === 0) {
        return kind === 'directory' ? { ok: true, path: canonical } : targetFailure('The export path must name a Python file.');
    }

    const segments = relative.split(path.sep).filter((segment) => segment.length > 0);
    let current = root;
    for (let index = 0; index < segments.length; index += 1) {
        current = path.join(current, segments[index]);
        const isTarget = index === segments.length - 1;
        let stat: ResolvedExportStat | undefined;
        try {
            stat = await fileService.resolve(new URI(current));
        } catch {
            stat = undefined;
        }

        if (stat === undefined) {
            if (kind === 'file' && isTarget) {
                return { ok: true, path: canonical };
            }
            return targetFailure(
                kind === 'directory' ? `The export directory does not exist: ${canonical}` : 'The export folder does not exist.'
            );
        }
        if (stat.isSymbolicLink || resolvedElsewhere(stat, current)) {
            return targetFailure('The export path must not contain symbolic links.');
        }
        if (isTarget) {
            if (kind === 'directory') {
                return stat.isDirectory ? { ok: true, path: canonical } : targetFailure('The export path must be a directory.');
            }
            if (stat.isDirectory) {
                return targetFailure('The export path points to a directory, not a Python file.');
            }
            if (!overwrite) {
                return targetFailure('A file already exists at the export path; set overwrite to true to replace it.');
            }
            return { ok: true, path: canonical };
        }
        if (!stat.isDirectory) {
            return targetFailure('The export folder is not a directory.');
        }
    }

    return kind === 'directory' ? { ok: true, path: canonical } : targetFailure('The export path must name a Python file.');
}

/** Normalize an exporter file entry to an absolute filesystem path. */
function toFilePath(file: string): string {
    if (path.isAbsolute(file)) {
        return file;
    }
    try {
        const uri = new URI(file);
        return uri.path.toString();
    } catch {
        return file;
    }
}

/** Sum the sizes of the exported files, or `undefined` when any size is unknown. */
async function readExportBytes(fileService: FileService, paths: readonly string[]): Promise<number | undefined> {
    if (paths.length === 0) {
        return undefined;
    }
    let total = 0;
    for (const filePath of paths) {
        try {
            const stat = await fileService.resolve(new URI(filePath));
            if (typeof stat.size !== 'number' || !Number.isFinite(stat.size)) {
                return undefined;
            }
            total += stat.size;
        } catch {
            return undefined;
        }
    }
    return total;
}

/**
 * Registers the OpenMC Python export capability with the nuke-core registry.
 */
@injectable()
export class OpenMCScriptCapabilities implements NukeCapabilityContribution {
    constructor(
        @inject(OpenMCStateManager) protected readonly stateManager: OpenMCStateManager,
        @inject(OpenMCPythonExporter) protected readonly exporter: OpenMCPythonExporter,
        @inject(FileService) protected readonly fileService: FileService
    ) {}

    registerCapabilities(registry: NukeCapabilityRegistry): void {
        registry.register({
            id: EXPORT_PYTHON_CAPABILITY_ID,
            title: 'Export OpenMC Python script',
            description:
                'Export the active OpenMC project as a single model.py or separate Python modules. Writes to an explicit workspace path without opening a save dialog.',
            category: ['OpenMC', 'Script'],
            inputSchema: EXPORT_PYTHON_INPUT_SCHEMA,
            outputSchema: EXPORT_PYTHON_OUTPUT_SCHEMA,
            risk: 'write',
            annotations: deriveAnnotations('write'),
            requiresConfirmation: true,
            undoable: false,
            examples: [
                { description: 'Write model.py next to the saved project.', input: { mode: 'single' } },
                {
                    description: 'Write separate module files into a workspace directory.',
                    input: { mode: 'separate', path: 'exports/python' }
                }
            ],
            when: () => true,
            invoke: async (input, context) => this.exportPython(input, context.workspaceRoots)
        });
    }

    /**
     * Resolve the export path, delegate code generation to the exporter, and
     * report the absolute files that were written.
     */
    protected async exportPython(input: unknown, workspaceRoots: readonly string[]): Promise<NukeCapabilityResult> {
        const projectPath = this.stateManager.projectPath;
        if (!projectPath) {
            return { ok: false, message: 'Save the OpenMC project before exporting a Python script.' };
        }

        const record = readRecord(input);
        const rawMode = readString(record, 'mode');
        if (rawMode !== undefined && rawMode !== 'single' && rawMode !== 'separate') {
            return { ok: false, message: 'mode must be single or separate.' };
        }
        const mode = rawMode === 'separate' ? 'separate' : 'single';
        const includeComments = readBoolean(record, 'includeComments', true);
        const includeShebang = readBoolean(record, 'includeShebang', true);
        const overwrite = readBoolean(record, 'overwrite', false);

        const projectDirectory = path.dirname(projectPath);
        const requestedPath = readString(record, 'path')?.trim();
        let target = projectDirectory;
        if (requestedPath && requestedPath.length > 0) {
            target = requestedPath;
        } else if (mode === 'single') {
            target = path.join(projectDirectory, 'model.py');
        }

        const kind: ExportTargetKind = mode === 'single' ? 'file' : 'directory';
        const targetResult = await validateExportTarget(this.fileService, target, workspaceRoots, kind, overwrite);
        if (!targetResult.ok) {
            return { ok: false, message: targetResult.message };
        }

        const options: Partial<PythonExportOptions> =
            mode === 'single'
                ? { mode, targetPath: targetResult.path, includeComments, includeShebang }
                : { mode, outputDirectory: targetResult.path, includeComments, includeShebang };

        const result = await this.exporter.exportToPython(options);
        if (!result.success) {
            return { ok: false, message: result.error ?? 'Python export failed.' };
        }

        const paths = result.files.map(toFilePath);
        const bytes = await readExportBytes(this.fileService, paths);
        return {
            ok: true,
            data: {
                paths,
                fileCount: paths.length,
                ...(bytes !== undefined ? { bytes } : {})
            }
        };
    }
}
