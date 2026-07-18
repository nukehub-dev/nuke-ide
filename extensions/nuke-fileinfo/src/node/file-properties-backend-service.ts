// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
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

import { injectable } from '@theia/core/shared/inversify';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { fileURLToPath } from 'url';
import * as mimeTypes from 'mime-types';
import * as imageSize from 'image-size';
import { simpleGit } from 'simple-git';
import {
    FilePropertiesService,
    DetailedFileProperties,
    FilePermissions,
    ChecksumResult,
    TextStats,
    ImageDimensions,
    GitFileInfo
} from '../common/fileinfo-protocol';

/**
 * Node.js backend implementation of {@link FilePropertiesService}.
 *
 * Performs file-system operations directly on the backend to gather
 * metadata such as permissions, MIME types, image dimensions, text
 * statistics, Git history, and cryptographic checksums.
 *
 * @see src/browser/fileinfo-frontend-service.ts for the frontend proxy
 * @see src/common/fileinfo-protocol.ts for the RPC interface
 */
@injectable()
export class FilePropertiesBackendService implements FilePropertiesService {
    /**
     * Convert a `file://` URI to an absolute local path.
     * @param filePath - URI or raw path.
     * @returns Absolute local filesystem path.
     */
    protected toLocalPath(filePath: string): string {
        if (filePath.startsWith('file://')) {
            try {
                return fileURLToPath(filePath);
            } catch {
                return filePath.slice(7);
            }
        }
        return filePath;
    }

    /** {@inheritDoc FilePropertiesService.getDetailedProperties} */
    async getDetailedProperties(filePath: string): Promise<DetailedFileProperties> {
        const localPath = this.toLocalPath(filePath);
        const lstats = await fs.promises.lstat(localPath);
        const isSymlink = lstats.isSymbolicLink();

        let symlinkTarget: string | undefined;
        let symlinkBroken: boolean | undefined;

        if (isSymlink) {
            try {
                symlinkTarget = await fs.promises.readlink(localPath);
                const resolved = path.resolve(path.dirname(localPath), symlinkTarget);
                await fs.promises.access(resolved);
                symlinkBroken = false;
            } catch {
                symlinkBroken = true;
            }
        }

        const statForPerm = isSymlink ? lstats : await fs.promises.stat(localPath);
        const permissions = this.parsePermissions(statForPerm.mode);
        const mimeType = mimeTypes.lookup(localPath) || 'application/octet-stream';

        // Gather extra metadata in parallel
        const [textStats, imageDimensions, gitInfo] = await Promise.all([
            this.computeTextStats(localPath, mimeType, statForPerm.size),
            this.computeImageDimensions(localPath, mimeType),
            this.computeGitInfo(localPath)
        ]);

        return {
            mimeType,
            permissions,
            isSymlink,
            symlinkTarget,
            symlinkBroken,
            atime: statForPerm.atime ? statForPerm.atime.getTime() : undefined,
            textStats,
            imageDimensions,
            gitInfo
        };
    }

    /** {@inheritDoc FilePropertiesService.computeChecksum} */
    async computeChecksum(filePath: string, algorithm: 'md5' | 'sha256'): Promise<ChecksumResult> {
        const localPath = this.toLocalPath(filePath);
        return new Promise((resolve, reject) => {
            const hash = crypto.createHash(algorithm);
            const stream = fs.createReadStream(localPath);
            stream.on('error', (err) => reject(err));
            stream.on('data', (chunk) => hash.update(chunk));
            stream.on('end', () => resolve({ algorithm, hash: hash.digest('hex') }));
        });
    }

