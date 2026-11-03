#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { installLayout } from "./install-layout.mjs";

// Herdr's main.json declares no version. This is the one John's my-main.json records.
const FALLBACK_VERSION = "0.1.12";

export function buildLayout(main) {
  const layout = structuredClone(main);
  const work = layout.children?.find((c) => c.id === "work");
  const i = work?.children?.findIndex((c) => c.id === "tabs") ?? -1;
  if (i < 0) throw new Error("main layout has no tabs block in the work column");
  const { size, ...tabs } = work.children[i];
  work.children[i] = {
    id: "tab-bar",
    type: "row",
    size,
    resizable: false,
    children: [{ ...tabs, window_drag: true }],
  };
  const { id, ...rest } = layout;
  const cloned_from = { name: "main", version: main.version ?? FALLBACK_VERSION };
  const installed = installLayout({ id, cloned_from, ...rest });
  if (!installed.ok) throw new Error(installed.error);
  return installed.layout;
}

const isEntry = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isEntry) {
  const [src, out] = process.argv.slice(2);
  if (!src || !out || process.argv.length !== 4) {
    console.error("usage: node scripts/build-layout.mjs <Herdr main.json> <out>");
    process.exitCode = 2;
  } else {
    try {
      const layout = buildLayout(JSON.parse(await readFile(src, "utf8")));
      await writeFile(out, JSON.stringify(layout, null, 2) + "\n");
    } catch (e) {
      console.error(`build-layout: ${e.message}`);
      process.exitCode = 1;
    }
  }
}
