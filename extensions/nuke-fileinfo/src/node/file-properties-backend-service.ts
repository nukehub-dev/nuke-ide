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
import {
    FilePropertiesService,
    DetailedFileProperties,
    FilePermissions,
    ChecksumResult
} from '../common/fileinfo-protocol';

@injectable()
export class FilePropertiesBackendService implements FilePropertiesService {

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

    async getDetailedProperties(filePath: string): Promise<DetailedFileProperties> {
        const localPath = this.toLocalPath(filePath);
        const lstats = await fs.promises.lstat(localPath);
        const isSymlink = lstats.isSymbolicLink();

        let symlinkTarget: string | undefined;
        let symlinkBroken: boolean | undefined;

        if (isSymlink) {
            try {
                symlinkTarget = await fs.promises.readlink(localPath);
                // Check if target is accessible
                const resolved = path.resolve(path.dirname(localPath), symlinkTarget);
                await fs.promises.access(resolved);
                symlinkBroken = false;
            } catch {
                symlinkBroken = true;
            }
        }

        // Use lstats for permissions on the link itself, or regular stat for target
        const statForPerm = isSymlink ? lstats : await fs.promises.stat(localPath);
        const permissions = this.parsePermissions(statForPerm.mode);

        const mimeType = mimeTypes.lookup(localPath) || 'application/octet-stream';

        return {
            mimeType,
            permissions,
            isSymlink,
            symlinkTarget,
            symlinkBroken
        };
    }

    async computeChecksum(filePath: string, algorithm: 'md5' | 'sha256'): Promise<ChecksumResult> {
        const localPath = this.toLocalPath(filePath);
        return new Promise((resolve, reject) => {
            const hash = crypto.createHash(algorithm);
            const stream = fs.createReadStream(localPath);
            stream.on('error', err => reject(err));
            stream.on('data', chunk => hash.update(chunk));
            stream.on('end', () => resolve({ algorithm, hash: hash.digest('hex') }));
        });
    }

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
                        // Skip files we can't stat
                    }
                }
            }
        }
        return total;
    }

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
