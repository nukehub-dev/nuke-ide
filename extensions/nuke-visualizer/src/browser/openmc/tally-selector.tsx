// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0.
//
// This Source Code may also be made available under the following Secondary
// Licenses when the conditions for such availability set forth in the Eclipse
// Public License v. 2.0 are satisfied: GNU General Public License, version 2
// with the GNU Classpath Exception which is available at
// https://www.gnu.org/software/classpath/license.html.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

import { injectable } from '@theia/core/shared/inversify';
import { QuickInputService, QuickPickValue, QuickPickItem } from '@theia/core/lib/browser';
import { OpenMCTallyInfo, COLOR_MAP_PRESETS } from '../../common/visualizer-protocol';

export interface TallySelection {
    /** Selected tally ID */
    tallyId: number;
    /** Selected score (if applicable) */
    score?: string;
    /** Selected nuclide (if applicable) */
    nuclide?: string;
    /** Selected color map */
    colorMap?: string;
}

@injectable()
export class OpenMCTallySelector {
    constructor(
        private readonly quickInput: QuickInputService
    ) {}

    /**
     * Show a multi-step quick pick to select tally and options.
     */
    async show(tallies: OpenMCTallyInfo[]): Promise<TallySelection | undefined> {
        // Step 1: Select tally
        const tallySelection = await this.selectTally(tallies);
        if (!tallySelection) {
            return undefined;
        }

        // Step 2: Select score if multiple available
        let score: string | undefined;
        if (tallySelection.scores.length > 1) {
            score = await this.selectScore(tallySelection.scores);
            if (score === undefined) {
                return undefined;
            }
        } else if (tallySelection.scores.length === 1) {
            score = tallySelection.scores[0];
        }

        // Step 3: Select nuclide if multiple available
        let nuclide: string | undefined;
        if (tallySelection.nuclides.length > 1) {
            nuclide = await this.selectNuclide(tallySelection.nuclides);
            if (nuclide === undefined) {
                return undefined;
            }
        } else if (tallySelection.nuclides.length === 1) {
            nuclide = tallySelection.nuclides[0];
        }

        // Step 4: Select color map
        const colorMap = await this.selectColorMap();
        if (colorMap === undefined) {
            return undefined;
        }

        return {
            tallyId: tallySelection.id,
            score,
            nuclide,
            colorMap
        };
    }

    private async selectTally(tallies: OpenMCTallyInfo[]): Promise<OpenMCTallyInfo | undefined> {
        const items: QuickPickValue<OpenMCTallyInfo>[] = tallies.map(tally => {
            // Create description based on tally properties
            const parts: string[] = [];
            
            if (tally.scores.length > 0) {
                parts.push(`Scores: ${tally.scores.join(', ')}`);
            }
            
            if (tally.nuclides.length > 0 && !tally.nuclides.includes('total')) {
                parts.push(`Nuclides: ${tally.nuclides.join(', ')}`);
            }
            
            const meshFilters = tally.filters.filter(f => f.type === 'mesh');
            if (meshFilters.length > 0) {
                const mesh = meshFilters[0];
                if (mesh.meshDimensions) {
                    parts.push(`Mesh: ${mesh.meshDimensions.join('×')}`);
                }
            }

            const filterTypes = tally.filters.map(f => f.type).filter(t => t !== 'mesh');
            if (filterTypes.length > 0) {
                parts.push(`Filters: ${filterTypes.join(', ')}`);
            }

            const icon = tally.hasMesh ? '$(graph)' : '$(list-unordered)';

            return {
                label: `${icon} Tally ${tally.id}: ${tally.name}`,
                description: parts.join(' | '),
                detail: tally.hasMesh ? 'Mesh tally - can be visualized in 3D' : 'Non-mesh tally',
                value: tally
            };
        });

        const result = await this.quickInput.showQuickPick(items, {
            title: 'Select Tally to Visualize',
            placeholder: 'Choose a tally from the statepoint',
            canSelectMany: false
        });

        return result?.value;
    }

