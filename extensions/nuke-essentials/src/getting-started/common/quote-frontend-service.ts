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

import { injectable, inject } from '@theia/core/shared/inversify';
import { WebSocketConnectionProvider } from '@theia/core/lib/browser/messaging/ws-connection-provider';
import { Quote, QuoteService, QuoteServicePath } from '../../common/quote-protocol';

@injectable()
export class QuoteFrontendService implements QuoteService {
    private readonly service: QuoteService;

    constructor(
        @inject(WebSocketConnectionProvider) connectionProvider: WebSocketConnectionProvider
    ) {
        this.service = connectionProvider.createProxy<QuoteService>(QuoteServicePath);
    }

    async getRandomQuote(): Promise<Quote | undefined> {
        return this.service.getRandomQuote();
    }

    async getAllQuotes(): Promise<Quote[]> {
        return this.service.getAllQuotes();
    }
}
