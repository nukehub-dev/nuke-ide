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
        // ========== Dark ==========
        const darkTheme = {
            $schema: 'vscode://schemas/color-theme',
            name: 'Dark',
            type: 'dark',
            colors: {
                // Brand Colors - Orange accent
                'focusBorder': '#f37524',
                'foreground': '#d4d4d4',
                'descriptionForeground': '#9ca3af',
                'errorForeground': '#f48771',
                
                // Button - Primary orange, secondary gray
                'button.background': '#f37524',
                'button.hoverBackground': '#f5a623',
                'button.foreground': '#ffffff',
                'button.secondaryBackground': '#4a4a4a',
                'button.secondaryHoverBackground': '#5a5a5a',
                'button.secondaryForeground': '#ffffff',
                
                // Links
                'textLink.foreground': '#f37524',
                'textLink.activeForeground': '#f5a623',
                
                // Activity Bar
                'activityBar.background': '#1a1a1a',
                'activityBar.foreground': '#d4d4d4',
                'activityBar.activeBorder': '#f37524',
                'activityBar.border': '#333333',
                'activityBarBadge.background': '#fd8033',
                'activityBarBadge.foreground': '#ffffff',
                
                // Side Bar
                'sideBar.background': '#1e1e1e',
                'sideBar.foreground': '#d4d4d4',
                'sideBarTitle.foreground': '#bbbbbb',
                'sideBar.border': '#333333',
                'sideBarSectionHeader.background': '#252526',
                'sideBarSectionHeader.foreground': '#bbbbbb',
                
                // Status Bar
                'statusBar.background': '#1a1a1a',
                'statusBar.foreground': '#d4d4d4',
                'statusBar.border': '#333333',
                'statusBar.noFolderBackground': '#1a1a1a',
                'statusBarItem.remoteBackground': '#4a4a4a',
                'statusBarItem.remoteForeground': '#ffffff',
                'statusBarItem.hoverBackground': '#333333',
                'statusBarItem.activeBackground': '#444444',
                
                // Title Bar
                'titleBar.activeBackground': '#1a1a1a',
                'titleBar.activeForeground': '#cccccc',
                'titleBar.border': '#333333',
                'titleBar.inactiveBackground': '#1a1a1a',
                'titleBar.inactiveForeground': '#808080',
                
                // Menubar
                'menubar.selectionBackground': '#5a5a5a',
                'menubar.selectionForeground': '#ffffff',
                'menubar.selectionBorder': '#5a5a5a',
                'menu.background': '#252526',
                'menu.foreground': '#cccccc',
                'menu.selectionBackground': '#5a5a5a',
                'menu.selectionForeground': '#ffffff',
                'menu.selectionBorder': '#5a5a5a',
                'menu.separatorBackground': '#444444',
                
                // Lists
                'list.activeSelectionBackground': '#37373d',
                'list.activeSelectionForeground': '#ffffff',
                'list.inactiveSelectionBackground': '#37373d',
                'list.inactiveSelectionForeground': '#cccccc',
                'list.hoverBackground': '#2a2d2e',
                'list.hoverForeground': '#cccccc',
                'list.highlightForeground': '#f37524',
                'list.focusBackground': '#2a2d2e',
                'list.focusForeground': '#cccccc',
                'list.focusOutline': '#f37524',
                
                // Input
                'input.background': '#3c3c3c',
                'input.foreground': '#cccccc',
                'input.border': '#3c3c3c',
                'input.placeholderForeground': '#808080',
                'inputOption.activeBorder': '#f37524',
                'inputOption.activeBackground': '#4a4a4a60',
                'inputValidation.infoBackground': '#063b49',
                'inputValidation.infoBorder': '#007acc',
                'inputValidation.warningBackground': '#352a05',
                'inputValidation.warningBorder': '#b89500',
                'inputValidation.errorBackground': '#5a1d1d',
                'inputValidation.errorBorder': '#be1100',
                
                // Dropdown
                'dropdown.background': '#3c3c3c',
                'dropdown.foreground': '#cccccc',
                'dropdown.border': '#3c3c3c',
                
                // Badge
                'badge.background': '#4a4a4a',
                'badge.foreground': '#ffffff',
                
                // Progress Bar
                'progressBar.background': '#f37524',
                
                // Panel
                'panel.background': '#1e1e1e',
                'panel.border': '#333333',
                'panelTitle.activeForeground': '#cccccc',
                'panelTitle.activeBorder': '#f37524',
                'panelTitle.inactiveForeground': '#808080',
                
                // Terminal
                'terminal.background': '#1e1e1e',
                'terminal.foreground': '#d4d4d4',
                'terminal.border': '#333333',
                'terminal.selectionBackground': '#264f7840',
                
                // Tabs
                'tab.activeBackground': '#1e1e1e',
                'tab.activeForeground': '#ffffff',
                'tab.activeBorder': '#f37524',
                'tab.activeBorderTop': '#f37524',
                'tab.inactiveBackground': '#2d2d2d',
                'tab.inactiveForeground': '#808080',
                'tab.hoverBackground': '#2d2d2d',
                'tab.hoverForeground': '#cccccc',
                'tab.border': '#252526',
                'tab.unfocusedActiveBorder': '#333333',
                'tab.unfocusedActiveBorderTop': '#333333',
                
                // Editor
                'editor.background': '#1e1e1e',
                'editor.foreground': '#d4d4d4',
                'editorLineNumber.foreground': '#858585',
                'editorLineNumber.activeForeground': '#c6c6c6',
                'editor.selectionBackground': '#264f78',
                'editor.selectionHighlightBackground': '#add6ff26',
                'editor.wordHighlightBackground': '#575757b8',
                'editor.wordHighlightStrongBackground': '#004972b8',
                'editor.findMatchBackground': '#515c6a',
                'editor.findMatchHighlightBackground': '#ea5c0055',
                'editor.findRangeHighlightBackground': '#3a3d4166',
                'editor.hoverHighlightBackground': '#264f7840',
                'editorWidget.background': '#252526',
                'editorWidget.foreground': '#cccccc',
                'editorWidget.border': '#454545',
                'editorWidget.resizeBorder': '#f37524',
                
                // Breadcrumb
                'breadcrumb.background': '#1e1e1e',
                'breadcrumb.foreground': '#ccccccb3',
                'breadcrumb.focusForeground': '#e0e0e0',
                'breadcrumb.activeSelectionForeground': '#e0e0e0',
                'breadcrumbPicker.background': '#252526',
                
                // Picker
                'pickerGroup.foreground': '#f37524',
                'pickerGroup.border': '#3f3f46',
                'quickInput.background': '#252526',
                'quickInput.foreground': '#cccccc',
                'quickInputList.focusBackground': '#5a5a5a',
                'quickInputList.focusForeground': '#ffffff',
                
                // Notifications
                'notificationCenter.border': '#333333',
                'notificationCenterHeader.foreground': '#cccccc',
                'notificationCenterHeader.background': '#252526',
                'notificationToast.border': '#333333',
                'notifications.foreground': '#cccccc',
                'notifications.background': '#252526',
                'notifications.border': '#333333',
                'notificationLink.foreground': '#f37524',
                
                // Settings
                'settings.headerForeground': '#ffffff',
                'settings.modifiedItemIndicator': '#4a4a4a',
                'settings.dropdownBackground': '#3c3c3c',
                'settings.dropdownForeground': '#cccccc',
                'settings.dropdownBorder': '#3c3c3c',
                'settings.checkboxBackground': '#3c3c3c',
                'settings.checkboxForeground': '#cccccc',
                'settings.checkboxBorder': '#3c3c3c',
                'settings.textInputBackground': '#3c3c3c',
                'settings.textInputForeground': '#cccccc',
                'settings.textInputBorder': '#3c3c3c',
                'settings.numberInputBackground': '#3c3c3c',
                'settings.numberInputForeground': '#cccccc',
                'settings.numberInputBorder': '#3c3c3c',
                
                // Scrollbar
                'scrollbar.shadow': '#000000',
                'scrollbarSlider.background': '#5a5a5a40',
                'scrollbarSlider.hoverBackground': '#5a5a5a60',
                'scrollbarSlider.activeBackground': '#5a5a5a80',
                
                // Keybinding
                'keybindingLabel.background': '#3c3c3c',
                'keybindingLabel.foreground': '#cccccc',
                'keybindingLabel.border': '#3c3c3c',
                'keybindingLabel.bottomBorder': '#3c3c3c',
            },
            tokenColors: [],
            semanticHighlighting: true
        };

        this.monacoThemeRegistry.register(darkTheme, {}, 'nukeide-dark', 'vs-dark');

        this.themeService.register({
            id: 'nukeide-dark',
            type: 'dark',
            label: 'Dark',
            description: 'theme with orange accents',
            editorTheme: 'nukeide-dark'
        });

        // ========== Light ==========
        const lightTheme = {
            $schema: 'vscode://schemas/color-theme',
            name: 'Light',
            type: 'light',
            colors: {
                // Brand Colors - Orange accent
                'focusBorder': '#e06010',
                'foreground': '#2c3e50',
                'descriptionForeground': '#5a6c7d',
                'errorForeground': '#d13b3b',
                
                // Button
                'button.background': '#f37524',
                'button.hoverBackground': '#e06010',
                'button.foreground': '#ffffff',
                'button.secondaryBackground': '#e4e4e4',
                'button.secondaryHoverBackground': '#d4d4d4',
                'button.secondaryForeground': '#2c3e50',
                
                // Links
                'textLink.foreground': '#e06010',
                'textLink.activeForeground': '#f37524',
                
                // Activity Bar
                'activityBar.background': '#f8f9fa',
                'activityBar.foreground': '#424242',
                'activityBar.activeBorder': '#f37524',
                'activityBar.border': '#e1e4e8',
                'activityBarBadge.background': '#4a4a4a',
                'activityBarBadge.foreground': '#ffffff',
                
                // Side Bar
                'sideBar.background': '#f8f9fa',
                'sideBar.foreground': '#424242',
                'sideBarTitle.foreground': '#24292f',
                'sideBar.border': '#e1e4e8',
                'sideBarSectionHeader.background': '#f0f1f2',
                'sideBarSectionHeader.foreground': '#24292f',
                
                // Status Bar
                'statusBar.background': '#f8f9fa',
                'statusBar.foreground': '#424242',
                'statusBar.border': '#e1e4e8',
                'statusBar.noFolderBackground': '#f8f9fa',
                'statusBarItem.remoteBackground': '#4a4a4a',
                'statusBarItem.remoteForeground': '#ffffff',
                'statusBarItem.hoverBackground': '#e1e4e8',
                'statusBarItem.activeBackground': '#d0d7de',
                
                // Title Bar
                'titleBar.activeBackground': '#f8f9fa',
                'titleBar.activeForeground': '#2c3e50',
                'titleBar.border': '#e1e4e8',
                'titleBar.inactiveBackground': '#f8f9fa',
                'titleBar.inactiveForeground': '#6c757d',
                
                // Menubar
                'menubar.selectionBackground': '#e1e4e8',
                'menubar.selectionForeground': '#2c3e50',
                'menubar.selectionBorder': '#e1e4e8',
                'menu.background': '#ffffff',
                'menu.foreground': '#2c3e50',
                'menu.selectionBackground': '#e1e4e8',
                'menu.selectionForeground': '#2c3e50',
                'menu.selectionBorder': '#e1e4e8',
                'menu.separatorBackground': '#e1e4e8',
                
                // Lists
                'list.activeSelectionBackground': '#e8e8e8',
                'list.activeSelectionForeground': '#2c3e50',
                'list.inactiveSelectionBackground': '#f0f0f0',
                'list.inactiveSelectionForeground': '#2c3e50',
                'list.hoverBackground': '#f5f5f5',
                'list.hoverForeground': '#2c3e50',
                'list.highlightForeground': '#e06010',
                'list.focusBackground': '#f0f0f0',
                'list.focusForeground': '#2c3e50',
                'list.focusOutline': '#e06010',
                
                // Input
                'input.background': '#ffffff',
                'input.foreground': '#2c3e50',
                'input.border': '#d0d7de',
                'input.placeholderForeground': '#8c959f',
                'inputOption.activeBorder': '#f37524',
                'inputOption.activeBackground': '#4a4a4a30',
                'inputValidation.infoBackground': '#e1f5fe',
                'inputValidation.infoBorder': '#0288d1',
                'inputValidation.warningBackground': '#fff8e1',
                'inputValidation.warningBorder': '#ffa000',
                'inputValidation.errorBackground': '#ffebee',
                'inputValidation.errorBorder': '#d32f2f',
                
                // Dropdown
                'dropdown.background': '#ffffff',
                'dropdown.foreground': '#2c3e50',
                'dropdown.border': '#d0d7de',
                
                // Badge
                'badge.background': '#f37524',
                'badge.foreground': '#ffffff',
                
                // Progress Bar
                'progressBar.background': '#f37524',
                
                // Panel
                'panel.background': '#f8f9fa',
                'panel.border': '#e1e4e8',
                'panelTitle.activeForeground': '#2c3e50',
                'panelTitle.activeBorder': '#f37524',
                'panelTitle.inactiveForeground': '#6c757d',
                
                // Terminal
                'terminal.background': '#ffffff',
                'terminal.foreground': '#2c3e50',
                'terminal.border': '#e1e4e8',
                'terminal.selectionBackground': '#add6ff66',
                
                // Tabs
                'tab.activeBackground': '#ffffff',
                'tab.activeForeground': '#2c3e50',
                'tab.activeBorder': '#f37524',
                'tab.activeBorderTop': '#f37524',
                'tab.inactiveBackground': '#f0f1f2',
                'tab.inactiveForeground': '#6c757d',
                'tab.hoverBackground': '#f5f5f5',
                'tab.hoverForeground': '#2c3e50',
                'tab.border': '#e1e4e8',
                'tab.unfocusedActiveBorder': '#e1e4e8',
                'tab.unfocusedActiveBorderTop': '#e1e4e8',
                
                // Editor
                'editor.background': '#ffffff',
                'editor.foreground': '#2c3e50',
                'editorLineNumber.foreground': '#6e7681',
                'editorLineNumber.activeForeground': '#24292f',
                'editor.selectionBackground': '#add6ff',
                'editor.selectionHighlightBackground': '#add6ff66',
                'editor.wordHighlightBackground': '#d4d4d480',
                'editor.wordHighlightStrongBackground': '#add6ff80',
                'editor.findMatchBackground': '#a8ac94',
                'editor.findMatchHighlightBackground': '#ea5c0030',
                'editor.findRangeHighlightBackground': '#d4d4d440',
                'editor.hoverHighlightBackground': '#add6ff40',
                'editorWidget.background': '#f8f9fa',
                'editorWidget.foreground': '#2c3e50',
                'editorWidget.border': '#d0d7de',
                'editorWidget.resizeBorder': '#e06010',
                
                // Breadcrumb
                'breadcrumb.background': '#ffffff',
                'breadcrumb.foreground': '#6c757d',
                'breadcrumb.focusForeground': '#2c3e50',
                'breadcrumb.activeSelectionForeground': '#2c3e50',
                'breadcrumbPicker.background': '#f8f9fa',
                
                // Picker
                'pickerGroup.foreground': '#e06010',
                'pickerGroup.border': '#e1e4e8',
                'quickInput.background': '#f8f9fa',
                'quickInput.foreground': '#2c3e50',
                'quickInputList.focusBackground': '#e1e4e8',
                'quickInputList.focusForeground': '#2c3e50',
                
                // Notifications
                'notificationCenter.border': '#e1e4e8',
                'notificationCenterHeader.foreground': '#2c3e50',
                'notificationCenterHeader.background': '#f8f9fa',
                'notificationToast.border': '#e1e4e8',
                'notifications.foreground': '#2c3e50',
                'notifications.background': '#f8f9fa',
                'notifications.border': '#e1e4e8',
                'notificationLink.foreground': '#e06010',
                
                // Settings
                'settings.headerForeground': '#2c3e50',
                'settings.modifiedItemIndicator': '#4a4a4a',
                'settings.dropdownBackground': '#ffffff',
                'settings.dropdownForeground': '#2c3e50',
                'settings.dropdownBorder': '#d0d7de',
                'settings.checkboxBackground': '#ffffff',
                'settings.checkboxForeground': '#2c3e50',
                'settings.checkboxBorder': '#d0d7de',
                'settings.textInputBackground': '#ffffff',
                'settings.textInputForeground': '#2c3e50',
                'settings.textInputBorder': '#d0d7de',
                'settings.numberInputBackground': '#ffffff',
                'settings.numberInputForeground': '#2c3e50',
                'settings.numberInputBorder': '#d0d7de',
                
                // Scrollbar
                'scrollbar.shadow': '#6c757d40',
                'scrollbarSlider.background': '#6c757d30',
                'scrollbarSlider.hoverBackground': '#6c757d50',
                'scrollbarSlider.activeBackground': '#6c757d70',
                
                // Keybinding
                'keybindingLabel.background': '#e4e4e4',
                'keybindingLabel.foreground': '#2c3e50',
                'keybindingLabel.border': '#d0d7de',
                'keybindingLabel.bottomBorder': '#d0d7de',
            },
            tokenColors: [],
            semanticHighlighting: true
        };

        this.monacoThemeRegistry.register(lightTheme, {}, 'nukeide-light', 'vs');

        this.themeService.register({
            id: 'nukeide-light',
            type: 'light',
            label: 'Light',
            description: 'theme with orange accents',
            editorTheme: 'nukeide-light'
        });

        // Restore theme from nuke-theme localStorage or set default
        const savedTheme = this.getThemeFromLocalStorage();
        const currentTheme = this.themeService.getCurrentTheme();
        
        if (savedTheme && (savedTheme.id === 'nukeide-dark' || savedTheme.id === 'nukeide-light')) {
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
        });
    }

    protected saveThemeToLocalStorage(): void {
        try {
            const currentTheme = this.themeService.getCurrentTheme();
            if (currentTheme) {
                localStorage.setItem('nuke-theme', JSON.stringify({
                    id: currentTheme.id,
                    label: currentTheme.label
                }));
            }
        } catch (e) {
            // Ignore localStorage errors
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
