// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
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
