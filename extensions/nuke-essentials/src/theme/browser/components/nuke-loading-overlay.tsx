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
import { FancyLoadingSpinner, LoadingAnimations } from './loading-spinner';

export interface NukeLoadingOverlayProps {
    /** Main message to display. */
    message: string;
    /** Optional sub-message. */
    subMessage?: string;
    /** Dim the content behind the overlay. Default true. */
    dim?: boolean;
}

/**
 * Centered loading overlay: a `FancyLoadingSpinner` over a
 * viewport-covering backdrop. The backdrop is positioned absolutely, so the
 * nearest positioned ancestor bounds it, and it blocks pointer events while
 * the operation runs.
 */
export const NukeLoadingOverlay: React.FC<NukeLoadingOverlayProps> = ({ message, subMessage, dim = true }) => (
    <div className={`nuke-loading-overlay${dim ? '' : ' no-dim'}`}>
        <LoadingAnimations />
        <FancyLoadingSpinner message={message} subMessage={subMessage} />
    </div>
);
