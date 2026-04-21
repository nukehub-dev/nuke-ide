# NukeLab PWA Extension

Progressive Web App support for NukeIDE.

## Overview

`nukelab-pwa` enables PWA capabilities when NukeIDE is served over the web. It registers a service worker and adds a web app manifest so NukeIDE can be installed as a standalone application on supported browsers.

## What It Does

- Registers a service worker for offline caching
- Injects a `manifest.json` link for browser installation prompts

## Note

This extension is automatic and has no user-facing configuration. It activates when the manifest and service worker files are present at `/hub/static/`.

## License

BSD-2-Clause
