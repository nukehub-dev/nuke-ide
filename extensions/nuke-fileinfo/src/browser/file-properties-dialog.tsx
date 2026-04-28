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

import { inject, injectable } from '@theia/core/shared/inversify';
import { URI } from '@theia/core/lib/common/uri';
import { ReactDialog } from '@theia/core/lib/browser/dialogs/react-dialog';
import { DialogProps } from '@theia/core/lib/browser/dialogs';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileStatWithMetadata } from '@theia/filesystem/lib/common/files';
import * as React from '@theia/core/shared/react';
import { nls } from '@theia/core';
import { useTooltip } from 'nuke-essentials/lib/theme/browser/components';
import { FilePropertiesFrontendService } from './fileinfo-frontend-service';
import { DetailedFileProperties } from '../common/fileinfo-protocol';

/**
 * CSS class applied to the file properties dialog root element.
 */
export const FILE_PROPERTIES_DIALOG_CLASS = 'nuke-file-properties-dialog';

/**
 * React state shape for {@link FilePropertiesDialog}.
 */
interface FilePropertiesDialogState {
    loading: boolean;
    error?: string;
    detailed?: DetailedFileProperties;
    checksums: { md5?: string; sha256?: string };
    computingChecksum: 'md5' | 'sha256' | null;
    folderSize?: number;
    calculatingFolderSize: boolean;
}

/**
 * Functional wrapper so we can use the `useTooltip` hook inside a class component render.
 * @param content - Tooltip text to display on hover.
 * @param children - Element that triggers the tooltip.
 * @param className - Optional CSS class for the wrapper.
 * @param onClick - Optional click handler.
 */
const ValueWithTooltip: React.FC<{
    content: string;
    children: React.ReactNode;
    className?: string;
    onClick?: () => void;
}> = ({ content, children, className, onClick }) => {
    const { onMouseEnter, onMouseLeave, tooltipElement } = useTooltip(content, 'bottom');
    return (
        <>
            <div className={className} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} onClick={onClick}>
                {children}
            </div>
            {tooltipElement}
        </>
    );
};

/**
 * Dialog that renders detailed file metadata.
 *
 * Displays name, type, location, size, timestamps, permissions,
 * text stats, image dimensions, Git info, and on-demand checksums.
 */
@injectable()
export class FilePropertiesDialog extends ReactDialog<void> {
    /** Internal React-like state managed manually by the dialog. */
    protected state: FilePropertiesDialogState = {
        loading: true,
        checksums: {},
        computingChecksum: null,
        calculatingFolderSize: false
    };

    /** URI of the file or folder being inspected. */
    protected uri!: URI;
    /** Resolved file stat with metadata. */
    protected stat!: FileStatWithMetadata;

    constructor(
        @inject(FileService) protected readonly fileService: FileService,
        @inject(FilePropertiesFrontendService) protected readonly propertiesService: FilePropertiesFrontendService
    ) {
        super({ title: '' } as DialogProps);
        this.titleNode.textContent = nls.localize('nuke/fileinfo/title', 'File Properties');
        this.acceptButton = this.createButton(nls.localize('nuke/fileinfo/close', 'Close'));
        this.controlPanel.appendChild(this.acceptButton);
        this.acceptButton.classList.add('main');
    }

    /**
     * Configure the dialog for a specific file and trigger detail loading.
     * @param uri - Target file URI.
     * @param stat - Resolved file stat.
     */
    setFile(uri: URI, stat: FileStatWithMetadata): void {
        this.uri = uri;
        this.stat = stat;
        this.titleNode.textContent = nls.localize('nuke/fileinfo/title', 'Properties: {0}', stat.name);
        this.loadDetails();
    }

    /**
     * Fetch detailed properties from the backend service.
     */
    protected async loadDetails(): Promise<void> {
        this.state = { ...this.state, loading: true, error: undefined };
        this.update();
        try {
            const detailed = await this.propertiesService.getDetailedProperties(this.uri.toString());
            this.state = { ...this.state, loading: false, detailed };
        } catch (err) {
            this.state = { ...this.state, loading: false, error: String(err) };
        }
        this.update();
    }

