#!/usr/bin/env node
import { access, chmod, constants, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MOD = "onedev-issues";
const BUTTON_ID = "onedev-issues-button";
const buttonContent = () => ({ mod: MOD, props: { button: true } });

function findNode(node, id) {
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return undefined;
}

export function installLayout(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "layout must be a JSON object" };
  }
  const layout = structuredClone(input);
  const tabBar = findNode(layout, "tab-bar");
  if (!tabBar) return { ok: false, error: "no node with id tab-bar" };
  if (tabBar.type !== "row") return { ok: false, error: "tab-bar must be a row" };
  const panelBody = findNode(layout, "panel-body");
  if (!panelBody) return { ok: false, error: "no node with id panel-body" };
  if (panelBody.type !== "stack") return { ok: false, error: "panel-body must be a stack" };
  if (tabBar.children !== undefined && !Array.isArray(tabBar.children)) {
    return { ok: false, error: "tab-bar children must be an array" };
  }
  if (panelBody.children !== undefined && !Array.isArray(panelBody.children)) {
    return { ok: false, error: "panel-body children must be an array" };
  }

  const changes = [];
  const bar = (tabBar.children ??= []);
  const old = bar.findIndex((c) => c?.id === "issues-button");
  if (!bar.some((c) => c?.id === BUTTON_ID)) {
    if (old >= 0) {
      bar[old] = { ...bar[old], id: BUTTON_ID, content: buttonContent() };
      changes.push(`tab-bar: replaced issues-button with ${BUTTON_ID}`);
    } else {
      bar.push({ id: BUTTON_ID, type: "block", size: { px: 78 }, window_drag: true, content: buttonContent() });
      changes.push(`tab-bar: added ${BUTTON_ID}`);
    }
  }

  const panels = (panelBody.children ??= []);
  if (!panels.some((c) => c?.id === MOD)) {
    panels.push({ id: MOD, type: "block", content: { mod: MOD } });
    changes.push(`panel-body: added ${MOD}`);
  }
  return { ok: true, layout, changes };
}

async function installFile(path) {
  const target = await realpath(path);
  let layout;
  try {
    layout = JSON.parse(await readFile(target, "utf8"));
  } catch (e) {
    return { ok: false, error: `${target}: ${e.message}` };
  }
  const result = installLayout(layout);
  if (!result.ok || result.changes.length === 0) return result;
  await access(target, constants.W_OK);
  const mode = (await stat(target)).mode & 0o7777;
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.tmp`);
  try {
    await writeFile(tmp, JSON.stringify(result.layout, null, 2) + "\n", { flag: "wx", mode });
    await chmod(tmp, mode);
    await rename(tmp, target);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  return result;
}

async function main(argv) {
  if (argv.length !== 1) {
    console.error("usage: node scripts/install-layout.mjs <layout.json>");
    return 2;
  }
  try {
    const result = await installFile(argv[0]);
    if (!result.ok) {
      console.error(`install-layout: ${result.error}`);
      return 1;
    }
    if (result.changes.length === 0) console.log("unchanged");
    for (const line of result.changes) console.log(line);
    return 0;
  } catch (e) {
    console.error(`install-layout: ${e.message}`);
    return 1;
  }
}

const isEntry = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isEntry) process.exitCode = await main(process.argv.slice(2));
