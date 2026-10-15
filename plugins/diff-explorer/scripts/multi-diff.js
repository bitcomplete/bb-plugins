// VS Code's multi-diff editor (the Git: View Changes view): a virtualized list
// that reuses a small pool of diff editors. Monaco ships the widget but not its
// view models, so DocumentItem and EditorViewModel recreate them from VS Code's
// multiDiffEditorViewModel.ts.
import { StandaloneServices } from "../node_modules/monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js";
import { IStandaloneThemeService } from "../node_modules/monaco-editor/esm/vs/editor/standalone/common/standaloneTheme.js";
import { IInstantiationService } from "../node_modules/monaco-editor/esm/vs/platform/instantiation/common/instantiation.js";
import { MultiDiffEditorWidgetImpl } from "../node_modules/monaco-editor/esm/vs/editor/browser/widget/multiDiffEditor/multiDiffEditorWidgetImpl.js";
import { DiffEditorViewModel } from "../node_modules/monaco-editor/esm/vs/editor/browser/widget/diffEditor/diffEditorViewModel.js";
import { DiffEditorOptions } from "../node_modules/monaco-editor/esm/vs/editor/browser/widget/diffEditor/diffEditorOptions.js";
import { RefCounted } from "../node_modules/monaco-editor/esm/vs/editor/browser/widget/diffEditor/utils.js";
import { observableValue } from "../node_modules/monaco-editor/esm/vs/base/common/observableInternal/observables/observableValue.js";
import { constObservable } from "../node_modules/monaco-editor/esm/vs/base/common/observableInternal/observables/constObservable.js";
import { derived } from "../node_modules/monaco-editor/esm/vs/base/common/observableInternal/observables/derived.js";
import { createDiffSearch } from "./diff-search.js";

class DocumentItem {
  constructor(documentDiffItem, editorViewModel, instantiationService) {
    this.documentDiffItem = documentDiffItem;
    this.collapsed = observableValue(this, false);
    this.lastTemplateData = observableValue(this, { contentHeight: documentDiffItem.estimatedHeight, selections: undefined });
    this.isActive = derived(this, (reader) => editorViewModel.activeDiffItem.read(reader) === this);
    this.isAlive = constObservable(true);
    const options = instantiationService.createInstance(DiffEditorOptions, documentDiffItem.options);
    this.diffEditorViewModelRef = RefCounted.create(
      instantiationService.createInstance(
        DiffEditorViewModel,
        { original: documentDiffItem.original, modified: documentDiffItem.modified },
        options,
      ),
    );
  }
  get originalUri() {
    return this.documentDiffItem.original?.uri;
  }
  get modifiedUri() {
    return this.documentDiffItem.modified?.uri;
  }
  setIsFocused() {} // Required by the widget; it reads focus from the editor templates.
  getKey() {
    return JSON.stringify([this.originalUri?.toString(), this.modifiedUri?.toString()]);
  }
  dispose() {
    this.diffEditorViewModelRef.dispose();
  }
}

class EditorViewModel {
  constructor(instantiationService) {
    this.instantiationService = instantiationService;
    this.activeDiffItem = observableValue(this, undefined);
    this.activeDiffItem.setCache = (value, tx) => this.activeDiffItem.set(value, tx);
    this.items = observableValue(this, []);
    this.isLoading = constObservable(false);
  }
  // Keeps the item, and so its editor and scroll place, of every document whose models are unchanged.
  setDocuments(documents) {
    const previous = this.items.get();
    const next = documents.map(
      (d) =>
        previous.find((item) => item.documentDiffItem.modified === d.modified && item.documentDiffItem.options === d.options) ??
        new DocumentItem(d, this, this.instantiationService),
    );
    this.items.set(next, undefined);
    // Pre-set so the widget does not focus and scroll to the first change on load.
    if (!next.includes(this.activeDiffItem.get())) this.activeDiffItem.set(next[0], undefined);
    for (const item of previous) if (!next.includes(item)) item.dispose();
  }
  dispose() {
    for (const item of this.items.get()) item.dispose();
  }
}

/**
 * documents: { path: string, original: ITextModel, modified: ITextModel, label: string, options: IDiffEditorOptions, estimatedHeight: number }[]
 */
