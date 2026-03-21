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
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { Quote, QuoteService } from '../common/quote-protocol';

@injectable()
export class QuoteBackendService implements QuoteService {
    private quotes: Quote[] = [];
    private loaded = false;

    async getRandomQuote(): Promise<Quote | undefined> {
        await this.ensureLoaded();
        if (this.quotes.length === 0) {
            return undefined;
        }
        const randomIndex = Math.floor(Math.random() * this.quotes.length);
        return this.quotes[randomIndex];
    }

    async getAllQuotes(): Promise<Quote[]> {
        await this.ensureLoaded();
        return [...this.quotes];
    }

    private async ensureLoaded(): Promise<void> {
        if (this.loaded) {
            return;
        }

        this.quotes = await this.loadQuotesFromYaml();
        this.loaded = true;
    }

    private async loadQuotesFromYaml(): Promise<Quote[]> {
        try {
            // Try multiple possible paths for the quotes.yml file
            const possiblePaths = [
                path.join(process.cwd(), 'resources', 'quotes.yml'),
                path.join(__dirname, '..', '..', '..', '..', 'resources', 'quotes.yml'),
                path.join(__dirname, '..', '..', '..', '..', '..', 'resources', 'quotes.yml'),
                path.join(__dirname, '..', '..', '..', '..', '..', '..', 'resources', 'quotes.yml'),
            ];

            for (const quotesPath of possiblePaths) {
                if (fs.existsSync(quotesPath)) {
                    console.log(`[QuoteBackendService] Loading quotes from: ${quotesPath}`);
                    const yamlContent = fs.readFileSync(quotesPath, 'utf8');
                    const quotesData = yaml.load(yamlContent) as { quotes?: Quote[] };

                    if (quotesData.quotes && quotesData.quotes.length > 0) {
                        console.log(`[QuoteBackendService] Loaded ${quotesData.quotes.length} quotes`);
                        return quotesData.quotes;
                    }
                }
            }

            console.log('[QuoteBackendService] quotes.yml not found in any expected location');
            return [];
        } catch (error) {
            console.error('[QuoteBackendService] Error loading quotes:', error);
            return [];
        }
    }
}
