# Nuke Tools Sidebar

The **Nuke Tools** sidebar collects every NukeIDE command into one searchable, categorized list. It is the fastest way to discover and run actions contributed by Nuke Core, OpenMC Studio, Nuke Visualizer, and any other installed extension.

## Opening the sidebar

- Click the **tools icon** in the left activity bar (between Source Control and Extensions).
- Or open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run **"Nuke: Focus Tools Sidebar"**.

The sidebar appears in the left panel, replacing the current view.

## Browsing tools

Commands are grouped into collapsible sections:

- **Environment** — switch Python environments, install packages, run health checks.
- **Health & Diagnostics** — validate configuration and show diagnostics.
- **OpenMC Studio** — project, geometry, simulation, and XML actions (only enabled when a project is open).
- **Visualizer** — open viewers and data browsers.

Each section can contain nested subcategories. Click the chevron next to a section or category to expand or collapse it. Your expansion state is remembered across sessions.

## Searching

Type in the search box at the top of the sidebar. The search looks at:

- Command labels
- Descriptions
- Keywords defined by the extension
- Category and subcategory names

Search is case-insensitive. Clear the search box to return to the categorized view.

## Disabled items

Some tools are dimmed when their command cannot run. For example, OpenMC Studio run actions are disabled until you open an OpenMC Studio project. Disabled rows do not execute when clicked.

## Running a command

Click any enabled item to run its command. You can also focus an item with the keyboard and press `Enter` or `Space`.

## Tips

- The sidebar complements the **Tools** menu in the menubar; both list the same commands.
- If an expected command is missing, make sure the contributing extension is installed and registered in the application.
- Use the search box for one-letter shortcuts, e.g. type `venv` to find environment commands.
