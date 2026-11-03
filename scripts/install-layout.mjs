#!/usr/bin/env node
import { access, chmod, constants, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MOD = "onedev-issues";
const BUTTON_ID = "onedev-issues-button";
const GITHUB_BUTTON_ID = "issues-button";
const GITHUB_PANEL_ID = "issues";
const buttonContent = () => ({ mod: MOD, props: { button: true } });

// The upstream GitHub mod's tab-bar block, as layouts/main-issues.json has it at
// https://github.com/jankeesvw/herdr-issues/commit/dd1d0f4aaed35ce2b75bf30dd925941d46ff3d0a
const upstreamButton = () => ({
  id: GITHUB_BUTTON_ID,
  type: "block",
  size: { px: 78 },
  window_drag: true,
  content: { mod: "issues", props: { button: true } },
});

/** @typedef {"separate" | "replace" | "remove"} Mode */

function findNode(node, id) {
  if (node === null || typeof node !== "object") return undefined;
  if (node.id === id) return node;
  for (const child of Array.isArray(node.children) ? node.children : []) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return undefined;
}

/** @param {unknown} input @param {{ mode?: Mode }} [options] */
export function installLayout(input, { mode = "separate" } = {}) {
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

  const bar = (tabBar.children ??= []);
  const panels = (panelBody.children ??= []);
  const indexIn = (list, id) => list.findIndex((c) => c?.id === id);
  const hasGithubPanel = indexIn(panels, GITHUB_PANEL_ID) >= 0;
  const changes = [];

  if (mode === "remove") {
    const own = indexIn(bar, BUTTON_ID);
    if (own >= 0) {
      // The OneDev button holds the GitHub slot when the upstream panel is there and its button is not.
      if (hasGithubPanel && indexIn(bar, GITHUB_BUTTON_ID) < 0) {
        bar[own] = upstreamButton();
        changes.push(`tab-bar: replaced ${BUTTON_ID} with ${GITHUB_BUTTON_ID}`);
      } else {
        bar.splice(own, 1);
        changes.push(`tab-bar: removed ${BUTTON_ID}`);
      }
    }
    const child = indexIn(panels, MOD);
    if (child >= 0) {
      panels.splice(child, 1);
      changes.push(`panel-body: removed ${MOD}`);
      if (panelBody.active === MOD) {
        if (panels[0]?.id !== undefined) panelBody.active = panels[0].id;
        else delete panelBody.active;
      }
    }
    return { ok: true, layout, changes };
  }

  if (mode === "replace") {
    if (!hasGithubPanel) {
      return { ok: false, error: `--replace-github-button needs the GitHub Issues mod's panel: no ${GITHUB_PANEL_ID} child in panel-body` };
    }
    const slot = indexIn(bar, GITHUB_BUTTON_ID);
    const own = indexIn(bar, BUTTON_ID);
    if (slot < 0 && own < 0) {
      return { ok: false, error: `--replace-github-button needs the GitHub Issues mod's button: no ${GITHUB_BUTTON_ID} in tab-bar` };
    }
    if (slot >= 0) {
      const taken = { ...bar[slot], id: BUTTON_ID, content: buttonContent() };
      if (own >= 0) {
        bar.splice(own, 1);
        changes.push(`tab-bar: removed the separate ${BUTTON_ID}`);
      }
      bar[bar.findIndex((c) => c?.id === GITHUB_BUTTON_ID)] = taken;
      changes.push(`tab-bar: replaced ${GITHUB_BUTTON_ID} with ${BUTTON_ID}`);
    }
  } else if (indexIn(bar, BUTTON_ID) < 0) {
    bar.push({ id: BUTTON_ID, type: "block", size: { px: 78 }, window_drag: true, content: buttonContent() });
    changes.push(`tab-bar: added ${BUTTON_ID}`);
  }

  if (indexIn(panels, MOD) < 0) {
    panels.push({ id: MOD, type: "block", content: { mod: MOD } });
    changes.push(`panel-body: added ${MOD}`);
  }
  return { ok: true, layout, changes };
}

async function installFile(path, options) {
  const target = await realpath(path);
  let layout;
  try {
    layout = JSON.parse(await readFile(target, "utf8"));
  } catch (e) {
    return { ok: false, error: `${target}: ${e.message}` };
  }
  const result = installLayout(layout, options);
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

const USAGE = "usage: node scripts/install-layout.mjs [--replace-github-button | --remove] <layout.json>";

/** @param {string[]} argv */
export function parseArgs(argv) {
  const flags = argv.filter((a) => a.startsWith("--"));
  const files = argv.filter((a) => !a.startsWith("--"));
  if (files.length !== 1) return null;
  if (flags.some((f) => f !== "--replace-github-button" && f !== "--remove")) return null;
  if (flags.length > 1) return null;
  const mode = flags[0] === "--remove" ? "remove" : flags[0] === "--replace-github-button" ? "replace" : "separate";
  return { mode, file: files[0] };
}

async function main(argv) {
  const args = parseArgs(argv);
  if (!args) {
    console.error(USAGE);
    return 2;
  }
  try {
    const result = await installFile(args.file, { mode: args.mode });
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
