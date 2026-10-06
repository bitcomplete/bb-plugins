import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type * as Monaco from "monaco-editor";
import {
  definePluginApp,
  experimental_Icon as Icon,
  experimental_useCodeTheme,
  useBbNavigate,
  useRealtime,
  useRpc,
  type PluginThreadHeaderActionProps,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import type { DiffFile, DiffTarget, Location, rpcContract } from "./contract";

type MonacoApi = typeof Monaco;
type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type Loaded = z.infer<(typeof rpcContract)["load"]["output"]>;

// Model URIs are <scheme>://<panelId>/<absolute path>; the authority routes a model back to its panel.
const OLD = "bbold";
const NEW = "bbnew";
const FILE = "bbfile";

type PanelContext = {
  rpc: Rpc;
  environmentId: string;
  push(from: Monaco.editor.ICodeEditor, to: Location): void;
  setError(message: string | null): void;
};
const panels = new Map<string, PanelContext>();

type MultiDiffDocument = {
  original: Monaco.editor.ITextModel;
  modified: Monaco.editor.ITextModel;
  label: string;
  options: Monaco.editor.IDiffEditorOptions;
  estimatedHeight: number;
};
type Bundle = {
  monaco: MonacoApi;
  createMultiDiffEditor(
    element: HTMLElement,
    documents: MultiDiffDocument[],
  ): { update(documents: MultiDiffDocument[]): void; dispose(): void };
};
let bundlePromise: Promise<Bundle> | null = null;

function loadMonaco(baseUrl: string): Promise<Bundle> {
  return (bundlePromise ??= (async () => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `${baseUrl}/editor.css`;
    document.head.appendChild(link);
    (globalThis as any).MonacoEnvironment = {
      getWorker: () => new Worker(new URL(`${baseUrl}/editor.worker.js`, window.location.origin), { type: "module" }),
    };
    const bundle: Bundle = await import(/* @vite-ignore */ `${baseUrl}/editor.js`);
    installNavigation(bundle.monaco);
    return bundle;
  })());
}

function installNavigation(monaco: MonacoApi) {
  monaco.languages.registerDefinitionProvider("*", {
    async provideDefinition(model, position) {
      const panel = panels.get(model.uri.authority);
      if (panel === undefined || model.uri.scheme === OLD) return null;
      try {
        const { locations } = await panel.rpc.call("definition", {
          environmentId: panel.environmentId,
          path: model.uri.path,
          line: position.lineNumber,
          column: position.column,
        });
        panel.setError(null);
        // Monaco only navigates to models that exist.
        const models = await Promise.all(locations.map((l) => fileModel(monaco, model.uri.authority, panel, l.path)));
        return locations.map((l, i) => ({
          uri: models[i].uri,
          range: new monaco.Range(l.line, l.column, l.line, l.column),
        }));
      } catch (cause) {
        panel.setError(cause instanceof Error ? cause.message : String(cause));
        return null;
      }
    },
  });
  monaco.editor.registerEditorOpener({
    openCodeEditor(source, resource, selectionOrPosition) {
      const panel = panels.get(resource.authority);
      if (panel === undefined) return false;
      const target =
        selectionOrPosition === undefined
          ? { line: 1, column: 1 }
          : "startLineNumber" in selectionOrPosition
            ? { line: selectionOrPosition.startLineNumber, column: selectionOrPosition.startColumn }
            : { line: selectionOrPosition.lineNumber, column: selectionOrPosition.column };
      panel.push(source, { path: resource.path, ...target });
      return true;
    },
  });
}

async function fileModel(monaco: MonacoApi, panelId: string, panel: PanelContext, path: string) {
  const uri = monaco.Uri.from({ scheme: FILE, authority: panelId, path });
  const existing = monaco.editor.getModel(uri);
  if (existing !== null) return existing;
  const { content } = await panel.rpc.call("read", { environmentId: panel.environmentId, path });
  return monaco.editor.getModel(uri) ?? monaco.editor.createModel(content, languageFor(monaco, path), uri);
}

function languageFor(monaco: MonacoApi, filePath: string) {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return monaco.languages.getLanguages().find((l) => l.extensions?.includes(ext))?.id ?? "plaintext";
}

const EDITOR_OPTIONS = {
  readOnly: true,
  scrollBeyondLastLine: false,
  minimap: { enabled: false },
  fixedOverflowWidgets: true,
  gotoLocation: { multipleDefinitions: "goto" },
} satisfies Monaco.editor.IEditorOptions;

const DIFF_OPTIONS = {
  ...EDITOR_OPTIONS,
  renderSideBySide: false,
  hideUnchangedRegions: { enabled: true },
} satisfies Monaco.editor.IDiffEditorOptions;

