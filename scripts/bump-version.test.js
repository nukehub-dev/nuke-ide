// @ts-check
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ROOT, discoverPackageNames, discoverPackages } from './bump-version.js';

describe('bump-version package discovery', () => {
    it('includes both apps and every extension package', () => {
        const packages = discoverPackages();
        expect(packages).toEqual(
            expect.arrayContaining([
                'applications/browser/package.json',
                'applications/electron/package.json',
                'extensions/nuke-ai/package.json',
                'extensions/nuke-cad/package.json'
            ])
        );

        const extensionPackages = fs
            .readdirSync(path.join(ROOT, 'extensions'), { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(ROOT, 'extensions', entry.name, 'package.json')))
            .map((entry) => `extensions/${entry.name}/package.json`);
        for (const extensionPackage of extensionPackages) {
            expect(packages).toContain(extensionPackage);
        }
    });

    it('names every package so internal dependency versions are bumped', () => {
        const packages = discoverPackages();
        const names = new Set(discoverPackageNames(packages));

        expect([...names]).toEqual(
            expect.arrayContaining([
                'nuke-ai',
                'nuke-cad',
                'nuke-core',
                'nuke-essentials',
                'nuke-fileinfo',
                'nuke-sysmon',
                'nuke-visualizer',
                'openmc-studio',
                'nukelab-integration',
                'nuke-ide',
                'nuke-ide-electron'
            ])
        );

        for (const packagePath of packages) {
            const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, packagePath), 'utf-8'));
            expect(names).toContain(manifest.name);
        }
    });
});
