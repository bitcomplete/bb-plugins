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
import type { DiffFile, DiffTarget, FileAction, Location, Report, rpcContract } from "./contract";
import { version as pluginVersion } from "./package.json";
import { flushFile, reconcileFile, reloadFile, releaseFile, type FileModels, type SaveFile } from "./file-models";

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
  path: string;
  original: Monaco.editor.ITextModel;
  modified: Monaco.editor.ITextModel;
  label: string;
  options: Monaco.editor.IDiffEditorOptions;
  estimatedHeight: number;
};
type Bundle = {
  monaco: MonacoApi;
  createMultiDiffEditor(element: HTMLElement, onFileAction: (path: string, action: FileAction) => void): { update(documents: MultiDiffDocument[]): void; dispose(): void };
};
let bundlePromise: Promise<Bundle> | null = null;
let bundleAttempt = 0;
let workerStatus: { path: string; error: string | null } | null = null;

function loadMonaco(baseUrl: string, rpc: Rpc): Promise<Bundle> {
  (globalThis as any).DiffExplorerMonacoEnvironment = {
    // Workers can restart after the cached bundle's preview URL has expired.
    getWorker: async () => {
      const { baseUrl } = await rpc.call("assets", null);
      const url = new URL(`${baseUrl}/editor.worker.js`, window.location.origin);
      const status = { path: url.pathname, error: null as string | null };
      workerStatus = status;
      const worker = new Worker(url, { type: "module" });
      worker.addEventListener("error", (event) => { status.error = event.message || "Editor worker failed to load"; });
      return worker;
    },
  };
  return (bundlePromise ??= (async () => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `${baseUrl}/editor.css`;
    document.head.appendChild(link);
    try {
      // Browsers cache failed module URLs, so a retry needs a different URL too.
      const attempt = bundleAttempt++;
      const bundle: Bundle = await import(/* @vite-ignore */ `${baseUrl}/editor.js${attempt === 0 ? "" : `?retry=${attempt}`}`);
      installNavigation(bundle.monaco);
      return bundle;
    } catch (cause) {
      link.remove();
      bundlePromise = null;
      throw cause;
    }
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

// The new side is the file on disk and is editable; the gutter arrows revert a block to the old side.
const DIFF_OPTIONS = {
  ...EDITOR_OPTIONS,
  readOnly: false,
  originalEditable: false,
  renderMarginRevertIcon: true,
  renderSideBySide: false,
  hideUnchangedRegions: { enabled: true },
} satisfies Monaco.editor.IDiffEditorOptions;
const DELETED_DIFF_OPTIONS = { ...DIFF_OPTIONS, readOnly: true } satisfies Monaco.editor.IDiffEditorOptions;
const SAVE_DELAY_MS = 600;

const LINE_HEIGHT = 19;
const HEADER_HEIGHT = 40;

function MultiDiff({
  bundle,
  panelId,
  root,
  files,
  save,
  read,
  fileAction,
  onError,
}: {
  bundle: Bundle;
  panelId: string;
  root: string;
  files: DiffFile[];
  save: SaveFile;
  read(path: string): Promise<string>;
  fileAction(path: string, action: FileAction): Promise<unknown>;
  onError(message: string | null): void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<ReturnType<Bundle["createMultiDiffEditor"]> | null>(null);
  // Models per path, updated in place on refresh so each file keeps its editor and your scroll place.
  const models = useRef(new Map<string, FileModels>());
  const [conflicts, setConflicts] = useState<string[]>([]);
  const [reloading, setReloading] = useState<string | null>(null);
  const onConflict = (path: string, conflicted: boolean) => {
    setConflicts((paths) => conflicted ? (paths.includes(path) ? paths : [...paths, path]) : paths.filter((p) => p !== path));
  };
  const saveRef = useRef({ save, fileAction, onError, onConflict });
  saveRef.current = { save, fileAction, onError, onConflict };

  useEffect(() => {
    const created = bundle.createMultiDiffEditor(container.current!, async (path, action) => {
      const m = models.current.get(path);
      if (m === undefined || m.deleting) return;
      if (action === "delete") {
        if (!window.confirm(`Delete ${path}? This removes the file from disk.`)) return;
        m.deleting = true;
        clearTimeout(m.timer);
        m.timer = undefined;
        await m.saving;
      }
      try {
        await saveRef.current.fileAction(path, action);
        if (action === "delete") {
          m.saved = m.modified.getValue();
          m.deleting = false;
        }
        saveRef.current.onError(null);
      } catch (cause) {
        m.deleting = false;
        saveRef.current.onError(cause instanceof Error ? cause.message : String(cause));
        if (action === "delete" && !m.modified.isDisposed()) {
          m.timer = setTimeout(() => flushFile(path, m, saveRef), SAVE_DELAY_MS);
        }
      }
    });
    editor.current = created;
    const owned = models.current;
    return () => {
      editor.current = null;
      created.dispose();
      for (const [path, m] of owned) releaseFile(path, m, saveRef);
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
        const modified = monaco.editor.createModel(file.newText, language, monaco.Uri.from({ scheme: NEW, authority: panelId, path: abs }));
        const created: FileModels = {
          original: monaco.editor.createModel(file.oldText, language, monaco.Uri.from({ scheme: OLD, authority: panelId, path: abs })),
          modified,
          saved: file.newText,
          saving: Promise.resolve(),
          timer: undefined,
          listener: modified.onDidChangeContent(() => {
            if (created.deleting || created.reloading) return;
            clearTimeout(created.timer);
            created.timer = setTimeout(() => flushFile(abs, created, saveRef), SAVE_DELAY_MS);
          }),
        };
        m = created;
        current.set(abs, m);
      } else {
        reconcileFile(m, file.oldText, file.newText);
      }
      return {
        path: file.path,
        original: m.original,
        modified: m.modified,
        label: `${file.path} · ${file.changeKind}`,
        options: file.changeKind === "deleted" ? DELETED_DIFF_OPTIONS : DIFF_OPTIONS,
        // Placeholder height until the widget renders the file; ~ changed lines plus collapsed-region rows.
        estimatedHeight: HEADER_HEIGHT + (file.additions + file.deletions + 8) * LINE_HEIGHT,
      };
    });
    editor.current!.update(documents);
    const kept = new Set(documents.map((d) => d.modified));
    for (const [abs, m] of current) {
      if (kept.has(m.modified)) continue;
      releaseFile(abs, m, saveRef);
      current.delete(abs);
    }
    setConflicts((paths) => paths.filter((path) => current.has(path)));
  }, [bundle, panelId, root, files]);

  const discard = async (path: string) => {
    const m = models.current.get(path);
    if (!m || m.reloading) return;
    setReloading(path);
    try {
      await reloadFile(m, () => read(path));
      setConflicts((paths) => paths.filter((p) => p !== path));
      saveRef.current.onError(null);
    } catch (cause) {
      saveRef.current.onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setReloading(null);
    }
  };

  return <div className="flex h-full min-h-0 flex-col">
    {conflicts.map((path) => <div key={path} role="alert" className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
      <span className="min-w-0 flex-1 truncate text-destructive" title={path}>{path.slice(root.length + 1)} changed on disk. Your edit is preserved.</span>
      <button type="button" className="shrink-0 rounded px-1.5 py-0.5 hover:bg-muted disabled:opacity-50" disabled={reloading !== null}
        onClick={() => discard(path)}>{reloading === path ? "Reloading…" : "Discard edit and reload"}</button>
    </div>)}
    <div ref={container} inert={reloading !== null} aria-busy={reloading !== null} className="min-h-0 flex-1" />
  </div>;
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

function ReportInbox({ rpc, onClose }: { rpc: Rpc; onClose(): void }) {
  const [reports, setReports] = useState<Omit<Report, "setup">[] | null>(null);
  const [id, setId] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    rpc.call("reports", null).then((reports) => { if (!cancelled) setReports(reports); },
      (cause) => { if (!cancelled) setError(String(cause)); });
    return () => { cancelled = true; };
  }, [rpc]);
  useEffect(() => {
    let cancelled = false;
    setReport(null);
    setError(null);
    if (id !== null) rpc.call("getReport", { id }).then((report) => { if (!cancelled) setReport(report); },
      (cause) => { if (!cancelled) setError(String(cause)); });
    return () => { cancelled = true; };
  }, [rpc, id]);
  return (
    <div role="region" aria-label="Diff Explorer reports" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }} className="absolute inset-0 z-20 flex min-h-0 flex-col bg-background text-xs">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        {id === null ? null : <button type="button" className="rounded px-1.5 py-0.5 hover:bg-muted" onClick={() => setId(null)}>← Back</button>}
        <span className="flex-1">Diff Explorer reports</span>
        <button type="button" autoFocus className="rounded px-1.5 py-0.5 hover:bg-muted" onClick={onClose}>Close</button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {error === null ? null : <p className="text-destructive">{error}</p>}
        {id !== null ? (report === null ? <p>Loading report…</p> : <pre className="whitespace-pre-wrap break-all">{JSON.stringify(report, null, 2)}</pre>) : (
          reports === null ? <p>Loading reports…</p> : reports.length === 0 ? <p>No reports saved.</p> : (
            <>
              <p className="mb-2 text-muted-foreground">Latest 20 reports from all threads. Stored in this BB installation.</p>
              {reports.map((report) => (
                <button key={report.id} type="button" className="block w-full rounded p-2 text-left hover:bg-muted" onClick={() => setId(report.id)}>
                  <span className="block">{new Date(report.createdAt).toLocaleString()} · {report.threadId}</span>
                  <span className="block break-all font-mono text-muted-foreground">{report.id}</span>
                </button>
              ))}
            </>
          )
        )}
      </div>
    </div>
  );
}

