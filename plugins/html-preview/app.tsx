import { definePluginApp, type PluginFileOpenerProps } from "@get-bb/plugin-sdk/app";
import { mountPreviewButtons } from "./preview";

function HtmlPreview({ Original }: PluginFileOpenerProps) {
  return <Original />;
}

export default definePluginApp((app) => {
  app.slots.fileOpener({ id: "html", title: "HTML Preview", extensions: ["html", "htm"], component: HtmlPreview });
  app.contentScripts.register({ id: "html-preview", mount: mountPreviewButtons });
});
