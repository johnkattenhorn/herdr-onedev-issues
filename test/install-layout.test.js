import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, copyFileSync, lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLayout } from "../scripts/build-layout.mjs";
import { installLayout, parseArgs } from "../scripts/install-layout.mjs";
import { readPanel } from "../model.js";

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

const run = (file, ...flags) => spawnSync("node", [script, ...flags, file], { encoding: "utf8" });
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

test("default: adds a separate button after the upstream one and leaves the upstream blocks alone", () => {
  const p = join(dir, "separate.json");
  const original = JSON.parse(readFileSync(MY_MAIN, "utf8"));
  writeFileSync(p, JSON.stringify(original));
  const r = run(p);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /added onedev-issues-button/);
  const out = JSON.parse(readFileSync(p, "utf8"));
  const before = find(original, "tab-bar");
  const bar = find(out, "tab-bar");
  assert.deepEqual(ids(bar), [...ids(before), "onedev-issues-button"]);
  assert.deepEqual(bar.children.slice(0, -1), before.children);
  assert.deepEqual(bar.children.at(-1), { id: "onedev-issues-button", type: "block", size: { px: 78 }, window_drag: true, content: { mod: "onedev-issues", props: { button: true } } });
  const body = find(out, "panel-body");
  const beforeBody = find(original, "panel-body");
  assert.deepEqual(ids(body), [...ids(beforeBody), "onedev-issues"]);
  assert.deepEqual(body.children.slice(0, -1), beforeBody.children);
  assert.equal(body.active, "files");
});

test("--replace-github-button: takes the issues-button slot and keeps the upstream issues child", () => {
  const p = join(dir, "replace.json");
  const original = JSON.parse(readFileSync(MY_MAIN, "utf8"));
  writeFileSync(p, JSON.stringify(original));
  assert.equal(run(p, "--replace-github-button").status, 0);
  const out = JSON.parse(readFileSync(p, "utf8"));
  const before = find(original, "tab-bar");
  const bar = find(out, "tab-bar");
  const i = ids(before).indexOf("issues-button");
  assert.equal(ids(bar)[i], "onedev-issues-button");
  assert.equal(bar.children.length, before.children.length);
  assert.deepEqual(bar.children[i].content, { mod: "onedev-issues", props: { button: true, replaced: UPSTREAM_BUTTON } });
  assert.equal(bar.children[i].window_drag, true);
  assert.deepEqual(bar.children[i].size, { px: 78 });
  const body = find(out, "panel-body");
  assert.deepEqual(ids(body), [...ids(find(original, "panel-body")), "onedev-issues"]);
  assert.equal(body.active, "files");
  assert.ok(ids(body).includes("issues"));
});

const mine = () => JSON.parse(readFileSync(MY_MAIN, "utf8"));
const must = (layout, mode) => {
  const r = installLayout(layout, { mode });
  assert.equal(r.ok, true, r.error);
  return r;
};
const UPSTREAM_BUTTON = { id: "issues-button", type: "block", size: { px: 78 }, window_drag: true, content: { mod: "issues", props: { button: true } } };

test("the fixture's issues-button is the upstream block at dd1d0f4", () => {
  assert.deepEqual(find(mine(), "issues-button"), UPSTREAM_BUTTON);
});

test("convert: --replace-github-button on a layout with a separate button leaves one OneDev button, in the GitHub slot", () => {
  const separate = must(mine()).layout;
  const r = must(separate, "replace");
  const bar = find(r.layout, "tab-bar");
  const slot = ids(find(mine(), "tab-bar")).indexOf("issues-button");
  assert.deepEqual(ids(bar), ids(find(mine(), "tab-bar")).map((id) => (id === "issues-button" ? "onedev-issues-button" : id)));
  assert.equal(ids(bar)[slot], "onedev-issues-button");
  assert.deepEqual(r.layout, must(mine(), "replace").layout);
  assert.deepEqual(r.changes, ["tab-bar: removed the separate onedev-issues-button", "tab-bar: replaced issues-button with onedev-issues-button"]);
});

test("remove after the default install gives back the original layout", () => {
  assert.deepEqual(must(must(mine()).layout, "remove").layout, mine());
});

test("remove after --replace-github-button gives back the original layout, with the upstream block at its slot", () => {
  const out = must(must(mine(), "replace").layout, "remove");
  assert.deepEqual(out.layout, mine());
  assert.deepEqual(find(out.layout, "issues-button"), UPSTREAM_BUTTON);
  assert.deepEqual(out.changes, ["tab-bar: replaced onedev-issues-button with issues-button", "panel-body: removed onedev-issues"]);
});

