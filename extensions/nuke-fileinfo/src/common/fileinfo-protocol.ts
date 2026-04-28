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

/**
 * JSON-RPC path for the file properties backend service.
 */
export const FilePropertiesServicePath = '/services/file-properties';

/**
 * Inversify symbol for the file properties service interface.
 */
export const FilePropertiesService = Symbol('FilePropertiesService');

/**
 * Unix-style permission breakdown for a file.
 */
export interface FilePermissions {
    readonly mode?: number;
    readonly modeString?: string;
    readonly owner?: { read: boolean; write: boolean; execute: boolean };
    readonly group?: { read: boolean; write: boolean; execute: boolean };
    readonly others?: { read: boolean; write: boolean; execute: boolean };
}

/**
 * Basic text statistics for a text-like file.
 */
export interface TextStats {
    readonly lines: number;
    readonly words: number;
    readonly characters: number;
}

/**
 * Width and height of an image file.
 */
export interface ImageDimensions {
    readonly width: number;
    readonly height: number;
}

/**
 * Git metadata for a tracked file.
 */
export interface GitFileInfo {
    readonly lastCommitHash: string;
    readonly lastCommitMessage: string;
    readonly lastCommitAuthor: string;
    readonly lastCommitDate: string;
    readonly lastCommitRelativeDate: string;
}

/**
 * Aggregated detailed metadata returned by the backend for a single file.
 */
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

/**
 * Result of a checksum computation.
 */
export interface ChecksumResult {
    readonly algorithm: 'md5' | 'sha256';
    readonly hash: string;
}

/**
 * RPC service that provides detailed file metadata and utilities.
 *
 * Implemented on the backend by {@link FilePropertiesBackendService}
 * and exposed to the frontend via {@link FilePropertiesFrontendService}.
 */
export interface FilePropertiesService {
    /**
     * Get detailed properties that require backend fs access.
     * @param filePath - Absolute file path or file:// URI.
     */
    getDetailedProperties(filePath: string): Promise<DetailedFileProperties>;

    /**
     * Compute MD5 or SHA-256 checksum for a file.
     * @param filePath - Absolute file path or file:// URI.
     * @param algorithm - Hash algorithm to use.
     */
    computeChecksum(filePath: string, algorithm: 'md5' | 'sha256'): Promise<ChecksumResult>;

    /**
     * Calculate total recursive size of a directory.
     * @param folderPath - Absolute folder path or file:// URI.
     */
    calculateFolderSize(folderPath: string): Promise<number>;
}
