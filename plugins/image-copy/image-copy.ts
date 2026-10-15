import type { useSdk } from "@get-bb/plugin-sdk/app";

const copyIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
// shortcut: BB has no per-link action slot; recheck these markers when its chat renderer changes.
const messageSelector = '[data-message-column], [data-timeline-row-id]';
const linkSelector = '[data-message-column] a[href], [data-timeline-row-id] a[href]';
const imageExtension = /\.(png|jpe?g|webp|gif|avif|bmp|svg|ico)$/i;
type ImageReader = (src: string, signal: AbortSignal) => Promise<Blob>;

function isImageLink(link: HTMLAnchorElement) {
  try {
    const url = new URL(link.href);
    return ["file:", "http:", "https:"].includes(url.protocol) && imageExtension.test(decodeURIComponent(url.pathname));
  } catch { return false; }
}

const fetchImage: ImageReader = async (src, signal) => {
  const response = await fetch(src, { signal });
  if (!response.ok) throw new Error("Could not load image");
  return response.blob();
};

export async function readLinkedImage(sdk: ReturnType<typeof useSdk>, threadId: string, src: string, signal: AbortSignal): Promise<Blob> {
  const url = new URL(src);
  if (url.protocol !== "file:") return fetchImage(src, signal);
  if (url.host) throw new Error("Remote file URLs are unsupported");
  const path = decodeURIComponent(url.pathname);
  const storage = await sdk.threads.storageLocation({ threadId, signal });
  let rootPath = storage.storageRootPath;
  let hostId = storage.hostId;
  if (!path.startsWith(rootPath.replace(/\/$/, "") + "/")) {
    const thread = await sdk.threads.get({ threadId, signal });
    if (!thread.environmentId) throw new Error("This thread has no workspace");
    const environment = await sdk.environments.get({ environmentId: thread.environmentId, signal });
    if (!environment.path || !environment.hostId) throw new Error("This workspace is unavailable");
    rootPath = environment.path;
    hostId = environment.hostId;
  }
  const file = await sdk.files.read({ hostId, rootPath, path, signal });
  const mimeType = file.mimeType ?? ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", svg: "image/svg+xml", ico: "image/x-icon" }[path.split(".").pop()!.toLowerCase()] ?? `image/${path.split(".").pop()!.toLowerCase()}`);
  if (!mimeType.startsWith("image/")) throw new Error("The linked file is not an image");
  return new Blob([file.contentEncoding === "base64" ? Uint8Array.from(atob(file.content), (char) => char.charCodeAt(0)) : file.content], { type: mimeType });
}

export async function imageAsPng(src: string, signal: AbortSignal, readImage: ImageReader = fetchImage): Promise<Blob> {
  const blob = await readImage(src, signal);
  if (blob.type.toLowerCase() === "image/png") return blob;
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    signal.throwIfAborted();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not convert image");
    context.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((png) => png ? resolve(png) : reject(new Error("Could not convert image")), "image/png");
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function mountImageCopyButtons({ signal }: { signal: AbortSignal }, readImage: ImageReader = fetchImage) {
  const controls = new Map<HTMLAnchorElement, HTMLSpanElement>();
  const refresh = () => {
    for (const [link, control] of controls) {
      if (!link.isConnected || !control.isConnected || !link.matches(linkSelector) || !isImageLink(link)) {
        control.remove();
        controls.delete(link);
      }
    }
    for (const link of document.querySelectorAll<HTMLAnchorElement>(linkSelector)) {
      if (!isImageLink(link) || controls.has(link)) continue;
      const control = document.createElement("span");
      control.dataset.imageCopy = "";
      control.dataset.bbPlugin = "image-copy";
      control.className = "inline-flex items-center gap-1 ml-1 align-middle text-xs text-muted-foreground";
      const button = document.createElement("button");
      button.type = "button";
      button.title = "Copy image";
      button.setAttribute("aria-label", "Copy image");
      button.className = "inline-flex size-5 items-center justify-center rounded-md hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50";
      button.innerHTML = copyIcon;
      const status = document.createElement("span");
      status.setAttribute("role", "status");
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
          status.textContent = "Image clipboard unavailable. Open BB over HTTPS.";
          return;
        }
        button.disabled = true;
        status.textContent = "";
        try {
          const png = imageAsPng(link.href, signal, readImage);
          // ClipboardItem must be created during the click, before fetching/decoding (Safari).
          png.catch(() => {});
          await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
          if (!signal.aborted) status.textContent = "Copied";
        } catch {
          if (!signal.aborted) status.textContent = "Copy failed. Check clipboard permission and image access.";
        } finally {
          button.disabled = false;
        }
      }, { signal });
      control.append(button, status);
      link.after(control);
      controls.set(link, control);
    }
  };
  const observer = new MutationObserver((records) => {
    const changed = records.some((record) => {
      const target = record.target as Element;
      if (record.type === "attributes") return target.matches(linkSelector) || controls.has(target as HTMLAnchorElement);
      const inMessage = target.nodeType === 1 && target.closest(messageSelector) !== null;
      return [...record.addedNodes, ...record.removedNodes].some((node) => {
        if (node.nodeType !== 1) return false;
        const element = node as Element;
        if (element.matches(messageSelector) || element.querySelector(messageSelector)) return true;
        if (inMessage && (element.matches("a[href]") || element.querySelector("a[href]"))) return true;
        // Restore a control removed by the host, while ignoring our own removals.
        return element.hasAttribute("data-image-copy") && !element.isConnected && Array.from(controls.values()).includes(element as HTMLSpanElement);
      });
    });
    if (changed) refresh();
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["href"] });
  refresh();
  return () => {
    observer.disconnect();
    for (const control of controls.values()) control.remove();
    controls.clear();
  };
}