test("remove after convert gives back the original layout", () => {
  assert.deepEqual(must(must(must(mine()).layout, "replace").layout, "remove").layout, mine());
});

test("remove on a layout without the GitHub mod removes both blocks and nothing else", () => {
  const plain = { id: "root", type: "column", children: [{ id: "tab-bar", type: "row", children: [{ id: "tabs", type: "block" }] }, { id: "panel-body", type: "stack", active: "files", children: [{ id: "files", type: "block" }] }] };
  assert.deepEqual(must(must(plain).layout, "remove").layout, plain);
});

test("remove moves active off the removed child", () => {
  const l = must(mine()).layout;
  find(l, "panel-body").active = "onedev-issues";
  assert.equal(find(must(l, "remove").layout, "panel-body").active, "files");
});

test("remove keeps a button that is not ours and a panel child of the upstream mod", () => {
  const l = mine();
  assert.deepEqual(must(l, "remove").layout, l);
  assert.deepEqual(must(l, "remove").changes, []);
});

test("--replace-github-button refuses a layout with no upstream issues child, and says so", () => {
  const plain = { id: "root", type: "column", children: [{ id: "tab-bar", type: "row", children: [{ id: "tabs", type: "block" }] }, { id: "panel-body", type: "stack", children: [{ id: "files", type: "block" }] }] };
  const r = installLayout(plain, { mode: "replace" });
  assert.equal(r.ok, false);
  assert.match(r.error, /no issues child in panel-body/);
  const sep = must(plain).layout;
  assert.equal(installLayout(sep, { mode: "replace" }).ok, false);
  const p = write("refuse.json", JSON.stringify(plain));
  const cli = run(p, "--replace-github-button");
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /^install-layout: --replace-github-button needs/);
  assert.equal(readFileSync(p, "utf8"), JSON.stringify(plain));
});

test("--replace-github-button refuses an upstream panel whose button is gone and ours is not there", () => {
  const l = mine();
  const bar = find(l, "tab-bar");
  bar.children = bar.children.filter((c) => c.id !== "issues-button");
  const r = installLayout(l, { mode: "replace" });
  assert.equal(r.ok, false);
  assert.match(r.error, /no issues-button in tab-bar/);
});

test("every mode is idempotent", () => {
  for (const mode of ["separate", "replace", "remove"]) {
    const first = must(mine(), mode);
    const second = must(first.layout, mode);
    assert.deepEqual(second.layout, first.layout, mode);
    assert.deepEqual(second.changes, [], mode);
  }
});

test("--remove and --replace-github-button on files: idempotent runs print unchanged and leave bytes and mtime", async () => {
  for (const flag of ["--replace-github-button", "--remove"]) {
    const p = join(dir, `idem${flag}.json`);
    copyFileSync(MY_MAIN, p);
    assert.equal(run(p, flag).status, 0);
    const bytes = readFileSync(p);
    const mtime = statSync(p).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    const again = run(p, flag);
    assert.equal(again.status, 0);
    assert.equal(again.stdout.trim(), "unchanged");
    assert.deepEqual(readFileSync(p), bytes);
    assert.equal(statSync(p).mtimeMs, mtime);
  }
});

test("a wrong-typed child entry does not crash any mode", () => {
  const l = { id: "root", type: "column", children: [{ id: "tab-bar", type: "row", children: [null, 3, "x"] }, { id: "panel-body", type: "stack", children: [null, 7, { id: "issues" }] }] };
  for (const mode of ["separate", "replace", "remove"]) assert.doesNotThrow(() => installLayout(l, { mode }), mode);
});

