#!/bin/sh
# Monaco with the editor, diff editor, and syntax highlighting only. The language
# servers in host.ts replace Monaco's built-in TS/CSS/HTML/JSON workers.
set -eu
cd "$(dirname "$0")/.."
src="$PWD/node_modules/monaco-editor/esm/vs/editor"
entry="$PWD/node_modules/.monaco-entry.js"
grep -v -E 'languages/features/|__src_languages_features|monaco-lsp-client|index as lsp' "$src/editor.main.js" |
  sed -e "s#'\./#'$src/#" -e "s#'\.\./#'$src/../#" >"$entry"
echo "export * as monaco from '$src/editor.api.js';" >>"$entry"
echo "export { createMultiDiffEditor } from '$PWD/scripts/multi-diff.js';" >>"$entry"
rm -rf monaco
# BB's built-in File Editor loads its own Monaco and overwrites globalThis.MonacoEnvironment; read a private global instead.
npx esbuild "$entry" --bundle --format=esm --minify --loader:.ttf=file --define:globalThis.MonacoEnvironment=globalThis.DiffExplorerMonacoEnvironment --outfile=monaco/editor.js --log-level=warning
npx esbuild "$src/editor.worker.js" --bundle --format=esm --minify --outfile=monaco/editor.worker.js --log-level=warning
cp node_modules/monaco-editor/LICENSE node_modules/monaco-editor/ThirdPartyNotices.txt monaco/
