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
 * Dress-up viewport pick requests.
 *
 * The fillet/chamfer dialogs ask the viewport for edge picks; the request
 * carries the optional tangent-chain flag. Chain expansion is edge-only:
 * face flows (draft neutral plane, shell open faces) must keep their
 * single-face pick semantics even if a caller passes a stale flag.
 *
 * @module nuke-cad/browser/widgets
 */

import { type FeatureType } from '../../../common/cad-document';

/** Active dress-up pick mode, shared by the viewport, overlay, and dialog. */
export interface DressUpPickMode {
    readonly type: FeatureType;
    readonly selecting: 'edge' | 'face';
    /** Expand the picked edge to its tangent-connected run (edge picks only). */
    readonly tangentChain?: boolean;
}

/**
 * Build the request for a dress-up pick. `tangentChain` survives only for
 * edge picks; face picks return the historical request shape untouched.
 */
export function dressUpPickRequest(type: FeatureType, selecting: 'edge' | 'face', tangentChain = false): DressUpPickMode {
    if (selecting !== 'edge' || !tangentChain) {
        return { type, selecting };
    }
    return { type, selecting, tangentChain: true };
}
