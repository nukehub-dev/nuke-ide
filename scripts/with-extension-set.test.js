// @ts-check
import { describe, it, expect } from 'vitest';
import { computeExclusion, OPTIONAL } from './with-extension-set.js';

/** applications/browser declares every optional extension. */
const BROWSER = Object.keys(OPTIONAL);
/** applications/electron omits nukelab-integration. */
const ELECTRON = BROWSER.filter((name) => name !== 'nukelab-integration');

describe('computeExclusion', () => {
    it('excludes nukelab-integration by default', () => {
        const { excluded, notes } = computeExclusion(BROWSER, {});
        expect(excluded).toEqual(['nukelab-integration']);
        expect(notes.some((note) => note.includes('excluded by default'))).toBe(true);
    });

    it('excludes nothing by default for apps without default-off extensions', () => {
        const { excluded } = computeExclusion(ELECTRON, {});
        expect(excluded).toEqual([]);
    });

    it('treats empty selection variables like unset', () => {
        const { excluded } = computeExclusion(BROWSER, { NUKE_EXTENSIONS: '', NUKE_EXCLUDE_EXTENSIONS: '  ' });
        expect(excluded).toEqual(['nukelab-integration']);
    });

    it('notes when a deny-listed extension is already excluded by default', () => {
        const { excluded, notes } = computeExclusion(BROWSER, { NUKE_EXCLUDE_EXTENSIONS: 'nukelab-integration' });
        expect(excluded).toEqual(['nukelab-integration']);
        expect(notes.some((note) => note.includes('already excluded by default'))).toBe(true);
    });

    it('drops dependents when their local dependency is excluded', () => {
        const { excluded, notes } = computeExclusion(BROWSER, { NUKE_EXCLUDE_EXTENSIONS: 'nuke-visualizer' });
        expect(excluded).toEqual(expect.arrayContaining(['nuke-visualizer', 'openmc-studio', 'nukelab-integration']));
        expect(notes.some((note) => note.includes('openmc-studio'))).toBe(true);
    });

    it('keeps only the allow-listed extensions and pulls in their closure', () => {
        const { excluded, notes } = computeExclusion(BROWSER, { NUKE_EXTENSIONS: 'openmc-studio' });
        expect(excluded).toEqual(expect.arrayContaining(['nuke-docs', 'nuke-fileinfo', 'nuke-sysmon', 'nukelab-integration']));
        expect(excluded).not.toContain('openmc-studio');
        expect(excluded).not.toContain('nuke-visualizer');
        expect(notes.some((note) => note.includes('nuke-visualizer'))).toBe(true);
    });

    it('opts nukelab-integration in via the allow-list', () => {
        const { excluded } = computeExclusion(BROWSER, { NUKE_EXTENSIONS: 'all' });
        expect(excluded).toEqual([]);
    });

    it('expands `all` to the extensions the app actually depends on', () => {
        const { excluded, notes } = computeExclusion(ELECTRON, { NUKE_EXTENSIONS: 'all' });
        expect(excluded).toEqual([]);
        expect(notes).toEqual([]);
    });

    it('parses comma-separated lists with whitespace', () => {
        const { excluded } = computeExclusion(BROWSER, { NUKE_EXCLUDE_EXTENSIONS: ' nukelab-integration , nuke-sysmon ' });
        expect(excluded).toEqual(expect.arrayContaining(['nukelab-integration', 'nuke-sysmon']));
    });

    it('throws on unknown extension names', () => {
        expect(() => computeExclusion(BROWSER, { NUKE_EXTENSIONS: 'moose-studio' })).toThrow(/Unknown extension "moose-studio"/);
        expect(() => computeExclusion(BROWSER, { NUKE_EXCLUDE_EXTENSIONS: 'moose-studio' })).toThrow(/Unknown extension/);
    });

    it('ignores valid extensions that the app does not depend on', () => {
        const { excluded, notes } = computeExclusion(ELECTRON, { NUKE_EXCLUDE_EXTENSIONS: 'nukelab-integration' });
        expect(excluded).toEqual([]);
        expect(notes.some((note) => note.includes('not a dependency'))).toBe(true);
    });
});
