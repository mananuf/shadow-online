// Copy the generated chart PNGs (shadow/assets) into web/public/assets so the
// app can serve them at /assets/... — the same paths the Markdown references
// (after the ../assets/ -> /assets/ rewrite in Chapter.tsx).
import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "../../assets");
const dest = resolve(here, "../public/assets");

if (!existsSync(src)) {
  console.warn(`[copy-assets] no assets dir at ${src}; skipping`);
  process.exit(0);
}
await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });
await cp(src, dest, { recursive: true });
console.log(`[copy-assets] copied ${src} -> ${dest}`);
