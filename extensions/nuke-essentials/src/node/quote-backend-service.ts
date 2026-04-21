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