const LINE_HEIGHT = 19;
const HEADER_HEIGHT = 40;

function MultiDiff({ bundle, panelId, root, files }: { bundle: Bundle; panelId: string; root: string; files: DiffFile[] }) {
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<ReturnType<Bundle["createMultiDiffEditor"]> | null>(null);
  // Models per path, updated in place on refresh so each file keeps its editor and your scroll place.
  const models = useRef(new Map<string, { original: Monaco.editor.ITextModel; modified: Monaco.editor.ITextModel }>());

  useEffect(() => {
    const created = bundle.createMultiDiffEditor(container.current!, []);
    editor.current = created;
    const owned = models.current;
    return () => {
      created.dispose();
      for (const m of owned.values()) {
        m.original.dispose();
        m.modified.dispose();
      }
      owned.clear();
    };
  }, [bundle]);

  useEffect(() => {
    const { monaco } = bundle;
    const current = models.current;
    const documents = files.map((file) => {
      const abs = `${root.replace(/\/$/, "")}/${file.path}`;
      let m = current.get(abs);
      if (m === undefined) {
        const language = languageFor(monaco, file.path);
        m = {
          original: monaco.editor.createModel(file.oldText, language, monaco.Uri.from({ scheme: OLD, authority: panelId, path: abs })),
          modified: monaco.editor.createModel(file.newText, language, monaco.Uri.from({ scheme: NEW, authority: panelId, path: abs })),
        };
        current.set(abs, m);
      } else {
        if (m.original.getValue() !== file.oldText) m.original.setValue(file.oldText);
        if (m.modified.getValue() !== file.newText) m.modified.setValue(file.newText);
      }
      return {
        ...m,
        label: `${file.path} · ${file.changeKind}`,
        options: DIFF_OPTIONS,
        // Placeholder height until the widget renders the file; ~ changed lines plus collapsed-region rows.
        estimatedHeight: HEADER_HEIGHT + (file.additions + file.deletions + 8) * LINE_HEIGHT,
      };
    });
    editor.current!.update(documents);
    const kept = new Set(documents.map((d) => d.modified));
    for (const [abs, m] of current) {
      if (kept.has(m.modified)) continue;
      m.original.dispose();
      m.modified.dispose();
      current.delete(abs);
    }
  }, [bundle, panelId, root, files]);

  return <div ref={container} className="h-full" />;
}

function FileView({ monaco, panelId, location, onError }: {
  monaco: MonacoApi;
  panelId: string;
  location: Location;
  onError(message: string): void;
}) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    let editor: Monaco.editor.IStandaloneCodeEditor | undefined;
    fileModel(monaco, panelId, panels.get(panelId)!, location.path).then((model) => {
      if (cancelled) return;
      editor = monaco.editor.create(container.current!, { ...EDITOR_OPTIONS, automaticLayout: true, model });
      const position = { lineNumber: location.line, column: location.column };
      editor.setPosition(position);
      editor.revealPositionInCenter(position);
      editor.focus();
    }, (cause) => onError(cause instanceof Error ? cause.message : String(cause)));
    return () => {
      cancelled = true;
      editor?.dispose();
    };
  }, [monaco, panelId, location, onError]);
  return <div ref={container} className="min-h-0 flex-1" />;
}

