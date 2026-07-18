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
 * Nuke Preference Layout
 *
 * Overrides the default Theia preference layout to inject a "Nuke Utils" category
 * at the top of the Settings panel. This ensures all `nuke.*` preferences are visually
 * grouped together and easy to discover.
 *
 * @module nuke-core/browser
 * @see {@link ./nuke-core-preferences | Nuke Core Preferences}
 * @see {@link ./nuke-core-frontend-module | Nuke Core Frontend Module}
 */

import { injectable } from '@theia/core/shared/inversify';
import { PreferenceLayout, PreferenceLayoutProvider } from '@theia/preferences/lib/browser/util/preference-layout';

/**
 * Custom preference layout provider that prepends the "Nuke Utils" settings category.
 *
 * Extends {@link @theia/preferences/lib/browser/util/preference-layout#PreferenceLayoutProvider}
 * and overrides `getLayout()` to ensure the Nuke group appears before default categories.
 *
 * Bound as a singleton in the frontend module and rebinding
 * {@link @theia/preferences/lib/browser/util/preference-layout#PreferenceLayoutProvider}.
 */
@injectable()
export class NukePreferenceLayoutProvider extends PreferenceLayoutProvider {
    /**
     * Returns the merged preference layout with the Nuke Utils category prepended.
     *
     * @returns An array of {@link PreferenceLayout} objects where the first entry
     *          is the "Nuke Utils" group (`nuke.*`) followed by the default layout.
     * @see {@link PreferenceLayoutProvider.getLayout}
     */
    override getLayout(): PreferenceLayout[] {
        const defaultLayout = super.getLayout();

        const nukeLayout: PreferenceLayout = {
            id: 'nuke',
            label: 'Nuke Utils',
            settings: ['nuke.*']
        };

        return [nukeLayout, ...defaultLayout];
    }
}
