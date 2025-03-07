import { ContainerModule } from "@theia/core/shared/inversify";
import { CommandContribution, MenuContribution } from "@theia/core/lib/common";
import { LabMenu } from "./menu-contribution";

export default new ContainerModule((bind) => {
  bind(LabMenu).toSelf().inSingletonScope();
  bind(CommandContribution).toService(LabMenu);
  bind(MenuContribution).toService(LabMenu);
});
