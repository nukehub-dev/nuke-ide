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
  LOGOUT: {
    id: "lab.logout",
    label: "Logout",
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
    // Add to Theia's Settings Menu (FILE_SETTINGS_SUBMENU)
    menus.registerMenuAction(CommonMenus.FILE_SETTINGS_SUBMENU, {
      commandId: LabCommands.OPEN_LAB_HOME.id,
      label: "NukeLab Home",
    });
  }
}
