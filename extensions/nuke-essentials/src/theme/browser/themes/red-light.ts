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

export const redLightTheme = {
    $schema: 'vscode://schemas/color-theme',
    name: 'Red Light',
    type: 'light',
    colors: {
        // Brand Colors - Red accent
        focusBorder: '#d32f2f',
        foreground: '#2c3e50',
        descriptionForeground: '#5a6c7d',
        errorForeground: '#d13b3b',

        // Button
        'button.background': '#e53935',
        'button.hoverBackground': '#d32f2f',
        'button.foreground': '#ffffff',
        'button.secondaryBackground': '#f2e2e2',
        'button.secondaryHoverBackground': '#e8d5d5',
        'button.secondaryForeground': '#2c3e50',

        // Links
        'textLink.foreground': '#d32f2f',
        'textLink.activeForeground': '#e53935',

        // Activity Bar
        'activityBar.background': '#faeaea',
        'activityBar.foreground': '#424242',
        'activityBar.activeBorder': '#d32f2f',
        'activityBar.border': '#eecaca',
        'activityBarBadge.background': '#d32f2f',
        'activityBarBadge.foreground': '#ffffff',

        // Side Bar
        'sideBar.background': '#faeaea',
        'sideBar.foreground': '#424242',
        'sideBarTitle.foreground': '#24292f',
        'sideBar.border': '#eecaca',
        'sideBarSectionHeader.background': '#f5e3e3',
        'sideBarSectionHeader.foreground': '#24292f',
        'sideBarSectionHeader.border': '#eecaca',

        // Status Bar
        'statusBar.background': '#f5e3e3',
        'statusBar.foreground': '#424242',
        'statusBar.border': '#eecaca',
        'statusBar.noFolderBackground': '#f5e3e3',
        'statusBarItem.remoteBackground': '#d32f2f',
        'statusBarItem.remoteForeground': '#ffffff',
        'statusBarItem.hoverBackground': '#eecaca',
        'statusBarItem.activeBackground': '#dfc9c9',

        // Title Bar
        'titleBar.activeBackground': '#f5e3e3',
        'titleBar.activeForeground': '#2c3e50',
        'titleBar.border': '#eecaca',
        'titleBar.inactiveBackground': '#f5e3e3',
        'titleBar.inactiveForeground': '#6c757d',

        // Menubar
        'menubar.selectionBackground': '#eecaca',
        'menubar.selectionForeground': '#2c3e50',
        'menubar.selectionBorder': '#eecaca',
        'menu.background': '#ffffff',
        'menu.border': '#eecaca',
        'menu.foreground': '#2c3e50',
        'menu.selectionBackground': '#eecaca',
        'menu.selectionForeground': '#2c3e50',
        'menu.selectionBorder': '#eecaca',
        'menu.separatorBackground': '#eecaca',

        // Lists
        'list.activeSelectionBackground': '#f5e3e3',
        'list.activeSelectionForeground': '#2c3e50',
        'list.inactiveSelectionBackground': '#faeaea',
        'list.inactiveSelectionForeground': '#2c3e50',
        'list.hoverBackground': '#f5e3e3',
        'list.hoverForeground': '#2c3e50',
        'list.highlightForeground': '#d32f2f',
        'list.focusBackground': '#f5e3e3',
        'list.focusForeground': '#2c3e50',
        'list.focusOutline': '#d32f2f',

        // Input
        'input.background': '#ffffff',
        'input.foreground': '#2c3e50',
        'input.border': '#eecaca',
        'input.placeholderForeground': '#8c959f',
        'inputOption.activeBorder': '#d32f2f',
        'inputOption.activeBackground': '#d32f2f20',
        'inputValidation.infoBackground': '#e1f5fe',
        'inputValidation.infoBorder': '#0288d1',
        'inputValidation.warningBackground': '#fff8e1',
        'inputValidation.warningBorder': '#ffa000',
        'inputValidation.errorBackground': '#ffebee',
        'inputValidation.errorBorder': '#d32f2f',
        'inputValidation.successBackground': '#e8f7ee',
        'inputValidation.successBorder': '#16a34a',

        // Dropdown
        'dropdown.background': '#ffffff',
        'dropdown.foreground': '#2c3e50',
        'dropdown.border': '#eecaca',

        // Badge
        'badge.background': '#d32f2f',
        'badge.foreground': '#ffffff',

        // Progress Bar
        'progressBar.background': '#d32f2f',

        // Panel
        'panel.background': '#faeaea',
        'panel.border': '#eecaca',
        'panelTitle.activeForeground': '#2c3e50',
        'panelTitle.activeBorder': '#d32f2f',
        'panelTitle.inactiveForeground': '#6c757d',

        // Terminal
        'terminal.background': '#fdf6f6',
        'terminal.foreground': '#2c3e50',
        'terminal.border': '#eecaca',
        'terminal.selectionBackground': '#d32f2f30',

        // Tabs
        'tab.activeBackground': '#fdf6f6',
        'tab.activeForeground': '#2c3e50',
        'tab.activeBorder': '#d32f2f',
        'tab.activeBorderTop': '#d32f2f',
        'tab.inactiveBackground': '#f5e3e3',
        'tab.inactiveForeground': '#6c757d',
        'tab.hoverBackground': '#faeaea',
        'tab.hoverForeground': '#2c3e50',
        'tab.border': '#eecaca',
        'tab.unfocusedActiveBorder': '#eecaca',
        'tab.unfocusedActiveBorderTop': '#eecaca',

        // Editor
        'editor.background': '#fdf6f6',
        'editor.foreground': '#2c3e50',
        'editorLineNumber.foreground': '#a59595',
        'editorLineNumber.activeForeground': '#24292f',
        'editor.selectionBackground': '#d32f2f20',
        'editor.selectionHighlightBackground': '#d32f2f15',
        'editor.wordHighlightBackground': '#d32f2f15',
        'editor.wordHighlightStrongBackground': '#d32f2f25',
        'editor.findMatchBackground': '#d32f2f40',
        'editor.findMatchHighlightBackground': '#d32f2f20',
        'editor.findRangeHighlightBackground': '#fcf0f0',
        'editor.hoverHighlightBackground': '#d32f2f15',
        'editorWidget.background': '#faeaea',
        'editorWidget.foreground': '#2c3e50',
        'editorWidget.border': '#eecaca',
        'editorWidget.resizeBorder': '#d32f2f',

        // Breadcrumb
        'breadcrumb.background': '#fdf6f6',
        'breadcrumb.foreground': '#6c757d',
        'breadcrumb.focusForeground': '#2c3e50',
        'breadcrumb.activeSelectionForeground': '#2c3e50',
        'breadcrumbPicker.background': '#faeaea',

        // Picker
        'pickerGroup.foreground': '#d32f2f',
        'pickerGroup.border': '#eecaca',
        'quickInput.background': '#faeaea',
        'quickInput.foreground': '#2c3e50',
        'quickInputList.focusBackground': '#eecaca',
        'quickInputList.focusForeground': '#2c3e50',

        // Notifications
        'notificationCenter.border': '#eecaca',
        'notificationCenterHeader.foreground': '#2c3e50',
        'notificationCenterHeader.background': '#faeaea',
        'notificationToast.border': '#eecaca',
        'notifications.foreground': '#2c3e50',
        'notifications.background': '#faeaea',
        'notifications.border': '#eecaca',
        'notificationLink.foreground': '#d32f2f',

        // Settings
        'settings.headerForeground': '#2c3e50',
        'settings.modifiedItemIndicator': '#d32f2f',
        'settings.dropdownBackground': '#ffffff',
        'settings.dropdownForeground': '#2c3e50',
        'settings.dropdownBorder': '#eecaca',
        'settings.checkboxBackground': '#ffffff',
        'settings.checkboxForeground': '#2c3e50',
        'settings.checkboxBorder': '#eecaca',
        'settings.textInputBackground': '#ffffff',
        'settings.textInputForeground': '#2c3e50',
        'settings.textInputBorder': '#eecaca',
        'settings.numberInputBackground': '#ffffff',
        'settings.numberInputForeground': '#2c3e50',
        'settings.numberInputBorder': '#eecaca',

        // Scrollbar
        'scrollbar.shadow': '#eecaca',
        'scrollbarSlider.background': '#d32f2f20',
        'scrollbarSlider.hoverBackground': '#d32f2f30',
        'scrollbarSlider.activeBackground': '#d32f2f40',

        // Keybinding
        'keybindingLabel.background': '#f5e3e3',
        'keybindingLabel.foreground': '#2c3e50',
        'keybindingLabel.border': '#eecaca',
        'keybindingLabel.bottomBorder': '#eecaca'
    },
    tokenColors: [],
    semanticHighlighting: true
};
