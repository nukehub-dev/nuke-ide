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

export const FilePropertiesServicePath = '/services/file-properties';

export const FilePropertiesService = Symbol('FilePropertiesService');

export interface FilePermissions {
    readonly mode?: number;
    readonly modeString?: string;
    readonly owner?: { read: boolean; write: boolean; execute: boolean };
    readonly group?: { read: boolean; write: boolean; execute: boolean };
    readonly others?: { read: boolean; write: boolean; execute: boolean };
}

export interface TextStats {
    readonly lines: number;
    readonly words: number;
    readonly characters: number;
}

export interface ImageDimensions {
    readonly width: number;
    readonly height: number;
}

export interface GitFileInfo {
    readonly lastCommitHash: string;
    readonly lastCommitMessage: string;
    readonly lastCommitAuthor: string;
    readonly lastCommitDate: string;
    readonly lastCommitRelativeDate: string;
}

export interface DetailedFileProperties {
    readonly mimeType: string;
    readonly permissions: FilePermissions;
    readonly isSymlink: boolean;
    readonly symlinkTarget?: string;
    readonly symlinkBroken?: boolean;
    readonly atime?: number;
    readonly textStats?: TextStats;
    readonly imageDimensions?: ImageDimensions;
    readonly gitInfo?: GitFileInfo;
}

export interface ChecksumResult {
    readonly algorithm: 'md5' | 'sha256';
    readonly hash: string;
}

export interface FilePropertiesService {
    /**
     * Get detailed properties that require backend fs access.
     */
    getDetailedProperties(filePath: string): Promise<DetailedFileProperties>;

    /**
     * Compute MD5 or SHA-256 checksum for a file.
     */
    computeChecksum(filePath: string, algorithm: 'md5' | 'sha256'): Promise<ChecksumResult>;

    /**
     * Calculate total recursive size of a directory.
     */
    calculateFolderSize(folderPath: string): Promise<number>;
}
