// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

import { injectable } from '@theia/core/shared/inversify';
import { PreferenceLayout, PreferenceLayoutProvider } from '@theia/preferences/lib/browser/util/preference-layout';

@injectable()
export class NukePreferenceLayoutProvider extends PreferenceLayoutProvider {

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