    /**
     * Compute MD5 or SHA-256 for the current file.
     * @param algorithm - Hash algorithm to compute.
     */
    protected handleComputeChecksum = async (algorithm: 'md5' | 'sha256'): Promise<void> => {
        if (this.stat.isDirectory) return;
        this.state = { ...this.state, computingChecksum: algorithm };
        this.update();
        try {
            const result = await this.propertiesService.computeChecksum(this.uri.toString(), algorithm);
            this.state = {
                ...this.state,
                checksums: { ...this.state.checksums, [algorithm]: result.hash },
                computingChecksum: null
            };
        } catch (err) {
            this.state = { ...this.state, computingChecksum: null };
        }
        this.update();
    };

    /**
     * Trigger recursive folder size calculation for the current directory.
     */
    protected handleCalculateFolderSize = async (): Promise<void> => {
        if (!this.stat.isDirectory) return;
        this.state = { ...this.state, calculatingFolderSize: true };
        this.update();
        try {
            const size = await this.propertiesService.calculateFolderSize(this.uri.toString());
            this.state = { ...this.state, folderSize: size, calculatingFolderSize: false };
        } catch (err) {
            this.state = { ...this.state, calculatingFolderSize: false };
        }
        this.update();
    };

    /** Render the dialog content. */
    protected render(): React.ReactNode {
        return (
            <div className={FILE_PROPERTIES_DIALOG_CLASS}>
                {this.state.loading && <div className="nuke-file-properties-loading">Loading properties…</div>}
                {this.state.error && <div className="nuke-file-properties-error">{this.state.error}</div>}
                {!this.state.loading && this.renderContent()}
            </div>
        );
    }

    /** Render the main property rows once data is loaded. */
    protected renderContent(): React.ReactNode {
        const stat = this.stat;
        const detailed = this.state.detailed;

        return (
            <div className="nuke-file-properties-content">
                {this.renderRow('Name', stat.name)}
                {this.renderRow('Type', this.getTypeLabel(stat, detailed))}
                {this.renderRow('Location', this.uri.parent.toString(), true)}
                {this.renderSizeRow()}
                {this.renderRow('Created', this.formatDate(stat.ctime))}
                {this.renderRow('Modified', this.formatDate(stat.mtime))}
                {detailed?.atime !== undefined && this.renderRow('Accessed', this.formatDate(detailed.atime))}
                {detailed?.isSymlink && this.renderRow('Target', detailed.symlinkTarget || '—', true, detailed.symlinkBroken)}
                {detailed && this.renderRow('MIME Type', detailed.mimeType)}
                {detailed?.permissions?.modeString && this.renderRow('Permissions', `${detailed.permissions.modeString} (${(detailed.permissions.mode || 0).toString(8).padStart(3, '0')})`)}
                {detailed?.textStats && this.renderTextStats(detailed.textStats)}
                {detailed?.imageDimensions && this.renderRow('Dimensions', `${detailed.imageDimensions.width} × ${detailed.imageDimensions.height} px`)}
                {detailed?.gitInfo && this.renderGitInfo(detailed.gitInfo)}
                {!stat.isDirectory && this.renderChecksumSection()}
            </div>
        );
    }

    /**
     * Render a single label/value row.
     * @param label - Display label.
     * @param value - Display value.
     * @param copyable - Whether clicking copies the value to clipboard.
     * @param warning - Whether to style the value as a warning.
     */
    protected renderRow(label: string, value: string | undefined, copyable = false, warning = false): React.ReactNode {
        if (value === undefined) return null;
        const className = `nuke-file-properties-value${copyable ? ' copyable' : ''}${warning ? ' warning' : ''}`;
        return (
            <div className="nuke-file-properties-row" key={label}>
                <div className="nuke-file-properties-label">{label}</div>
                <ValueWithTooltip content={value} className={className} onClick={copyable ? () => this.copyToClipboard(value) : undefined}>
                    {value}
                    {copyable && <span className="codicon codicon-copy" />}
                </ValueWithTooltip>
            </div>
        );
    }

    /** Render the size row with folder-size calculation support. */
    protected renderSizeRow(): React.ReactNode {
        const stat = this.stat;
        if (stat.isDirectory) {
            if (this.state.folderSize !== undefined) {
                return this.renderRow('Size', `${this.formatBytes(this.state.folderSize)} (${this.state.folderSize.toLocaleString()} bytes)`);
            }
            return (
                <div className="nuke-file-properties-row" key="Size">
                    <div className="nuke-file-properties-label">Size</div>
                    <div className="nuke-file-properties-value">
                        <button
                            className="theia-button secondary"
                            disabled={this.state.calculatingFolderSize}
                            onClick={this.handleCalculateFolderSize}
                        >
                            {this.state.calculatingFolderSize ? 'Calculating…' : 'Calculate…'}
                        </button>
                    </div>
                </div>
            );
        }
        return this.renderRow('Size', `${this.formatBytes(stat.size)} (${stat.size.toLocaleString()} bytes)`);
    }

