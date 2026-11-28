import { definePluginApp } from "@get-bb/plugin-sdk/app";
import "./app.css";
import { PALETTE_COMMANDS } from "./src/commands";
import { mountKeyHandler } from "./src/content-script";
import { TmuxOverlay } from "./src/overlay/Overlay";
import {
  ConfigFileSection,
  SECTION_DESCRIPTION,
} from "./src/section/ConfigFileSection";
import { CONFIG_FILE_LABEL } from "./src/settings";

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "keys",
    mount: (context) => mountKeyHandler(context),
  });
  app.slots.experimental_appOverlay({
    id: "overlay",
    component: TmuxOverlay,
  });
  app.slots.settingsSection({
    id: "config-file",
    title: CONFIG_FILE_LABEL,
    description: SECTION_DESCRIPTION,
    component: ConfigFileSection,
  });
  for (const command of PALETTE_COMMANDS) app.commands.register(command);
});
