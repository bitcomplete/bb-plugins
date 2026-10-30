import { useEffect } from "react";
import { definePluginApp, useBbContext, useSdk } from "@get-bb/plugin-sdk/app";
import { mountImageCopyButtons, readLinkedImage } from "./image-copy";

function ImageLinkActions() {
  const sdk = useSdk();
  const { threadId } = useBbContext();
  useEffect(() => {
    if (!threadId) return;
    const controller = new AbortController();
    const dispose = mountImageCopyButtons({ signal: controller.signal }, (src, signal) => readLinkedImage(sdk, threadId, src, signal));
    return () => { controller.abort(); dispose(); };
  }, [sdk, threadId]);
  return null;
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "image-link-actions", component: ImageLinkActions });
});