    /** {@inheritDoc FilePropertiesService.calculateFolderSize} */
    async calculateFolderSize(folderPath: string): Promise<number> {
        const localPath = this.toLocalPath(folderPath);
        let total = 0;
        const stack: string[] = [localPath];

        while (stack.length > 0) {
            const current = stack.pop()!;
            const entries = await fs.promises.readdir(current, { withFileTypes: true });
            for (const entry of entries) {
                const entryPath = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    stack.push(entryPath);
                } else if (entry.isFile()) {
                    try {
                        const s = await fs.promises.stat(entryPath);
                        total += s.size;
                    } catch {
                        // skip unreadable files
                    }
                }
            }
        }
        return total;
    }

    /**
     * Compute line, word, and character counts for text-like files.
     * Skips files larger than 10 MB or non-text MIME types.
     * @param filePath - Absolute file path.
     * @param mimeType - Detected MIME type.
     * @param size - File size in bytes.
     */
    protected async computeTextStats(filePath: string, mimeType: string, size: number): Promise<TextStats | undefined> {
        // Skip if not a text-like file or too large (>10MB)
        if (size > 10 * 1024 * 1024) return undefined;
        if (
            !mimeType.startsWith('text/') &&
            !mimeType.includes('json') &&
            !mimeType.includes('xml') &&
            !mimeType.includes('javascript') &&
            !mimeType.includes('typescript') &&
            !mimeType.includes('python') &&
            !mimeType.includes('markdown')
        ) {
            return undefined;
        }
        try {
            const content = await fs.promises.readFile(filePath, 'utf8');
            const lines = content.split(/\r?\n/).length;
            const words = content
                .trim()
                .split(/\s+/)
                .filter((w) => w.length > 0).length;
            const characters = content.length;
            return { lines, words, characters };
        } catch {
            return undefined;
        }
    }

    /**
     * Read image dimensions using the `image-size` library.
     * @param filePath - Absolute file path.
     * @param mimeType - Detected MIME type.
     */
    protected async computeImageDimensions(filePath: string, mimeType: string): Promise<ImageDimensions | undefined> {
        if (!mimeType.startsWith('image/')) return undefined;
        try {
            const buffer = await fs.promises.readFile(filePath);
            const result = imageSize.imageSize(buffer);
            if (result.width && result.height) {
                return { width: result.width, height: result.height };
            }
        } catch {
            // ignore unsupported or corrupt images
        }
        return undefined;
    }

    /**
     * Query the latest Git commit affecting the given file.
     * @param filePath - Absolute file path.
     */
    protected async computeGitInfo(filePath: string): Promise<GitFileInfo | undefined> {
        try {
            const dir = path.dirname(filePath);
            const git = simpleGit(dir);
            const isRepo = await git.checkIsRepo();
            if (!isRepo) return undefined;

            // Get repo root to compute relative path for the file
            const repoRoot = await git.revparse(['--show-toplevel']);
            const relativePath = path.relative(repoRoot, filePath);

            const log = await git.log({ file: relativePath, n: 1 });
            if (!log.latest) return undefined;

            const latest = log.latest;
            return {
                lastCommitHash: latest.hash.substring(0, 7),
                lastCommitMessage: latest.message.split('\n')[0],
                lastCommitAuthor: latest.author_name,
                lastCommitDate: latest.date,
                lastCommitRelativeDate: latest.date
            };
        } catch {
            return undefined;
        }
    }

    /**
     * Parse a numeric Unix mode into a {@link FilePermissions} object.
     * @param mode - Numeric file mode (e.g. `0o644`).
     */
    protected parsePermissions(mode: number): FilePermissions {
        const owner = {
            read: !!(mode & 0o400),
            write: !!(mode & 0o200),
            execute: !!(mode & 0o100)
        };
        const group = {
            read: !!(mode & 0o040),
            write: !!(mode & 0o020),
            execute: !!(mode & 0o010)
        };
        const others = {
            read: !!(mode & 0o004),
            write: !!(mode & 0o002),
            execute: !!(mode & 0o001)
        };

        const modeString = [
            owner.read ? 'r' : '-',
            owner.write ? 'w' : '-',
            owner.execute ? 'x' : '-',
            group.read ? 'r' : '-',
            group.write ? 'w' : '-',
            group.execute ? 'x' : '-',
            others.read ? 'r' : '-',
            others.write ? 'w' : '-',
            others.execute ? 'x' : '-'
        ].join('');

        return { mode: mode & 0o777, modeString, owner, group, others };
    }
}