function DiffsPanel({ threadId }: PluginThreadPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const { mode } = experimental_useCodeTheme();
  const [panelId] = useState(() => `p${Math.random().toString(36).slice(2)}`);
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const monaco = bundle?.monaco ?? null;
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stack, setStack] = useState<Location[]>([]);
  const [reload, setReload] = useState(0);
  const [target, setTarget] = useState<DiffTarget>("uncommitted");
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setStack([]);
    Promise.all([rpc.call("assets", null).then(({ baseUrl }) => loadMonaco(baseUrl)), rpc.call("load", { threadId, target })]).then(
      ([b, loaded]) => {
        if (cancelled) return;
        setBundle(b);
        setData(loaded);
        setError(null);
      },
      (cause) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId, target, reload]);

  const current = useRef({ target, root: data?.root });
  current.current = { target, root: data?.root };
  useRealtime("changed", (payload) => {
    if ((payload as { root: string }).root !== current.current.root) return;
    rpc.call("load", { threadId, target }).then(
      (loaded) => {
        if (current.current.target !== target) return;
        setData((prev) => (prev !== null && JSON.stringify(prev) === JSON.stringify(loaded) ? prev : loaded));
      },
      (cause) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  });

  useEffect(() => {
    monaco?.editor.setTheme(mode === "dark" ? "vs-dark" : "vs");
  }, [monaco, mode]);

  const environmentId = data?.environmentId ?? null;
  useEffect(() => {
    if (environmentId === null) return;
    panels.set(panelId, {
      rpc,
      environmentId,
      setError,
      push(from, to) {
        const at = from.getPosition();
        setStack((s) => {
          const top = s.at(-1);
          const updated = top !== undefined && at !== null ? [...s.slice(0, -1), { ...top, line: at.lineNumber, column: at.column }] : s;
          return [...updated, to];
        });
      },
    });
    return () => {
      panels.delete(panelId);
      for (const model of monaco?.editor.getModels() ?? []) {
        if (model.uri.scheme === FILE && model.uri.authority === panelId) model.dispose();
      }
    };
  }, [panelId, rpc, environmentId, monaco]);

  const back = useCallback(() => {
    setStack((s) => s.slice(0, -1));
    root.current?.focus();
  }, []);

  const onKeyDownCapture = (event: KeyboardEvent) => {
    if (event.ctrlKey && !event.metaKey && event.key === "-" && stack.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      back();
    }
  };

  const top = stack.at(-1);
  const relative = (p: string) => (data !== null && p.startsWith(`${data.root}/`) ? p.slice(data.root.length + 1) : p);

  return (
    <div ref={root} tabIndex={-1} onKeyDownCapture={onKeyDownCapture} className="flex h-full min-h-0 flex-col outline-none">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
        {top === undefined ? (
          <>
            <select
              aria-label="Changes to show"
              className="rounded border border-border bg-background px-1 py-0.5"
              value={target}
              onChange={(event) => setTarget(event.target.value as DiffTarget)}
            >
              <option value="all">All changes{data === null ? "" : ` vs ${data.baseBranch}`}</option>
              <option value="uncommitted">Uncommitted</option>
            </select>
            <span className="text-muted-foreground">
              {data === null ? "Loading…" : `${data.files.length} files · ⌘-click a symbol to go to its definition`}
            </span>
          </>
        ) : (
          <>
            <button type="button" className="rounded px-1.5 py-0.5 hover:bg-muted" onClick={back} title="Back (Ctrl+-)">
              ← Back
            </button>
            <span className="truncate font-mono">
              {relative(top.path)}:{top.line}
            </span>
            <span className="text-muted-foreground">depth {stack.length}</span>
          </>
        )}
        <span className="flex-1" />
        {error === null ? null : <span className="truncate text-destructive">{error}</span>}
        <button type="button" className="rounded px-1.5 py-0.5 hover:bg-muted" onClick={() => setReload((n) => n + 1)}>
          Refresh
        </button>
      </div>
      {bundle === null || monaco === null || data === null ? null : (
        <>
          <div className="flex min-h-0 flex-1 flex-col" hidden={top !== undefined}>
            {data.files.length === 0 ? <p className="p-4 text-sm text-muted-foreground">No changes.</p> : null}
            {data.skipped.length === 0 ? null : (
              <p className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
                Skipped (binary or too large): {data.skipped.join(", ")}
              </p>
            )}
            <div className="min-h-0 flex-1">
              <MultiDiff bundle={bundle} panelId={panelId} root={data.root} files={data.files} />
            </div>
          </div>
          {top === undefined ? null : (
            <FileView
              key={stack.length}
              monaco={monaco}
              panelId={panelId}
              location={top}
              onError={setError}
            />
          )}
        </>
      )}
    </div>
  );
}

const OPEN_DIFFS = { actionId: "diffs" };

function OpenDiffsButton(_: PluginThreadHeaderActionProps) {
  const navigate = useBbNavigate();
  return (
    <button
      type="button"
      aria-label="Open Diff Explorer (⌘⇧D)"
      title="Open Diff Explorer (⌘⇧D)"
      className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      onClick={() => navigate.openThreadPanel(OPEN_DIFFS)}
    >
      <Icon name="FileDiff" className="size-4" aria-hidden />
    </button>
  );
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: "diffs",
    title: "Diff Explorer",
    icon: "FileDiff",
    layout: "flush",
    component: DiffsPanel,
  });
  app.slots.experimental_threadHeaderAction({ id: "open-diffs", title: "Diff Explorer", component: OpenDiffsButton });
  app.commands.register({
    id: "open-diffs",
    title: "Open Diff Explorer",
    defaultShortcut: { key: "d", mod: true, shift: true },
    isAvailable: ({ threadId }) => threadId !== null,
    run: ({ openPanel }) => {
      openPanel(OPEN_DIFFS);
    },
  });
});
