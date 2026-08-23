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

import * as React from '@theia/core/shared/react';

export interface NukeDialogProps {
    /** Title shown in the dialog header. */
    title: React.ReactNode;
    /** Called when the dialog requests to close (backdrop click, Escape, close button). */
    onClose?: () => void;
    /**
     * When false, the backdrop neither dims nor blocks pointer events, so the
     * content behind the dialog stays interactive (e.g. viewport pick modes
     * driven from inside the dialog). Default true.
     */
    modal?: boolean;
    /** Close when the backdrop is clicked. Default true. */
    closeOnBackdrop?: boolean;
    /** Close when Escape is pressed. Default true. */
    closeOnEscape?: boolean;
    /** Footer content, typically the action buttons. */
    footer?: React.ReactNode;
    /** Maximum width of the dialog box (default 480px). */
    maxWidth?: number | string;
    /** Extra class on the dialog box. */
    className?: string;
    /** Extra class on the scrollable body. */
    bodyClassName?: string;
    children: React.ReactNode;
}

/**
 * Modal dialog shell.
 *
 * Renders a viewport-covering backdrop that blocks pointer events to the
 * content behind it, a header with title and close button, a scrollable
 * body, and an optional footer for actions. The backdrop is positioned
 * absolutely, so the nearest positioned ancestor (e.g. a widget root with
 * `position: relative`) bounds the modal.
 */
export const NukeDialog: React.FC<NukeDialogProps> = ({
    title,
    onClose,
    modal = true,
    closeOnBackdrop = true,
    closeOnEscape = true,
    footer,
    maxWidth,
    className,
    bodyClassName,
    children
}) => {
    React.useEffect(() => {
        if (!closeOnEscape || onClose === undefined) {
            return undefined;
        }
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                // Capture phase so the topmost dialog consumes Escape instead
                // of whatever widget is behind the backdrop.
                e.stopPropagation();
                onClose();
            }
        };
        document.addEventListener('keydown', onKeyDown, true);
        return () => document.removeEventListener('keydown', onKeyDown, true);
    }, [closeOnEscape, onClose]);

    const onBackdropMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
        if (closeOnBackdrop && onClose !== undefined && e.target === e.currentTarget) {
            onClose();
        }
    };

    return (
        <div className={`nuke-dialog-backdrop${modal ? '' : ' non-modal'}`} onMouseDown={onBackdropMouseDown}>
            <div
                className={`nuke-dialog${className ? ` ${className}` : ''}`}
                style={maxWidth !== undefined ? { maxWidth } : undefined}
                role="dialog"
                aria-modal="true"
            >
                <div className="nuke-dialog-header">
                    <div className="nuke-dialog-title">{title}</div>
                    {onClose !== undefined && (
                        <button className="theia-button secondary nuke-dialog-close" onClick={onClose} title="Close">
                            <span className="codicon codicon-close" />
                        </button>
                    )}
                </div>
                <div className={`nuke-dialog-body${bodyClassName ? ` ${bodyClassName}` : ''}`}>{children}</div>
                {footer !== undefined && <div className="nuke-dialog-footer">{footer}</div>}
            </div>
        </div>
    );
};
