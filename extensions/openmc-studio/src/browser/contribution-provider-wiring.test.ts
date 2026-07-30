/**
 * DI wiring guard: every symbol injected via `@inject(ContributionProvider) @named(<Symbol>)`
 * must have a matching `bindContributionProvider(bind, <Symbol>)` in a frontend module.
 * Missing provider bindings compile fine but explode at runtime with
 * "No matching bindings found for serviceIdentifier: Symbol(ContributionProvider)".
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SRC_BROWSER = path.resolve(__dirname, '..');

function collectSources(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...collectSources(full));
        } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.test.ts')) {
            out.push(full);
        }
    }
    return out;
}

describe('ContributionProvider wiring', () => {
    it('every @named ContributionProvider symbol has a bindContributionProvider call', () => {
        const files = collectSources(SRC_BROWSER);
        const contents = files.map((f) => fs.readFileSync(f, 'utf-8'));
        const allSource = contents.join('\n');

        // Symbols injected as a named ContributionProvider, e.g.
        // @inject(ContributionProvider) @named(DashboardTabContribution)
        const namedSymbols = new Set<string>();
        for (const source of contents) {
            if (!source.includes('ContributionProvider')) {
                continue;
            }
            for (const match of source.matchAll(/@named\(\s*([A-Za-z0-9_]+)\s*\)/g)) {
                namedSymbols.add(match[1]);
            }
        }

        expect(namedSymbols.size).toBeGreaterThan(0);
        for (const symbol of namedSymbols) {
            expect(
                allSource.includes(`bindContributionProvider(bind, ${symbol})`),
                `Missing bindContributionProvider(bind, ${symbol}) in a frontend module`
            ).toBe(true);
        }
    });
});
