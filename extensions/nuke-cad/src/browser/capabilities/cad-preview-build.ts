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
 * Shared candidate-build helper for CAD AI previews.
 *
 * Writes a transient `.nuke-cad` document, runs the real geometry build through
 * the existing frontend service, hands the result to a caller-supplied review
 * callback, and deletes every transient artifact in `finally`. Two layouts are
 * supported:
 *
 * - `beside`: the candidate lives beside the source document so
 *   document-relative imports resolve exactly as they do for the real document.
 * - `private`: the candidate lives inside the private preview directory; used
 *   for self-contained documents such as component templates.
 *
 * @module nuke-cad/browser/capabilities
 */

import { URI } from '@theia/core/lib/common/uri';
import type { FileService } from '@theia/filesystem/lib/browser/file-service';
import * as path from 'path';
import type { GeometryBuildResult } from '../../common/nuke-cad-protocol';
import type { NukeCadDocument } from '../../common/cad-document';
import type { NukeCapabilityResult } from 'nuke-core/lib/common/nuke-capability-protocol';
import type { NukeCadFrontendService } from '../nuke-cad-frontend-service';

/** Workspace-relative root for every CAD AI preview artifact. */
export const CAD_PREVIEW_ROOT = ['.nuke-ide', 'ai', 'cad-previews'] as const;

/** Preview builds must not inherit the backend's one-hour document timeout. */
export const CAD_PREVIEW_TIMEOUT_SECONDS = 120;

/** Where the transient candidate document is written. */
export type CandidateBuildLayout = 'beside' | 'private';

/** Inputs for {@link runCandidateBuild}. */
export interface CandidateBuildRequest {
    readonly candidate: NukeCadDocument;
    readonly layout: CandidateBuildLayout;
    /** Absolute source document path; required for the `beside` layout. */
    readonly documentPath?: string;
    readonly fileService: FileService;
    readonly service: NukeCadFrontendService;
    /** First workspace root; the private preview directory lives under it. */
    readonly workspaceRoot: string;
    readonly signal?: AbortSignal;
    readonly timeoutSeconds?: number;
}

/** Result of a candidate build handed to the review callback. */
export type CandidateBuildReview = (build: GeometryBuildResult) => Promise<NukeCapabilityResult>;

/** Error text for an unknown thrown value. */
function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Sibling region-manifest path for a `.nuke-cad` document. */
function regionSidecarPath(documentPath: string): string | undefined {
    return documentPath.endsWith('.nuke-cad') ? `${documentPath.slice(0, -'.nuke-cad'.length)}.regions.json` : undefined;
}

/**
 * Build a candidate document in a private directory and clean up afterwards.
 *
 * @param request - Candidate, layout, services, and optional cancellation.
 * @param review - Callback that inspects the successful build.
 * @returns The review result, or a failed result describing the build error.
 */
export async function runCandidateBuild(request: CandidateBuildRequest, review: CandidateBuildReview): Promise<NukeCapabilityResult> {
    if (request.layout === 'beside' && request.documentPath === undefined) {
        return { ok: false, message: 'A source document path is required for a beside-source preview.' };
    }
    const previewId = globalThis.crypto.randomUUID();
    const previewDirectory = path.join(request.workspaceRoot, ...CAD_PREVIEW_ROOT, previewId);
    const baseDirectory = request.layout === 'beside' ? path.dirname(request.documentPath as string) : previewDirectory;
    const candidatePath = path.join(baseDirectory, `.nuke-ai-preview-${previewId}.nuke-cad`);
    const candidateSidecarPath = `${candidatePath.slice(0, -'.nuke-cad'.length)}.regions.json`;
    const sourceSidecarPath = request.layout === 'beside' ? regionSidecarPath(request.documentPath as string) : undefined;
    const jobId = `cad-ai-preview-${previewId}`;
    const abort = (): void => {
        void request.service.cancelJob(jobId);
    };
    request.signal?.addEventListener('abort', abort);
    try {
        if (sourceSidecarPath !== undefined) {
            let sourceExists: boolean;
            try {
                sourceExists = await request.fileService.exists(new URI(sourceSidecarPath));
            } catch (error) {
                return {
                    ok: false,
                    message: `The CAD region manifest '${sourceSidecarPath}' could not be inspected: ${errorMessage(error)}`
                };
            }
            if (sourceExists) {
                try {
                    const source = await request.fileService.readFile(new URI(sourceSidecarPath));
                    await request.fileService.create(new URI(candidateSidecarPath), source.value.toString());
                } catch (error) {
                    return {
                        ok: false,
                        message: `The CAD region manifest '${sourceSidecarPath}' could not be copied for the preview: ${errorMessage(error)}`
                    };
                }
            }
        }
        await request.fileService.create(new URI(candidatePath), JSON.stringify(request.candidate, null, 2));
        if (request.signal?.aborted) {
            return { ok: false, message: 'The CAD preview was cancelled.' };
        }
        const build = await request.service.buildDocument({
            scriptPath: candidatePath,
            outputDirectory: previewDirectory,
            useCache: false,
            jobId,
            timeoutSeconds: request.timeoutSeconds ?? CAD_PREVIEW_TIMEOUT_SECONDS
        });
        if (!build.success) {
            return {
                ok: false,
                message: build.error || 'The preview build failed.',
                warnings: build.warnings
            };
        }
        return await review(build);
    } catch (error) {
        return { ok: false, message: errorMessage(error) };
    } finally {
        request.signal?.removeEventListener('abort', abort);
        await Promise.all([
            request.fileService.delete(new URI(candidatePath), { recursive: false, useTrash: false }).catch(() => undefined),
            request.fileService.delete(new URI(candidateSidecarPath), { recursive: false, useTrash: false }).catch(() => undefined),
            request.fileService.delete(new URI(previewDirectory), { recursive: true, useTrash: false }).catch(() => undefined)
        ]);
    }
}
