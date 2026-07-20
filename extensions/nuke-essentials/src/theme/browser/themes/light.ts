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

export const lightTheme = {
    $schema: 'vscode://schemas/color-theme',
    name: 'Light',
    type: 'light',
    colors: {
        // Brand Colors - Orange accent
        focusBorder: '#e06010',
        foreground: '#3f3a34',
        descriptionForeground: '#8a8177',
        errorForeground: '#d13b3b',

        // Button
        'button.background': '#f37524',
        'button.hoverBackground': '#e06010',
        'button.foreground': '#ffffff',
        'button.secondaryBackground': '#ede9e2',
        'button.secondaryHoverBackground': '#e3ded5',
        'button.secondaryForeground': '#3f3a34',
        // Theia-native secondary buttons (.theia-button.secondary)
        'secondaryButton.background': '#ede9e2',
        'secondaryButton.foreground': '#3f3a34',
        'secondaryButton.hoverBackground': '#e3ded5',

        // Links
        'textLink.foreground': '#e06010',
        'textLink.activeForeground': '#f37524',

        // Activity Bar
        'activityBar.background': '#f2efe9',
        'activityBar.foreground': '#57504a',
        'activityBar.activeBorder': '#f37524',
        'activityBar.border': '#e4ded4',
        'activityBarBadge.background': '#e06010',
        'activityBarBadge.foreground': '#ffffff',

        // Side Bar
        'sideBar.background': '#f5f2ec',
        'sideBar.foreground': '#4a453f',
        'sideBarTitle.foreground': '#8a8177',
        'sideBar.border': '#e4ded4',
        'sideBarSectionHeader.background': '#ece8e0',
        'sideBarSectionHeader.foreground': '#6f675c',
        'sideBarSectionHeader.border': '#e4ded4',

        // Status Bar
        'statusBar.background': '#ece8e1',
        'statusBar.foreground': '#57504a',
        'statusBar.border': '#e0d9cd',
        'statusBar.noFolderBackground': '#ece8e1',
        'statusBarItem.remoteBackground': '#e06010',
        'statusBarItem.remoteForeground': '#ffffff',
        'statusBarItem.hoverBackground': '#e2dccd',
        'statusBarItem.activeBackground': '#d8d1c3',

        // Title Bar
        'titleBar.activeBackground': '#ece8e1',
        'titleBar.activeForeground': '#3f3a34',
        'titleBar.border': '#e4ded4',
        'titleBar.inactiveBackground': '#ece8e1',
        'titleBar.inactiveForeground': '#9a9184',

        // Menubar
        'menubar.selectionBackground': '#e7e1d6',
        'menubar.selectionForeground': '#3f3a34',
        'menubar.selectionBorder': '#e7e1d6',
        'menu.background': '#ffffff',
        'menu.foreground': '#3f3a34',
        'menu.selectionBackground': '#f7ead9',
        'menu.selectionForeground': '#3f3a34',
        'menu.selectionBorder': '#f7ead9',
        'menu.separatorBackground': '#ece7dd',

        // Lists
        'list.activeSelectionBackground': '#f3e7d8',
        'list.activeSelectionForeground': '#3f3a34',
        'list.inactiveSelectionBackground': '#eee9e0',
        'list.inactiveSelectionForeground': '#3f3a34',
        'list.hoverBackground': '#ece7dd',
        'list.hoverForeground': '#3f3a34',
        'list.highlightForeground': '#e06010',
        'list.focusBackground': '#f3e7d8',
        'list.focusForeground': '#3f3a34',
        'list.focusOutline': '#e06010',

        // Input
        'input.background': '#ffffff',
        'input.foreground': '#3f3a34',
        'input.border': '#ddd6ca',
        'input.placeholderForeground': '#a89f92',
        'inputOption.activeBorder': '#f37524',
        'inputOption.activeBackground': '#f3752430',
        'inputValidation.infoBackground': '#e1f5fe',
        'inputValidation.infoBorder': '#0288d1',
        'inputValidation.warningBackground': '#fff8e1',
        'inputValidation.warningBorder': '#ffa000',
        'inputValidation.errorBackground': '#ffebee',
        'inputValidation.errorBorder': '#d32f2f',

        // Dropdown
        'dropdown.background': '#ffffff',
        'dropdown.foreground': '#3f3a34',
        'dropdown.border': '#ddd6ca',

        // Badge
        'badge.background': '#e06010',
        'badge.foreground': '#ffffff',

        // Progress Bar
        'progressBar.background': '#f37524',

        // Panel
        'panel.background': '#f5f2ec',
        'panel.border': '#e4ded4',
        'panelTitle.activeForeground': '#3f3a34',
        'panelTitle.activeBorder': '#f37524',
        'panelTitle.inactiveForeground': '#9a9184',

        // Terminal
        'terminal.background': '#fdfcf9',
        'terminal.foreground': '#3f3a34',
        'terminal.border': '#e4ded4',
        'terminal.selectionBackground': '#f9e2c866',

        // Tabs
        'tab.activeBackground': '#fdfcf9',
        'tab.activeForeground': '#3f3a34',
        'tab.activeBorder': '#f37524',
        'tab.activeBorderTop': '#f37524',
        'tab.inactiveBackground': '#ede9e2',
        'tab.inactiveForeground': '#9a9184',
        'tab.hoverBackground': '#f2eee7',
        'tab.hoverForeground': '#3f3a34',
        'tab.border': '#e4ded4',
        'tab.unfocusedActiveBorder': '#e4ded4',
        'tab.unfocusedActiveBorderTop': '#e4ded4',

        // Editor
        'editor.background': '#fdfcf9',
        'editor.foreground': '#3f3a34',
        'editorLineNumber.foreground': '#b0a794',
        'editorLineNumber.activeForeground': '#6f675c',
        'editor.selectionBackground': '#f9e2c8',
        'editor.selectionHighlightBackground': '#f9e2c866',
        'editor.wordHighlightBackground': '#e8e2d680',
        'editor.wordHighlightStrongBackground': '#f9e2c880',
        'editor.findMatchBackground': '#f0c297',
        'editor.findMatchHighlightBackground': '#ea5c0030',
        'editor.findRangeHighlightBackground': '#e8e2d640',
        'editor.hoverHighlightBackground': '#f9e2c840',
        'editorWidget.background': '#f5f2ec',
        'editorWidget.foreground': '#3f3a34',
        'editorWidget.border': '#e4ded4',
        'editorWidget.resizeBorder': '#e06010',

        // Breadcrumb
        'breadcrumb.background': '#fdfcf9',
        'breadcrumb.foreground': '#9a9184',
        'breadcrumb.focusForeground': '#3f3a34',
        'breadcrumb.activeSelectionForeground': '#3f3a34',
        'breadcrumbPicker.background': '#f5f2ec',

        // Picker
        'pickerGroup.foreground': '#e06010',
        'pickerGroup.border': '#e4ded4',
        'quickInput.background': '#f5f2ec',
        'quickInput.foreground': '#3f3a34',
        'quickInputList.focusBackground': '#f3e7d8',
        'quickInputList.focusForeground': '#3f3a34',

        // Notifications
        'notificationCenter.border': '#e4ded4',
        'notificationCenterHeader.foreground': '#3f3a34',
        'notificationCenterHeader.background': '#f5f2ec',
        'notificationToast.border': '#e4ded4',
        'notifications.foreground': '#3f3a34',
        'notifications.background': '#f5f2ec',
        'notifications.border': '#e4ded4',
        'notificationLink.foreground': '#e06010',

        // Settings
        'settings.headerForeground': '#3f3a34',
        'settings.modifiedItemIndicator': '#e06010',
        'settings.dropdownBackground': '#ffffff',
        'settings.dropdownForeground': '#3f3a34',
        'settings.dropdownBorder': '#ddd6ca',
        'settings.checkboxBackground': '#ffffff',
        'settings.checkboxForeground': '#3f3a34',
        'settings.checkboxBorder': '#ddd6ca',
        'settings.textInputBackground': '#ffffff',
        'settings.textInputForeground': '#3f3a34',
        'settings.textInputBorder': '#ddd6ca',
        'settings.numberInputBackground': '#ffffff',
        'settings.numberInputForeground': '#3f3a34',
        'settings.numberInputBorder': '#ddd6ca',

        // Scrollbar
        'scrollbar.shadow': '#d9d2c5',
        'scrollbarSlider.background': '#8a817730',
        'scrollbarSlider.hoverBackground': '#8a817750',
        'scrollbarSlider.activeBackground': '#8a817770',

        // Keybinding
        'keybindingLabel.background': '#ede9e2',
        'keybindingLabel.foreground': '#3f3a34',
        'keybindingLabel.border': '#ddd6ca',
        'keybindingLabel.bottomBorder': '#ddd6ca'
    },
    tokenColors: [],
    semanticHighlighting: true
};