    /**
     * Render text statistics section.
     * @param stats - Line, word, and character counts.
     */
    protected renderTextStats(stats: { lines: number; words: number; characters: number }): React.ReactNode {
        return (
            <div className="nuke-file-properties-section" key="text-stats">
                <div className="nuke-file-properties-section-title">Text Statistics</div>
                {this.renderRow('Lines', stats.lines.toLocaleString())}
                {this.renderRow('Words', stats.words.toLocaleString())}
                {this.renderRow('Characters', stats.characters.toLocaleString())}
            </div>
        );
    }

    /**
     * Render Git metadata section.
     * @param info - Latest commit information for the file.
     */
    protected renderGitInfo(info: { lastCommitHash: string; lastCommitMessage: string; lastCommitAuthor: string; lastCommitDate: string }): React.ReactNode {
        return (
            <div className="nuke-file-properties-section" key="git-info">
                <div className="nuke-file-properties-section-title">Git</div>
                {this.renderRow('Last Commit', `${info.lastCommitHash} · ${info.lastCommitMessage}`)}
                {this.renderRow('Author', info.lastCommitAuthor)}
                {this.renderRow('Date', this.formatDate(new Date(info.lastCommitDate).getTime()))}
            </div>
        );
    }

    /** Render the checksum section with MD5 and SHA-256 rows. */
    protected renderChecksumSection(): React.ReactNode {
        return (
            <div className="nuke-file-properties-section" key="checksums">
                <div className="nuke-file-properties-section-title">Checksums</div>
                {this.renderChecksumRow('MD5', this.state.checksums.md5, 'md5')}
                {this.renderChecksumRow('SHA-256', this.state.checksums.sha256, 'sha256')}
            </div>
        );
    }

    /**
     * Render a single checksum row.
     * @param label - Display label (e.g. "MD5").
     * @param hash - Computed hash, if available.
     * @param algorithm - Algorithm identifier for triggering computation.
     */
    protected renderChecksumRow(label: string, hash: string | undefined, algorithm: 'md5' | 'sha256'): React.ReactNode {
        return (
            <div className="nuke-file-properties-row" key={label}>
                <div className="nuke-file-properties-label">{label}</div>
                <div className="nuke-file-properties-value checksum">
                    {hash ? (
                        <ValueWithTooltip content={hash}>
                            <span className="checksum-hash">{hash}</span>
                        </ValueWithTooltip>
                    ) : (
                        <button
                            className="theia-button secondary"
                            disabled={this.state.computingChecksum === algorithm}
                            onClick={() => this.handleComputeChecksum(algorithm)}
                        >
                            {this.state.computingChecksum === algorithm ? 'Computing…' : `Compute ${label}`}
                        </button>
                    )}
                </div>
            </div>
        );
    }

    /**
     * Determine a human-readable type label from the file stat.
     * @param stat - File stat.
     * @param detailed - Optional detailed properties (for symlinks).
     */
    protected getTypeLabel(stat: FileStatWithMetadata, detailed?: DetailedFileProperties): string {
        if (detailed?.isSymlink) return 'Symbolic Link';
        if (stat.isDirectory) return 'Folder';

        const name = stat.name;
        const lastDot = name.lastIndexOf('.');
        if (lastDot > 0) {
            const ext = name.slice(lastDot + 1).toUpperCase();
            return `${ext} File`;
        }
        return 'File';
    }

    /**
     * Convert bytes to a human-readable string (B, KB, MB, GB, TB).
     * @param bytes - Size in bytes.
     */
    protected formatBytes(bytes: number): string {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    /**
     * Format a Unix timestamp to a locale-aware date string.
     * @param timestamp - Milliseconds since epoch.
     */
    protected formatDate(timestamp: number): string {
        try {
            return new Date(timestamp).toLocaleString();
        } catch {
            return String(timestamp);
        }
    }

    /**
     * Copy text to the system clipboard, falling back to a DOM workaround.
     * @param text - Text to copy.
     */
    protected copyToClipboard(text: string): void {
        navigator.clipboard.writeText(text).catch(() => {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
        });
    }

    /** Dialog close value (always undefined). */
    get value(): void {
        return undefined;
    }
}
