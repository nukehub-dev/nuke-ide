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
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { MonacoThemeRegistry } from '@theia/monaco/lib/browser/textmate/monaco-theme-registry';
import { ThemeService } from '@theia/core/lib/browser/theming';
import { LogoSvgInner } from './components';
import { getThemeConfig, THEME_CONFIGS } from './theme-protocol';
import * as themes from './themes';

@injectable()
export class ThemeContribution implements FrontendApplicationContribution {
    @inject(MonacoThemeRegistry)
    protected readonly monacoThemeRegistry: MonacoThemeRegistry;

    @inject(ThemeService)
    protected readonly themeService: ThemeService;

    // Built-in theme IDs to hide
    private readonly builtinThemeIds = [
        'dark',
        'light',
        'dark-theia',
        'light-theia',
        'hc-theia',
        'hc-theia-light',
        'hc-black',
        'hc-light'
    ];

    onStart(): void {
        this.registerThemes();
        this.disableBuiltinThemes();
        this.initializeTopLogo();
        this.updateFavicon();
    }

    /**
     * Updates the browser favicon to match the current theme's accent color.
     */
    protected updateFavicon(): void {
        const currentTheme = this.themeService.getCurrentTheme();
        if (!currentTheme) return;

        const config = getThemeConfig(currentTheme.id);
        const accentColor = config?.colors.accent || '#f37524';

        // Create the tinted SVG string using the same inner paths
        const svgString = `
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
                <g style="color: ${accentColor}">
                    ${LogoSvgInner}
                </g>
            </svg>
        `.trim();

        const encoded = encodeURIComponent(svgString)
            .replace(/'/g, '%27')
            .replace(/"/g, '%22');
        
        const dataUrl = `data:image/svg+xml,${encoded}`;

        let link: HTMLLinkElement | null = document.querySelector("link[rel*='icon']");
        if (!link) {
            link = document.createElement('link');
            link.rel = 'icon';
            link.type = 'image/svg+xml';
            document.head.appendChild(link);
        }
        
        link.href = dataUrl;
    }

    /**
     * Replaces the default Theia top panel icon with the NukeIDE SVG logo.
     */
    protected initializeTopLogo(): void {
        const topIcon = document.getElementById('theia:icon');
        if (topIcon) {
            topIcon.innerHTML = `
                <svg viewBox="0 0 256 256" style="width: 100%; height: 100%; display: block; color: var(--theia-focusBorder);">
                    ${LogoSvgInner}
                </svg>
            `;
            // Remove the background-image by adding a class or setting style
            topIcon.style.backgroundImage = 'none';
        } else {
            // Try again if not yet in DOM
            setTimeout(() => this.initializeTopLogo(), 100);
        }
    }

    /**
     * Disable/hide built-in Theia themes by overriding getThemes()
     */
    protected disableBuiltinThemes(): void {
        // Override getThemes to filter out built-in themes
        const originalGetThemes = this.themeService.getThemes.bind(this.themeService);
        (this.themeService as any).getThemes = () => {
            const allThemes = originalGetThemes();
            return allThemes.filter((theme: { id: string }) => !this.builtinThemeIds.includes(theme.id));
        };

        // Remove built-in themes from the internal themes object
        const themeServiceAny = this.themeService as any;
        if (themeServiceAny.themes) {
            this.builtinThemeIds.forEach(id => {
                if (themeServiceAny.themes[id]) {
                    delete themeServiceAny.themes[id];
                }
            });
        }
    }

    protected registerThemes(): void {
        // Register Dark Theme
        this.monacoThemeRegistry.register(themes.darkTheme as any, {}, 'nukeide-dark', 'vs-dark');
        this.themeService.register({
            id: 'nukeide-dark',
            type: 'dark',
            label: 'Dark',
            description: 'theme with orange accents',
            editorTheme: 'nukeide-dark'
        });

        // Register Light Theme
        this.monacoThemeRegistry.register(themes.lightTheme as any, {}, 'nukeide-light', 'vs');
        this.themeService.register({
            id: 'nukeide-light',
            type: 'light',
            label: 'Light',
            description: 'theme with orange accents',
            editorTheme: 'nukeide-light'
        });

        // Register Blue Dark Theme
        this.monacoThemeRegistry.register(themes.blueDarkTheme as any, {}, 'nukeide-blue-dark', 'vs-dark');
        this.themeService.register({
            id: 'nukeide-blue-dark',
            type: 'dark',
            label: 'Blue Dark',
            description: 'theme with blue accents',
            editorTheme: 'nukeide-blue-dark'
        });

        // Register Blue Light Theme
        this.monacoThemeRegistry.register(themes.blueLightTheme as any, {}, 'nukeide-blue-light', 'vs');
        this.themeService.register({
            id: 'nukeide-blue-light',
            type: 'light',
            label: 'Blue Light',
            description: 'theme with blue accents',
            editorTheme: 'nukeide-blue-light'
        });

        // Register Red Dark Theme
        this.monacoThemeRegistry.register(themes.redDarkTheme as any, {}, 'nukeide-red-dark', 'vs-dark');
        this.themeService.register({
            id: 'nukeide-red-dark',
            type: 'dark',
            label: 'Red Dark',
            description: 'theme with red accents',
            editorTheme: 'nukeide-red-dark'
        });

        // Register Red Light Theme
        this.monacoThemeRegistry.register(themes.redLightTheme as any, {}, 'nukeide-red-light', 'vs');
        this.themeService.register({
            id: 'nukeide-red-light',
            type: 'light',
            label: 'Red Light',
            description: 'theme with red accents',
            editorTheme: 'nukeide-red-light'
        });

        // Restore theme from nuke-theme localStorage or set default
        const savedTheme = this.getThemeFromLocalStorage();
        const currentTheme = this.themeService.getCurrentTheme();

        const validThemeIds = THEME_CONFIGS.map(t => t.id);

        if (savedTheme && validThemeIds.includes(savedTheme.id)) {
            // Restore saved Nuke theme
            if (currentTheme?.id !== savedTheme.id) {
                this.themeService.setCurrentTheme(savedTheme.id);
            }
        } else if (!currentTheme || currentTheme.id === 'dark-theia' || currentTheme.id === 'dark') {
            // Default to dark for Theia dark themes
            this.themeService.setCurrentTheme('nukeide-dark');
        } else if (currentTheme.id === 'light-theia' || currentTheme.id === 'light') {
            // Convert Theia light to Nuke light
            this.themeService.setCurrentTheme('nukeide-light');
        } else {
            // Save current theme (could be nukeide already)
            this.saveThemeToLocalStorage();
        }

        // Listen for theme changes and save to nuke-theme
        this.themeService.onDidColorThemeChange(() => {
            this.saveThemeToLocalStorage();
            this.updateFavicon();
        });
    }

    protected saveThemeToLocalStorage(): void {
        try {
            const currentTheme = this.themeService.getCurrentTheme();
            if (!currentTheme) return;

            const config = getThemeConfig(currentTheme.id);
            if (!config) return;

            const otherThemeId = config.type === 'dark'
                ? currentTheme.id.replace('dark', 'light')
                : currentTheme.id.replace('light', 'dark');
            const otherConfig = getThemeConfig(otherThemeId);

            if (!otherConfig) {
                console.error(`Theme variant not found: ${otherThemeId}`);
                return;
            }

            const colors = config.type === 'dark' ? config.colors : otherConfig.colors;
            const otherColors = config.type === 'dark' ? otherConfig.colors : config.colors;

            localStorage.setItem('nuke-theme', JSON.stringify({
                id: currentTheme.id,
                label: currentTheme.label,
                accentDark: colors.accent,
                accentDarkLight: colors.accentLight,
                accentDarkDark: colors.accentDark,
                backgroundDark: colors.background,
                backgroundDarkRgb: colors.backgroundRgb,
                foregroundDark: colors.foreground,
                foregroundInverseDark: colors.foregroundInverse,
                accentLight: otherColors.accent,
                accentLightLight: otherColors.accentLight,
                accentLightDark: otherColors.accentDark,
                backgroundLight: otherColors.background,
                backgroundLightRgb: otherColors.backgroundRgb,
                foregroundLight: otherColors.foreground,
                foregroundInverseLight: otherColors.foregroundInverse
            }));
        } catch (e) {
            console.error('[Theme] Save error:', e);
        }
    }

    protected getThemeFromLocalStorage(): { id: string; label: string } | null {
        try {
            const stored = localStorage.getItem('nuke-theme');
            if (stored) {
                return JSON.parse(stored);
            }
        } catch (e) {
            // Ignore localStorage errors
        }
        return null;
    }
}
