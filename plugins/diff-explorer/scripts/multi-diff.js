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

class DocumentItem {
  constructor(documentDiffItem, editorViewModel, instantiationService) {
    this.documentDiffItem = documentDiffItem;
    this.collapsed = observableValue(this, false);
    this.lastTemplateData = observableValue(this, { contentHeight: documentDiffItem.estimatedHeight, selections: undefined });
    this.isActive = derived(this, (reader) => editorViewModel.activeDiffItem.read(reader) === this);
    this._isFocusedSource = observableValue(this, constObservable(false));
    this.isFocused = derived(this, (reader) => this._isFocusedSource.read(reader).read(reader));
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
  setIsFocused(source, tx) {
    this._isFocusedSource.set(source, tx);
  }
  getKey() {
    return JSON.stringify([this.originalUri?.toString(), this.modifiedUri?.toString()]);
  }
  dispose() {
    this.diffEditorViewModelRef.dispose();
  }
}

class EditorViewModel {
  constructor(documents, instantiationService) {
    this.instantiationService = instantiationService;
    this.activeDiffItem = observableValue(this, undefined);
    this.activeDiffItem.setCache = (value, tx) => this.activeDiffItem.set(value, tx);
    this.items = observableValue(this, []);
    this.setDocuments(documents);
    this.isLoading = constObservable(false);
    this.contextKeys = undefined;
  }
  // Keeps the item, and so its editor and scroll place, of every document whose models are unchanged.
  setDocuments(documents) {
    const previous = this.items.get();
    const next = documents.map(
      (d) =>
        previous.find((item) => item.documentDiffItem.modified === d.modified) ??
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
 * documents: { original: ITextModel, modified: ITextModel, label: string, options: IDiffEditorOptions, estimatedHeight: number }[]
 */
export function createMultiDiffEditor(element, documents) {
  const instantiationService = StandaloneServices.get(IInstantiationService);
  // monaco.editor.create does this; without it the theme stylesheet (token and diff colors) is never injected.
  const theme = StandaloneServices.get(IStandaloneThemeService).registerEditorContainer(element);
  const viewModel = new EditorViewModel(documents, instantiationService);
  let labels = new Map(documents.map((d) => [d.modified.uri.toString(), d.label]));
  const dimension = observableValue("dimension", undefined);
  const viewModelSource = observableValue("viewModel", undefined);
  const widget = instantiationService.createInstance(
    MultiDiffEditorWidgetImpl,
    element,
    dimension,
    viewModelSource,
    {
      headerClickToCollapse: true,
      createResourceLabel: (el) => ({
        setUri(uri, options) {
          el.textContent = uri === undefined ? "" : (labels.get(uri.toString()) ?? uri.path);
          el.style.textDecoration = options?.strikethrough ? "line-through" : "";
        },
        dispose() {},
      }),
    },
  );
  const resize = new ResizeObserver(() => dimension.set({ width: element.clientWidth, height: element.clientHeight }, undefined));
  resize.observe(element);
  // Like VS Code: create the widget empty, then attach the view model.
  viewModelSource.set(viewModel, undefined);
  return {
    update(documents) {
      labels = new Map(documents.map((d) => [d.modified.uri.toString(), d.label]));
      viewModel.setDocuments(documents);
    },
    dispose() {
      resize.disconnect();
      widget.dispose();
      theme.dispose();
      viewModel.dispose();
    },
  };
}
