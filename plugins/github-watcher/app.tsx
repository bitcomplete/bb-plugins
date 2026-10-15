// The plugin's settings section: what this server's threads are watching on
// GitHub and how busy each watch has been. There is no connect step to show;
// gh is signed in by Team setup.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { WatchesSection } from "@/components/watches-section";
import { WATCHES_CHANGED } from "./channels";

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "watches",
    title: "Watches",
    description: "What this server's threads are waiting on in GitHub, how often each watch has fired, and the doorbell stream's state.",
    component: () => <WatchesSection changedChannel={WATCHES_CHANGED} targetLabel="pull request or issue" />,
  });
});