    private async selectScore(scores: string[]): Promise<string | undefined> {
        const items: QuickPickValue<string>[] = scores.map(score => ({
            label: score,
            description: this.getScoreDescription(score),
            value: score
        }));

        const result = await this.quickInput.showQuickPick(items, {
            title: 'Select Score',
            placeholder: 'Choose which score to visualize',
            canSelectMany: false
        });

        return result?.value;
    }

    private async selectNuclide(nuclides: string[]): Promise<string | undefined> {
        const items: QuickPickValue<string>[] = nuclides.map(nuclide => ({
            label: nuclide,
            description: nuclide === 'total' ? 'All nuclides combined' : undefined,
            value: nuclide
        }));

        const result = await this.quickInput.showQuickPick(items, {
            title: 'Select Nuclide',
            placeholder: 'Choose which nuclide to visualize',
            canSelectMany: false
        });

        return result?.value;
    }

    private async selectColorMap(): Promise<string | undefined> {
        const items: QuickPickValue<string>[] = COLOR_MAP_PRESETS.map(preset => ({
            label: preset,
            value: preset
        }));

        const result = await this.quickInput.showQuickPick(items, {
            title: 'Select Color Map',
            placeholder: 'Choose color map for visualization',
            canSelectMany: false
        });

        return result?.value || 'Cool to Warm';
    }

    private getScoreDescription(score: string): string | undefined {
        const descriptions: Record<string, string> = {
            'flux': 'Neutron flux (particles/cm²/s)',
            'absorption': 'Absorption rate',
            'fission': 'Fission rate',
            'scatter': 'Scattering rate',
            'total': 'Total reaction rate',
            'heating': 'Heating rate (MeV/source)',
            'heating-local': 'Local heating rate',
            'damage-energy': 'Damage energy deposition',
            'elastic': 'Elastic scattering',
            'capture': 'Radiative capture',
        };

        return descriptions[score.toLowerCase()];
    }
}

/**
 * Quick pick item for tally selection with icon support.
 */
export class TallyQuickPickItem implements QuickPickItem {
    constructor(
        public readonly tally: OpenMCTallyInfo,
        private readonly getDescription: (tally: OpenMCTallyInfo) => string
    ) {}

    get label(): string {
        const icon = this.tally.hasMesh ? '$(graph)' : '$(list-unordered)';
        return `${icon} Tally ${this.tally.id}: ${this.tally.name}`;
    }

    get description(): string {
        return this.getDescription(this.tally);
    }

    get detail(): string | undefined {
        if (this.tally.hasMesh) {
            const meshFilter = this.tally.filters.find(f => f.type === 'mesh');
            if (meshFilter?.meshDimensions) {
                return `Mesh dimensions: ${meshFilter.meshDimensions.join(' × ')}`;
            }
            return 'Mesh tally';
        }
        return 'Non-mesh tally';
    }
}

/**
 * Quick pick item for score selection.
 */
export class ScoreQuickPickItem implements QuickPickItem {
    constructor(public readonly score: string) {}

    get label(): string {
        return this.score;
    }

    get description(): string | undefined {
        const descriptions: Record<string, string> = {
            'flux': 'Neutron flux',
            'absorption': 'Absorption rate',
            'fission': 'Fission rate',
            'scatter': 'Scattering rate',
            'total': 'Total reaction rate',
            'heating': 'Heating rate',
        };
        return descriptions[this.score.toLowerCase()];
    }
}

/**
 * Quick pick item for nuclide selection.
 */
export class NuclideQuickPickItem implements QuickPickItem {
    constructor(public readonly nuclide: string) {}

    get label(): string {
        return this.nuclide;
    }

    get description(): string | undefined {
        if (this.nuclide === 'total') {
            return 'All nuclides combined';
        }
        return undefined;
    }
}