export function createMultiDiffEditor(element, onFileAction) {
  element.style.cssText = "height:100%;display:flex;flex-direction:column";
  const editorElement = document.createElement("div");
  editorElement.style.cssText = "flex:1;min-height:0";
  element.appendChild(editorElement);
  const instantiationService = StandaloneServices.get(IInstantiationService);
  // monaco.editor.create does this; without it the theme stylesheet (token and diff colors) is never injected.
  const theme = StandaloneServices.get(IStandaloneThemeService).registerEditorContainer(element);
  const viewModel = new EditorViewModel(instantiationService);
  let documentsByUri = new Map();
  const dimension = observableValue("dimension", undefined);
  const viewModelSource = observableValue("viewModel", undefined);
  const widget = instantiationService.createInstance(
    MultiDiffEditorWidgetImpl,
    editorElement,
    dimension,
    viewModelSource,
    {
      headerClickToCollapse: true,
      createResourceLabel: (el) => {
        let currentUri;
        const actions = document.createElement("div");
        actions.className = "actions";
        actions.style.cssText = "display:flex;gap:4px;margin-left:auto";
        const menu = document.createElement("div");
        menu.popover = "auto";
        menu.setAttribute("aria-label", "Ignore options");
        menu.style.cssText = "position:fixed;margin:0;padding:4px;border:1px solid var(--vscode-widget-border,GrayText);border-radius:6px;background:var(--vscode-editorWidget-background,Canvas);color:var(--vscode-editorWidget-foreground,CanvasText);box-shadow:0 4px 12px #0003;max-width:calc(100vw - 16px)";
        actions.appendChild(menu);
        const buttons = el.classList.contains("modified") ? [
          ["delete", "Delete file", '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>'],
          ["ignore", "Ignore file", '<path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.2A11 11 0 0 1 12 5c7 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6A17 17 0 0 0 2 12s3 7 10 7a11 11 0 0 0 5.4-1.4"/>'],
        ].map(([action, title, icon]) => {
          const button = document.createElement("button");
          button.type = "button";
          button.title = title;
          button.setAttribute("aria-label", title);
          button.style.cssText = "display:flex;align-items:center;padding:4px;color:inherit;background:transparent;border:0;cursor:pointer";
          button.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg>`;
          if (action === "delete") button.onclick = () => onFileAction(currentUri.path, action);
          else {
            button.setAttribute("aria-expanded", "false");
            menu.ontoggle = () => button.setAttribute("aria-expanded", String(menu.matches(":popover-open")));
            button.onclick = () => {
              if (menu.matches(":popover-open")) { menu.hidePopover(); return; }
              const relative = documentsByUri.get(currentUri.toString()).path;
              const slash = relative.lastIndexOf("/");
              const directory = slash === -1 ? "" : relative.slice(0, slash + 1);
              const filename = relative.slice(slash + 1);
              const dot = filename.lastIndexOf(".");
              const scopes = [["", relative]];
              if (directory) scopes.push(["-directory", directory]);
              if (dot > 0) scopes.push(["-extension", `${directory}*${filename.slice(dot)}`]);
              const choices = [true, false].flatMap((local) => scopes.map(([scope, target]) => [
                `ignore${local ? "-local" : ""}${scope}`, `Ignore${local ? " locally" : ""} ${target}`,
              ]));
              menu.replaceChildren(...choices.map(([choice, label]) => {
                const item = document.createElement("button");
                item.type = "button";
                item.textContent = label;
                item.title = `${label} (${choice.startsWith("ignore-local") ? "add to Git info/exclude" : "add to .gitignore"})`;
                item.style.cssText = "display:block;width:100%;padding:6px 8px;font:inherit;text-align:left;color:inherit;background:transparent;border:0;cursor:pointer;overflow-wrap:anywhere";
                item.onclick = () => {
                  menu.hidePopover();
                  button.focus();
                  onFileAction(currentUri.path, choice);
                };
                return item;
              }));
              const rect = button.getBoundingClientRect();
              menu.style.font = getComputedStyle(el).font;
              menu.showPopover();
              menu.style.left = `${Math.max(8, Math.min(rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8))}px`;
              menu.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - menu.offsetHeight - 8)}px`;
              menu.firstElementChild.focus();
            };
          }
          actions.appendChild(button);
          return button;
        }) : [];
        if (buttons.length) el.closest(".header-content").appendChild(actions);
        return {
          setUri(uri, options) {
            if (currentUri?.toString() !== uri?.toString() && menu.matches(":popover-open")) menu.hidePopover();
            currentUri = uri;
            const document = uri === undefined ? undefined : documentsByUri.get(uri.toString());
            el.textContent = uri === undefined ? "" : (document?.label ?? uri.path);
            el.style.textDecoration = options?.strikethrough ? "line-through" : "";
            for (const button of buttons) {
              button.disabled = uri === undefined || (button.title === "Delete file" && document?.options.readOnly);
              button.style.opacity = button.disabled ? "0.4" : "1";
            }
          },
          dispose() { actions.remove(); },
        };
      },
    },
  );
  let searchEditor;
  function restoreSearchLayout() {
    if (searchEditor) {
      searchEditor.updateOptions({ renderSideBySide: false });
      searchEditor = undefined;
    }
  }
  const search = createDiffSearch(element, (match) => {
    restoreSearchLayout();
    if (!match) return;
    const item = viewModel.items.get().find((item) => item.documentDiffItem.modified === match.document.modified);
    item.collapsed.set(false, undefined);
    widget.reveal({ original: item.originalUri, modified: item.modifiedUri });
    const diff = widget.activeControl.get();
    if (!diff) return;
    // Inline deleted lines are view zones, not a selectable original editor.
    if (match.side === "original") {
      diff.updateOptions({ renderSideBySide: true, useInlineViewWhenSpaceIsLimited: false });
      searchEditor = diff;
    }
    const editor = match.side === "original" ? diff.getOriginalEditor() : diff.getModifiedEditor();
    editor.setSelection(match.range);
    editor.revealRangeInCenter(match.range);
  }, () => widget.activeControl.get()?.getModifiedEditor().focus());
  const resize = new ResizeObserver(() => dimension.set({ width: editorElement.clientWidth, height: editorElement.clientHeight }, undefined));
  resize.observe(editorElement);
  // Like VS Code: create the widget empty, then attach the view model.
  viewModelSource.set(viewModel, undefined);
  return {
    openSearch() { search.open(); },
    update(documents) {
      restoreSearchLayout();
      documentsByUri = new Map(documents.map((d) => [d.modified.uri.toString(), d]));
      viewModel.setDocuments(documents);
      search.update(documents);
    },
    dispose() {
      restoreSearchLayout();
      search.dispose();
      resize.disconnect();
      widget.dispose();
      theme.dispose();
      viewModel.dispose();
      editorElement.remove();
    },
  };
}
