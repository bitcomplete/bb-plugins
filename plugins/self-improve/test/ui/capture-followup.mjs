/** Synthetic visual checks only; run inside the existing offline visual container. */
import { createServer } from "vite";
import { chromium } from "/opt/visual/node_modules/playwright-core/index.mjs";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const sourcePaths = ["test/ui/visual.tsx", "test/ui/visual.html", "test/ui/capture-followup.mjs", "src/ui/dashboard.tsx", "src/ui/publication-status.tsx", "src/ui/performance.tsx", "src/ui/types.ts", "src/ui/styles.css"];
const sourceHashes = Object.fromEntries(sourcePaths.map(path => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]));
const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: "/scratch/cache/vite", server: { host: "127.0.0.1", port: 5173, strictPort: true }, logLevel: "error" });
const errors = [], captures = []; let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-zygote", "--single-process"] });
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  try {
    page.setDefaultTimeout(15000);
    page.on("pageerror", error => { errors.push(error.message.slice(0, 500)); });
    for (const variant of [{ name: "desktop", width: 1440, height: 1100 }, { name: "mobile", width: 390, height: 900 }]) {
      await page.setViewportSize({ width: variant.width, height: variant.height });
      await page.emulateMedia({ colorScheme: "light" });
      await page.goto("http://127.0.0.1:5173/test/ui/visual.html");
      const capture = async (state, target) => {
        await target.evaluate(element => element.scrollIntoView({ block: "start" }));
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const measurement = await page.evaluate(() => ({ viewportWidth: window.innerWidth, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth }));
        const name = `${state}-${variant.name}`;
        if (measurement.documentWidth > measurement.viewportWidth || measurement.bodyWidth > measurement.viewportWidth) errors.push(`${name}: horizontal document overflow`);
        const box = await target.boundingBox();
        if (!box || box.x < 0 || box.x + box.width > variant.width + 1) errors.push(`${name}: selected section extends outside the viewport`);
        captures.push({ name, measurement, png: (await page.screenshot({ fullPage: false })).toString("base64") });
      };
      await page.getByRole("tab", { name: /Established/ }).click();
      await page.getByRole("button", { name: /Open solution Retain/ }).click();
      const portability = page.getByRole("region", { name: "Portability", exact: true });
      await portability.getByText("Unverified declaration", { exact: true }).waitFor();
      await capture("portability-declared", portability);
      await page.getByRole("tab", { name: /Testing/ }).click();
      await page.getByRole("button", { name: "Open solution Check retry inputs before dispatch" }).click();
      await portability.getByText("Unknown · no declaration", { exact: true }).waitFor();
      await capture("portability-unknown", portability);
      await page.getByRole("tab", { name: "Performance", exact: true }).click();
      const publication = page.getByRole("region", { name: "Publication status", exact: true });
      await publication.getByText(/Exact bundle confirmed at merge commit/).waitFor();
      await capture("publication-current", publication);
      await publication.getByRole("button", { name: "Check publication", exact: true }).click();
      await publication.getByText(/Review not confirmed/).waitFor();
      await publication.getByRole("button", { name: "Show recorded history", exact: true }).click();
      const history = page.getByRole("region", { name: "Recorded publication history", exact: true });
      await history.locator("summary").filter({ hasText: /^Check 1/ }).click();
      await history.getByText(/Exact bundle confirmed at merge commit/).waitFor();
      await capture("publication-history", history);
    }
  } finally { await page.close(); }
} finally { if (browser) await browser.close(); await server.close(); }
process.stdout.write("FOLLOWUP_CAPTURE_JSON=" + JSON.stringify({ fixture: true, headless: true, browserClosed: true, sourceHashes, captures, errors }) + "\n");
if (errors.length) process.exitCode = 1;
