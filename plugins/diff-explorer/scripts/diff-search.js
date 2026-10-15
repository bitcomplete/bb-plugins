// Search models rather than editor instances: off-screen diffs have no editor.
export function findDiffMatches(documents, query) {
  if (!query) return [];
  return documents.flatMap((document) => ["original", "modified"].flatMap((side) =>
    document[side].findMatches(query, false, false, false, null, false).map(({ range }) => ({ document, side, range })),
  ));
}

export function createDiffSearch(element, reveal, focusEditor) {
  const bar = document.createElement("div");
  bar.hidden = true;
  bar.setAttribute("role", "search");
  bar.setAttribute("aria-label", "Search all diffs");
  bar.style.cssText = "flex:none;padding:6px 8px;border-bottom:1px solid var(--vscode-widget-border,GrayText);font:12px sans-serif";
  bar.innerHTML = `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
    <input type="search" aria-label="Find in all diffs" placeholder="Find in all diffs" style="flex:1;min-width:100px;background:var(--vscode-input-background,Field);color:var(--vscode-input-foreground,FieldText);border:1px solid var(--vscode-input-border,GrayText);padding:3px 6px">
    <span role="status" aria-live="polite"></span>
    <button type="button" aria-label="Previous match" title="Previous match (Shift+Enter)">↑</button>
    <button type="button" aria-label="Next match" title="Next match (Enter)">↓</button>
    <button type="button" aria-label="Close find" title="Close (Escape)">×</button>
    <span data-location style="flex-basis:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
  </div>`;
  element.prepend(bar);
  const input = bar.querySelector("input");
  const status = bar.querySelector('[role="status"]');
  const location = bar.querySelector("[data-location]");
  const [previous, next, close] = bar.querySelectorAll("button");
  for (const button of [previous, next, close]) {
    button.style.cssText = "background:transparent;color:inherit;border:1px solid var(--vscode-widget-border,GrayText);border-radius:3px;cursor:pointer;padding:2px 6px";
  }
  let documents = [];
  let matches = [];
  let index = -1;
  let listeners = [];
  let decorations = [];

  function clearDecorations() {
    for (const [model, ids] of decorations) if (!model.isDisposed()) model.deltaDecorations(ids, []);
    decorations = [];
  }
  function showMatch(navigate) {
    const match = matches[index];
    status.textContent = input.value ? (match ? `${index + 1} of ${matches.length}` : "No results") : "";
    location.textContent = match ? `${match.document.path} · ${match.side === "original" ? "Before" : "After"} · line ${match.range.startLineNumber}` : "";
    previous.disabled = next.disabled = matches.length === 0;
    if (navigate && match) reveal(match);
  }
  function search(navigate = false) {
    clearDecorations();
    matches = bar.hidden ? [] : findDiffMatches(documents, input.value);
    index = matches.length ? Math.max(0, Math.min(index, matches.length - 1)) : -1;
    const byModel = new Map();
    for (const match of matches) {
      const model = match.document[match.side];
      if (!byModel.has(model)) byModel.set(model, []);
      byModel.get(model).push({ range: match.range, options: { description: "diff-explorer-find", className: "findMatch" } });
    }
    for (const [model, values] of byModel) decorations.push([model, model.deltaDecorations([], values)]);
    showMatch(navigate);
  }
  function move(delta) {
    if (!matches.length) return;
    index = (index + delta + matches.length) % matches.length;
    showMatch(true);
  }
  function hide() {
    bar.hidden = true;
    clearDecorations();
    reveal(null);
    focusEditor();
  }
  input.oninput = () => { index = 0; search(true); };
  bar.onkeydown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      move(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      hide();
    }
  };
  previous.onclick = () => move(-1);
  next.onclick = () => move(1);
  close.onclick = hide;
  return {
    open() {
      bar.hidden = false;
      search(true);
      input.focus();
      input.select();
    },
    update(nextDocuments) {
      for (const listener of listeners) listener.dispose();
      documents = nextDocuments;
      listeners = documents.flatMap((d) => [d.original, d.modified].map((model) => model.onDidChangeContent(() => search())));
      search();
    },
    dispose() {
      for (const listener of listeners) listener.dispose();
      clearDecorations();
      bar.remove();
    },
  };
}
