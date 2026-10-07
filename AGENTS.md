# Browser testing

- Run Playwright headless so testing does not open a visible browser window or steal the user's screen focus.
- Do not launch, activate, or bring browser windows to the foreground during automated tests.
- If a browser tool cannot be configured to run headless, use a headless Playwright script instead. Use a visible browser only when the user explicitly requests it.
- Quit the Playwright browser after testing, including on failure. Use `try/finally` with `await browser.close()` in scripts; do not leave browser processes or test windows running.

# Diff Explorer dependencies

- Use pnpm 10.34.6 in `plugins/diff-explorer`. Install with `pnpm install --frozen-lockfile`.
- Pin dependency versions exactly and commit `pnpm-lock.yaml`. Review version-specific install-script approvals in `pnpm-workspace.yaml` when updating packages.
- Keep `package-lock.json` synchronized for BB's npm-based Git plugin installer. Check it with `node scripts/check-dependencies.mjs` from the Diff Explorer directory.
