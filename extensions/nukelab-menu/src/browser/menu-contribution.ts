import { injectable, inject } from "@theia/core/shared/inversify";
import { CommandRegistry, MenuModelRegistry } from "@theia/core/lib/common";
import { CommonMenus } from "@theia/core/lib/browser";
import { OpenerService } from "@theia/core/lib/browser/opener-service";
import URI from "@theia/core/lib/common/uri";

export const LabCommands = {
  OPEN_LAB_HOME: {
    id: "lab.openHome",
    label: "Lab Home",
  },
  JUPYTER_LAB: {
    id: "lab.jupyterlab",
    label: "Use JupyterLab (Deprecated)",
  },
  LOGOUT: {
    id: "lab.logout",
    label: "Log Out",
  },
};

@injectable()
export class LabMenu {
  @inject(OpenerService)
  protected readonly openerService: OpenerService;

  registerCommands(commands: CommandRegistry): void {
    // Register OPEN_LAB_HOME command
    commands.registerCommand(LabCommands.OPEN_LAB_HOME, {
      execute: () => {
        const baseUrl = window.location.origin;
        const uri = new URI(`${baseUrl}/home`);
        window.open(uri.toString(), "_blank");
      },
    });

    // Register JUPYTER_LAB command
    commands.registerCommand(LabCommands.JUPYTER_LAB, {
      execute: () => {
        const baseUrl = window.location.origin;
        const userPath = window.location.pathname.split('/').slice(0, 3).join('/'); // Extract `/user/{username}`
        const uri = new URI(`${baseUrl}${userPath}/lab`);
        window.open(uri.toString(), "_blank");
      },
    });

    // Register LOGOUT command
    commands.registerCommand(LabCommands.LOGOUT, {
      execute: () => {
        const baseUrl = window.location.origin;
        const uri = new URI(`${baseUrl}/logout`);
        window.open(uri.toString(), "_self");
      },
    });
  }

  registerMenus(menus: MenuModelRegistry): void {
    // Add to File menu
    menus.registerMenuAction(CommonMenus.FILE, {
      commandId: LabCommands.LOGOUT.id,
      label: LabCommands.LOGOUT.label,
    });
    menus.registerMenuAction(CommonMenus.FILE, {
      commandId: LabCommands.JUPYTER_LAB.id,
      label: LabCommands.JUPYTER_LAB.label,
    });
    // Add to Theia's Settings Menu (FILE_SETTINGS_SUBMENU)
    menus.registerMenuAction(CommonMenus.FILE_SETTINGS_SUBMENU, {
      commandId: LabCommands.OPEN_LAB_HOME.id,
      label: LabCommands.OPEN_LAB_HOME.label,
    });
  }
}
