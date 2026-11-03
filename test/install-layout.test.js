import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, copyFileSync, lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLayout } from "../scripts/build-layout.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts/install-layout.mjs");
const MY_MAIN = join(root, "test/fixtures/my-main.json");
const HERDR_MAIN = join(root, "test/fixtures/herdr-main.json");
const isRoot = process.getuid?.() === 0;

let dir;
before(() => { dir = mkdtempSync(join(tmpdir(), "install-layout-")); });
after(() => {
  chmodSync(dir, 0o755);
  rmSync(dir, { recursive: true, force: true });
});

const run = (file) => spawnSync("node", [script, file], { encoding: "utf8" });
const write = (name, text) => {
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
};
const ids = (node) => node.children.map((c) => c.id);
const find = (node, id) => node.id === id ? node : node.children?.map((c) => find(c, id)).find(Boolean);

test("runs on a copy of my-main.json, then reports unchanged and leaves bytes and mtime", async () => {
  const p = join(dir, "my-main.json");
  copyFileSync(MY_MAIN, p);
  const first = run(p);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /onedev-issues-button/);
  const bytes = readFileSync(p);
  const mtime = statSync(p).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  const second = run(p);
  assert.equal(second.status, 0);
  assert.equal(second.stdout.trim(), "unchanged");
  assert.deepEqual(readFileSync(p), bytes);
  assert.equal(statSync(p).mtimeMs, mtime);
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
});

test("replaces issues-button at its index and keeps the upstream issues child", () => {
  const p = join(dir, "replace.json");
  const original = JSON.parse(readFileSync(MY_MAIN, "utf8"));
  writeFileSync(p, JSON.stringify(original));
  assert.equal(run(p).status, 0);
  const out = JSON.parse(readFileSync(p, "utf8"));
  const before = find(original, "tab-bar");
  const bar = find(out, "tab-bar");
  const i = ids(before).indexOf("issues-button");
  assert.equal(ids(bar)[i], "onedev-issues-button");
  assert.equal(bar.children.length, before.children.length);
  assert.deepEqual(bar.children[i].content, { mod: "onedev-issues", props: { button: true } });
  assert.equal(bar.children[i].window_drag, true);
  assert.deepEqual(bar.children[i].size, { px: 78 });
  const body = find(out, "panel-body");
  assert.deepEqual(ids(body), [...ids(find(original, "panel-body")), "onedev-issues"]);
  assert.equal(body.active, "files");
  assert.ok(ids(body).includes("issues"));
});

const barOf = (type, children = []) => ({
  id: "root", type: "column",
  children: [
    { id: "tab-bar", type, children },
    { id: "panel-body", type: "stack", children: [] },
  ],
});

const hostile = {
  "no tab-bar": JSON.stringify({ id: "root", type: "row", children: [{ id: "panel-body", type: "stack", children: [] }] }),
  "tab-bar is a column": JSON.stringify(barOf("column")),
  "no panel-body": JSON.stringify({ id: "root", type: "row", children: [{ id: "tab-bar", type: "row", children: [] }] }),
  "invalid JSON": "{ not json",
  "empty file": "",
  "JSON null": "null",
  "children of the wrong type": JSON.stringify({ ...barOf("row"), children: [{ id: "tab-bar", type: "row", children: "x" }, { id: "panel-body", type: "stack" }] }),
};
for (const [name, text] of Object.entries(hostile)) {
  test(`exits 1 and leaves the file untouched: ${name}`, () => {
    const p = write(`hostile-${name.replace(/\W+/g, "-")}.json`, text);
    const r = run(p);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^install-layout: /);
    assert.equal(readFileSync(p, "utf8"), text);
  });
}

test("exits 2 on bad usage", () => {
  assert.equal(spawnSync("node", [script], { encoding: "utf8" }).status, 2);
});

test("exits 1 for a missing file", () => {
  assert.equal(run(join(dir, "missing.json")).status, 1);
});

test("read-only file: exits 1 and writes nothing", { skip: isRoot }, () => {
  const text = JSON.stringify(barOf("row"));
  const p = write("readonly.json", text);
  chmodSync(p, 0o444);
  const r = run(p);
  assert.equal(r.status, 1);
  assert.equal(readFileSync(p, "utf8"), text);
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
});

test("read-only folder: exits 1 and leaves the file", { skip: isRoot }, () => {
  const sub = join(dir, "ro-folder");
  mkdirSync(sub);
  const text = JSON.stringify(barOf("row"));
  const p = join(sub, "layout.json");
  writeFileSync(p, text);
  chmodSync(sub, 0o555);
  try {
    const r = run(p);
    assert.equal(r.status, 1);
    assert.equal(readFileSync(p, "utf8"), text);
  } finally {
    chmodSync(sub, 0o755);
  }
});

test("a symlinked layout is written through and stays a symlink", () => {
  const sub = join(dir, "real");
  mkdirSync(sub);
  const target = join(sub, "layout.json");
  writeFileSync(target, JSON.stringify(barOf("row")));
  const link = join(dir, "link.json");
  symlinkSync(target, link);
  const r = run(link);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(realpathSync(link), target);
  assert.ok(ids(find(JSON.parse(readFileSync(target, "utf8")), "tab-bar")).includes("onedev-issues-button"));
});

test("the rewritten file keeps its mode", () => {
  for (const mode of [0o600, 0o664]) {
    const p = write(`mode-${mode.toString(8)}.json`, JSON.stringify(barOf("row")));
    chmodSync(p, mode);
    assert.equal(run(p).status, 0);
    assert.equal(statSync(p).mode & 0o7777, mode);
  }
});

test("an existing onedev-issues-button is left as it is", () => {
  const custom = { id: "onedev-issues-button", type: "block", size: { px: 99 }, content: { mod: "onedev-issues", props: { button: true } } };
  const p = write("existing.json", JSON.stringify(barOf("row", [custom])));
  assert.equal(run(p).status, 0);
  assert.deepEqual(find(JSON.parse(readFileSync(p, "utf8")), "tab-bar").children, [custom]);
});

test("layouts/main-onedev-issues.json equals the generator output on Herdr's main.json", () => {
  const built = buildLayout(JSON.parse(readFileSync(HERDR_MAIN, "utf8")));
  assert.equal(readFileSync(join(root, "layouts/main-onedev-issues.json"), "utf8"), JSON.stringify(built, null, 2) + "\n");
});
