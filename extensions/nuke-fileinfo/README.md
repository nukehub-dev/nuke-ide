# Nuke File Info Extension

File properties and metadata viewer for NukeIDE.

## Overview

`nuke-fileinfo` adds a **Properties** command to the file explorer context menu that opens a detailed file information dialog. It surfaces metadata that is not shown in the standard file tree, including MIME types, permissions, image dimensions, text statistics, Git history, and checksums.

## Features

- **Detailed Properties** — MIME type, Unix permissions (rwx mode string), and symlink target resolution
- **Image Metadata** — Width and height for supported image formats
- **Text Statistics** — Line, word, and character counts for text-like files
- **Git Integration** — Last commit hash, message, author, and date for tracked files
- **Checksums** — On-demand MD5 and SHA-256 computation
- **Folder Size** — Recursive size calculation for directories

## Opening File Properties

Right-click any file or folder in the **Explorer** and select **Properties**.

## Dependencies

- `@theia/core` — Theia platform
- `@theia/filesystem` — File service and metadata
- `@theia/navigator` — Explorer context menu integration
- `image-size` — Image dimension detection
- `mime-types` — MIME type lookup
- `simple-git` — Git metadata retrieval

## License

BSD-2-Clause