function DiffsPanel({ threadId }: PluginThreadPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const { mode, name } = experimental_useCodeTheme();
  const [panelId] = useState(() => `p${Math.random().toString(36).slice(2)}`);
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const monaco = bundle?.monaco ?? null;
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stack, setStack] = useState<Location[]>([]);
  const [reload, setReload] = useState(0);
  const [target, setTarget] = useState<DiffTarget>("uncommitted");
  const [reportStatus, setReportStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [showReports, setShowReports] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const settingsMenu = useRef<HTMLDivElement>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);

  const reportIssue = async () => {
    if (reportStatus === "saving") return;
    setReportStatus("saving");
    try {
      const setup = {
        pluginVersion, threadId, environmentId: data?.environmentId ?? null, workspace: data?.root ?? null,
        target, baseBranch: data?.baseBranch ?? null, theme: { mode, name }, error,
        files: data?.files.slice(0, 40).map((file) => ({ path: file.path, kind: file.changeKind })) ?? [],
        fileCount: data?.files.length ?? 0, skippedCount: data?.skipped.length ?? 0,
        browser: navigator.userAgent, forcedColors: matchMedia("(forced-colors: active)").matches,
        origin: window.location.origin, worker: workerStatus,
        viewport: { width: root.current?.clientWidth ?? 0, height: root.current?.clientHeight ?? 0 },
        decorations: Array.from(root.current?.querySelectorAll(".line-insert,.line-delete,.char-insert,.char-delete") ?? []).slice(0, 8).map((element) => {
          const style = getComputedStyle(element);
          return {
            class: element.className, background: style.backgroundColor,
            inserted: style.getPropertyValue("--vscode-diffEditor-insertedLineBackground"),
            removed: style.getPropertyValue("--vscode-diffEditor-removedLineBackground"),
          };
        }),
        stylesheets: Array.from(document.querySelectorAll<HTMLLinkElement>("link[rel=stylesheet]"))
          .filter((link) => link.href.includes("/editor.css")).map((link) => ({ path: new URL(link.href).pathname, loaded: link.sheet !== null })),
      };
      await rpc.call("report", setup);
      setReportStatus("saved");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setReportStatus("idle");
    }
  };

  useEffect(() => {
    setData(null);
    setStack([]);
  }, [threadId, target]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([rpc.call("assets", null).then(({ baseUrl }) => loadMonaco(baseUrl, rpc)), rpc.call("load", { threadId, target })]).then(
      ([b, loaded]) => {
        if (cancelled) return;
        setBundle(b);
        setData((prev) => (prev !== null && JSON.stringify(prev) === JSON.stringify(loaded) ? prev : loaded));
        setError(null);
      },
      (cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId, target, reload]);

  useRealtime("changed", (payload) => {
    if ((payload as { root: string }).root === data?.root) setReload((n) => n + 1);
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
    <div ref={root} tabIndex={-1} onKeyDownCapture={onKeyDownCapture} className="relative flex h-full min-h-0 flex-col outline-none">
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
              {data === null ? "Loading…" : `${data.files.length} files`}
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
        <button type="button" aria-label="Report issue" title="Save diagnostics to the Diff Explorer inbox" disabled={reportStatus === "saving"}
          className="shrink-0 rounded px-1.5 py-0.5 hover:bg-muted disabled:opacity-50" onClick={reportIssue}>
          {reportStatus === "saving" ? "Saving…" : reportStatus === "saved" ? "Report saved" : "Report issue"}
        </button>
        <button ref={settingsButton} type="button" aria-label="Diff Explorer settings" title="Settings"
          popoverTarget={`${panelId}-settings`} className="shrink-0 rounded p-1 hover:bg-muted"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            if (settingsMenu.current === null) return;
            settingsMenu.current.style.top = `${rect.bottom + 4}px`;
            settingsMenu.current.style.right = `${window.innerWidth - rect.right}px`;
          }}>
          <Icon name="Settings" className="size-4" aria-hidden />
        </button>
        <div ref={settingsMenu} id={`${panelId}-settings`} popover="auto" aria-label="Diff Explorer options"
          className="fixed left-auto m-0 min-w-32 rounded border border-border bg-background p-1 text-xs text-foreground shadow-md">
          <button type="button" className="w-full rounded px-2 py-1.5 text-left hover:bg-muted" onClick={() => {
            settingsMenu.current?.hidePopover();
            setShowReports(true);
          }}>View reports</button>
          <button type="button" className="w-full rounded px-2 py-1.5 text-left hover:bg-muted" onClick={() => {
            settingsMenu.current?.hidePopover();
            settingsButton.current?.focus();
            setReload((n) => n + 1);
          }}>Refresh</button>
        </div>
      </div>
      {showReports ? <ReportInbox rpc={rpc} onClose={() => { setShowReports(false); settingsButton.current?.focus(); }} /> : null}
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
              <MultiDiff
                bundle={bundle}
                panelId={panelId}
                root={data.root}
                files={data.files}
                save={(path, content, expected) => rpc.call("write", { environmentId: data.environmentId, path, content, expected })}
                read={async (path) => (await rpc.call("read", { environmentId: data.environmentId, path })).content}
                fileAction={async (path, action) => {
                  await rpc.call("fileAction", { environmentId: data.environmentId, path, action });
                  setReload((n) => n + 1);
                }}
                onError={setError}
              />
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
