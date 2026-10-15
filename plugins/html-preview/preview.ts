export function mountPreviewButtons({ signal }: { signal: AbortSignal }) {
  const buttons = new Set<HTMLButtonElement>();

  const refresh = () => {
    for (const button of buttons) {
      if (!button.isConnected || !button.parentElement!.parentElement!.querySelector('[aria-label="HTML view mode"]')) {
        button.remove();
        buttons.delete(button);
      }
    }
    for (const tabs of document.querySelectorAll('[role="tablist"][aria-label="HTML view mode"]')) {
      const toolbar = tabs.parentElement!.parentElement!;
      if (toolbar.querySelector('[data-html-preview]')) continue;
      const open = toolbar.querySelector<HTMLButtonElement>('button[aria-label^="Open in editor"]');
      const preview = tabs.querySelector<HTMLButtonElement>('button');
      if (!open || !preview) continue;

      const button = document.createElement("button");
      button.type = "button";
      button.className = open.className;
      button.dataset.htmlPreview = "";
      button.title = "Render HTML preview";
      button.setAttribute("aria-label", button.title);
      button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
      button.addEventListener("click", () => toolbar.querySelector<HTMLButtonElement>('[aria-label="HTML view mode"] button')!.click(), { signal });
      open.after(button);
      buttons.add(button);
    }
  };

  const observer = new MutationObserver(refresh);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-label"] });
  refresh();
  return () => {
    observer.disconnect();
    for (const button of buttons) button.remove();
    buttons.clear();
  };
}
