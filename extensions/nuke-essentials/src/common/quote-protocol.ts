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

export const QuoteServicePath = '/services/quotes';

export const QuoteService = Symbol('QuoteService');

export interface Quote {
    text: string;
    author: string;
    category?: string;
    source?: string;
}

export interface QuoteService {
    /**
     * Get a random quote from the quotes collection
     */
    getRandomQuote(): Promise<Quote | undefined>;

    /**
     * Get all available quotes
     */
    getAllQuotes(): Promise<Quote[]>;
}
