#!/usr/bin/env node
/**
 * Generate preload.html from template with version and tips injection
 * Reads version from applications/browser/package.json
 * Reads tips from resources/tips.yml
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT_DIR = path.join(__dirname, '..');
const RESOURCES_DIR = path.join(ROOT_DIR, 'resources');
const BROWSER_PACKAGE_JSON = path.join(ROOT_DIR, 'applications', 'browser', 'package.json');
const TIPS_YML = path.join(RESOURCES_DIR, 'tips.yml');
const TIPS_JSON = path.join(RESOURCES_DIR, 'tips.json'); // Fallback

function loadTips() {
    let tips = [];
    let tipDuration = 8000;

    // Try to load from YAML first
    if (fs.existsSync(TIPS_YML)) {
        try {
            const yamlContent = fs.readFileSync(TIPS_YML, 'utf8');
            const tipsData = yaml.load(yamlContent);
            
            if (tipsData.tips && Array.isArray(tipsData.tips)) {
                // Support both simple strings and objects with text/icon/category
                tips = tipsData.tips.map(t => {
                    if (typeof t === 'string') return t;
                    if (t.text) {
                        // Optionally include icon in the tip text
                        return t.icon ? `${t.icon} ${t.text}` : t.text;
                    }
                    return '';
                }).filter(t => t); // Remove empty strings
                console.log(`[generate-preload] Loaded ${tips.length} tips from tips.yml`);
            }
            
            if (tipsData.settings && tipsData.settings.tipDuration) {
                tipDuration = tipsData.settings.tipDuration;
                console.log(`[generate-preload] Tip duration: ${tipDuration}ms`);
            }
            
            return { tips, tipDuration };
        } catch (e) {
            console.log(`[generate-preload] Error parsing tips.yml: ${e.message}`);
        }
    }

    // Fallback to JSON
    if (fs.existsSync(TIPS_JSON)) {
        try {
            const tipsData = JSON.parse(fs.readFileSync(TIPS_JSON, 'utf8'));
            if (tipsData.tips && Array.isArray(tipsData.tips)) {
                tips = tipsData.tips.map(t => t.text || t).filter(t => t);
                console.log(`[generate-preload] Loaded ${tips.length} tips from tips.json`);
            }
            if (tipsData.settings && tipsData.settings.tipDuration) {
                tipDuration = tipsData.settings.tipDuration;
            }
        } catch (e) {
            console.log(`[generate-preload] Error parsing tips.json: ${e.message}`);
        }
    } else {
        console.log(`[generate-preload] tips.yml not found, using fallback tips`);
    }

    return { tips, tipDuration };
}

function main() {
    try {
        // Read browser package.json for version and app info
        const packageJson = JSON.parse(fs.readFileSync(BROWSER_PACKAGE_JSON, 'utf8'));
        const version = packageJson.version || '0.0.0';
        const productName = packageJson.productName || 'NukeIDE';
        const repoUrl = packageJson.repository?.url?.replace(/\.git$/, '') || 'https://github.com/nukehub-dev/nuke-ide';
        
        console.log(`[generate-preload] Using version: ${version}`);
        console.log(`[generate-preload] Product name: ${productName}`);
        console.log(`[generate-preload] Repository URL: ${repoUrl}`);

        // Load tips
        let { tips, tipDuration } = loadTips();

        // Fallback tips if no tips file exists or is empty
        if (tips.length === 0) {
            tips = [
                "Use keyboard shortcuts to speed up development! Try Ctrl+P for quick file navigation.",
                "Save your work frequently. Auto-save can be enabled in preferences.",
                "Press F1 to open the Command Palette for quick access to all commands."
            ];
            console.log(`[generate-preload] Using ${tips.length} fallback tips`);
        }

        // Read template
        const templatePath = path.join(RESOURCES_DIR, 'preload.template.html');
        const outputPath = path.join(RESOURCES_DIR, 'preload.html');
        
        if (!fs.existsSync(templatePath)) {
            console.error(`[generate-preload] Template not found: ${templatePath}`);
            process.exit(1);
        }

        let template = fs.readFileSync(templatePath, 'utf8');

        // Escape special characters for JavaScript string insertion
        const escapedTips = tips.map(tip => 
            tip.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"')
        );

        // Replace placeholders
        template = template
            .replace(/\{\{VERSION\}\}/g, version)
            .replace(/\{\{PRODUCT_NAME\}\}/g, productName)
            .replace(/\{\{REPO_URL\}\}/g, repoUrl)
            .replace(/\{\{TIP_DURATION\}\}/g, tipDuration.toString())
            .replace(/\{\{TIPS_ARRAY\}\}/g, JSON.stringify(escapedTips))
            .replace(/\{\{GENERATED_AT\}\}/g, new Date().toISOString());

        // Write output
        fs.writeFileSync(outputPath, template, 'utf8');
        
        console.log(`[generate-preload] Generated: ${outputPath}`);
        console.log(`[generate-preload] Done!`);

    } catch (error) {
        console.error('[generate-preload] Error:', error.message);
        process.exit(1);
    }
}

main();