test("parseArgs accepts one layout and at most one flag", () => {
  assert.deepEqual(parseArgs(["a.json"]), { mode: "separate", file: "a.json" });
  assert.deepEqual(parseArgs(["--remove", "a.json"]), { mode: "remove", file: "a.json" });
  assert.deepEqual(parseArgs(["a.json", "--replace-github-button"]), { mode: "replace", file: "a.json" });
  for (const bad of [[], ["--remove"], ["a", "b"], ["--remove", "--replace-github-button", "a"], ["--nope", "a"], ["--remove", "--remove", "a"]]) {
    assert.equal(parseArgs(bad), null, bad.join(" "));
  }
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

const count = (node, id) => (node?.id === id ? 1 : 0) + (Array.isArray(node?.children) ? node.children.reduce((n, c) => n + count(c, id), 0) : 0);
const handmade = (barChildren) => ({
  id: "root", type: "column",
  children: [
    { id: "tab-bar", type: "row", children: barChildren },
    { id: "panel-body", type: "stack", active: "files", children: [{ id: "files", type: "block" }, { id: "issues", type: "block", content: { mod: "issues" } }] },
  ],
});
const inSubRow = (block = UPSTREAM_BUTTON) => handmade([{ id: "tabs", type: "block" }, { id: "sub", type: "row", children: [{ id: "extra", type: "block" }, block] }]);
const panelNoButton = () => handmade([{ id: "tabs", type: "block" }]);
const CHANGED = { id: "issues-button", type: "block", size: { px: 96 }, window_drag: true, note: "mine", content: { mod: "issues", props: { button: true } } };
const ownButton = (content) => ({ id: "onedev-issues-button", type: "block", size: { px: 78 }, window_drag: true, content });
const unmarked = () => handmade([{ id: "tabs", type: "block" }, ownButton({ mod: "onedev-issues", props: { button: true } })]);

test("GitHub button in a sub-row: default then --remove leaves one issues-button and is not shared", () => {
  const installed = must(inSubRow()).layout;
  assert.deepEqual(ids(find(installed, "tab-bar")), ["tabs", "sub", "onedev-issues-button"]);
  assert.equal(readPanel(installed).shared, false);
  const removed = must(installed, "remove").layout;
  assert.equal(count(removed, "issues-button"), 1);
  assert.deepEqual(removed, inSubRow());
  assert.equal(readPanel(removed).shared, false);
});

test("GitHub panel with no GitHub button: default then --remove adds no issues-button and is not shared", () => {
  const installed = must(panelNoButton()).layout;
  assert.equal(readPanel(installed).shared, false);
  const removed = must(installed, "remove").layout;
  assert.equal(count(removed, "issues-button"), 0);
  assert.deepEqual(removed, panelNoButton());
  assert.equal(readPanel(removed).shared, false);
});

test("a changed GitHub block comes back exactly after replace then remove", () => {
  const original = handmade([{ id: "tabs", type: "block" }, CHANGED]);
  const replaced = must(original, "replace").layout;
  const button = find(replaced, "onedev-issues-button");
  assert.deepEqual(button.size, { px: 96 });
  assert.equal(button.note, "mine");
  assert.deepEqual(button.content, { mod: "onedev-issues", props: { button: true, replaced: CHANGED } });
  assert.notEqual(button.content.props.replaced.size, button.size);
  assert.equal(readPanel(replaced).shared, true);
  const removed = must(replaced, "remove");
  assert.deepEqual(removed.layout, original);
  assert.deepEqual(removed.changes, ["tab-bar: replaced onedev-issues-button with issues-button", "panel-body: removed onedev-issues"]);
});

test("replace acts in place in a sub-row, and remove puts the block back there", () => {
  const replaced = must(inSubRow(CHANGED), "replace").layout;
  assert.deepEqual(ids(find(replaced, "sub")), ["extra", "onedev-issues-button"]);
  assert.deepEqual(ids(find(replaced, "tab-bar")), ["tabs", "sub"]);
  assert.equal(readPanel(replaced).shared, true);
  assert.deepEqual(must(replaced, "remove").layout, inSubRow(CHANGED));
});

test("our button in a sub-row is removed there and nothing else goes", () => {
  const l = inSubRow();
  find(l, "sub").children.unshift(ownButton({ mod: "onedev-issues", props: { button: true } }));
  assert.deepEqual(must(l, "remove").layout, inSubRow());
});

test("convert with the separate button in a sub-row leaves one OneDev button, in the GitHub slot", () => {
  const l = handmade([{ id: "row-a", type: "row", children: [ownButton({ mod: "onedev-issues", props: { button: true } })] }, CHANGED]);
  const r = must(l, "replace").layout;
  assert.deepEqual(ids(find(r, "row-a")), []);
  assert.deepEqual(ids(find(r, "tab-bar")), ["row-a", "onedev-issues-button"]);
  assert.deepEqual(find(r, "onedev-issues-button").content.props.replaced, CHANGED);
});

test("--remove does not add a second issues-button when the user put one back by hand", () => {
  const l = must(mine(), "replace").layout;
  find(l, "tab-bar").children.push(CHANGED);
  const removed = must(l, "remove").layout;
  assert.equal(count(removed, "issues-button"), 1);
  assert.equal(count(removed, "onedev-issues-button"), 0);
  assert.deepEqual(find(removed, "issues-button"), CHANGED);
});

const roundTrips = {
  "default on my-main": [mine, ["separate"]],
  "replace on my-main": [mine, ["replace"]],
  "convert on my-main": [mine, ["separate", "replace"]],
  "default, sub-row": [inSubRow, ["separate"]],
  "replace, sub-row": [inSubRow, ["replace"]],
  "convert, sub-row": [inSubRow, ["separate", "replace"]],
  "default, panel and no button": [panelNoButton, ["separate"]],
};
for (const [name, [source, modes]] of Object.entries(roundTrips)) {
  test(`round trip, ${name}: each rerun changes nothing and --remove gives back the source`, () => {
    let layout = source();
    for (const mode of modes) {
      layout = must(layout, mode).layout;
      assert.deepEqual(must(layout, mode).changes, [], mode);
    }
    const removed = must(layout, "remove");
    assert.deepEqual(removed.layout, source());
    assert.deepEqual(must(removed.layout, "remove").changes, []);
  });
}

test("a layout with no marker converts: the marker holds the dd1d0f4 block, and the step says so", () => {
  const before = unmarked();
  assert.equal(readPanel(before).shared, false);
  const r = must(before, "replace");
  assert.deepEqual(find(r.layout, "onedev-issues-button"), ownButton({ mod: "onedev-issues", props: { button: true, replaced: UPSTREAM_BUTTON } }));
  assert.deepEqual(r.changes, ["tab-bar: marked onedev-issues-button as holding the issues-button slot, with the block from dd1d0f4", "panel-body: added onedev-issues"]);
  assert.equal(readPanel(r.layout).shared, true);
  assert.deepEqual(must(r.layout, "replace").changes, []);
  assert.deepEqual(find(must(r.layout, "remove").layout, "issues-button"), UPSTREAM_BUTTON);
});

test("the conversion on a file prints what it did, then unchanged", () => {
  const p = write("unmarked.json", JSON.stringify(unmarked()));
  const first = run(p, "--replace-github-button");
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /marked onedev-issues-button/);
  assert.equal(run(p, "--replace-github-button").stdout.trim(), "unchanged");
});

const badMarkers = { null: null, string: "issues-button", number: 7, array: [{ id: "issues-button" }], "empty object": {}, "wrong id": { id: "other-button" } };
const badButtons = {
  "content is a string": "x",
  "content is a number": 3,
  "content is null": null,
  "content is an array": [],
  "props is a string": { mod: "onedev-issues", props: "x" },
  "props is a number": { mod: "onedev-issues", props: 3 },
  "props is null": { mod: "onedev-issues", props: null },
  "props is an array": { mod: "onedev-issues", props: [{ replaced: UPSTREAM_BUTTON }] },
};
const malformed = {
  ...Object.fromEntries(Object.entries(badMarkers).map(([k, replaced]) => [`replaced is ${k}`, { mod: "onedev-issues", props: { button: true, replaced } }])),
  ...badButtons,
};
for (const [name, content] of Object.entries(malformed)) {
  const layout = () => handmade([{ id: "tabs", type: "block" }, ownButton(content)]);
  test(`malformed marker, --remove: ${name}: deletes our button and adds no issues-button`, () => {
    const removed = must(layout(), "remove").layout;
    assert.deepEqual(removed, panelNoButton());
  });
  test(`malformed marker, --replace-github-button: ${name}: counts as no marker`, () => {
    const replaced = must(layout(), "replace").layout;
    assert.deepEqual(find(replaced, "onedev-issues-button").content, { mod: "onedev-issues", props: { button: true, replaced: UPSTREAM_BUTTON } });
    assert.equal(readPanel(replaced).shared, true);
  });
  test(`malformed marker, readPanel: ${name}: not shared`, () => {
    assert.equal(readPanel(layout()).shared, false);
  });
}

test("wrong-typed entries in a sub-row do not hide the button or crash any mode", () => {
  const l = () => handmade([{ id: "sub", type: "row", children: [null, 3, "x", [], { id: "deep", children: "x" }, { id: "deeper", children: [null] }, CHANGED] }]);
  assert.equal(readPanel(l()).shared, false);
  assert.deepEqual(must(must(l()).layout, "remove").layout, l());
  const replaced = must(l(), "replace").layout;
  assert.equal(readPanel(replaced).shared, true);
  assert.deepEqual(must(replaced, "remove").layout, l());
});

test("a null tab-bar child and a marked button past it: readPanel still finds the marker", () => {
  const l = must(handmade([null, { id: "sub", type: "row", children: [null, CHANGED] }]), "replace").layout;
  assert.equal(readPanel(l).shared, true);
});
