import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installLayout } from "../scripts/install-layout.mjs";
import * as model from "../model.js";
import { verdict } from "./helpers.js";

const {
  beginCheck, bodyKind, slotShowsIssues, contextKey, endCheck, focusContext, mentionRows, parseChecks, parseCommand, parseContext, parsePrefs,
  parseSpaces, readPanel, rememberProject, routeStep, selectRow, serializeChecks, visibleRows, withPanels, effectiveState,
} = model;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const json = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));
const find = (node, id) => node.id === id ? node : node.children?.map((c) => find(c, id)).find(Boolean);

const V = verdict();
const NOT = { kind: "not-onedev", reason: "no-origin" };
const row = (number, over = {}) => ({
  id: number, number, title: `T${number}`, state: "Open", updated: "2026-11-03T10:00:00.000Z", confidential: false,
  fields: null, submitter: null, submitDate: null, commentCount: 0, stateOrdinal: 0, ...over,
});
const cacheOf = (rows, over = {}) => ({
  version: 1, host: V.host, project: V.project, issues: Object.fromEntries(rows.map((r) => [String(r.number), r])),
  known: {}, mine: [], synced: 1, full: 1, ...over,
});

test("readPanel: null, a string and an array are hidden", () => {
  for (const x of [null, undefined, "x", 4, []]) {
    assert.deepEqual(readPanel(x), { mode: "hidden", columnShown: false, active: null, childIds: [], shared: false });
  }
});

test("readPanel: a layout with no panel-body is hidden, unless the panel block sits elsewhere", () => {
  const bare = { id: "root", type: "row", children: [{ id: "x", type: "block", content: { mod: "files" } }] };
  assert.equal(readPanel(bare).mode, "hidden");
  const button = { id: "root", children: [{ id: "b", content: { mod: "onedev-issues", props: { button: true } } }] };
  assert.equal(readPanel(button).mode, "hidden");
  const block = { id: "root", children: [{ id: "p", content: { mod: "onedev-issues" } }] };
  assert.deepEqual(readPanel(block), { mode: "onedev-issues", columnShown: true, active: null, childIds: [], shared: false });
});

test("readPanel: the committed layout starts hidden with the panel child present", () => {
  const slot = readPanel(json("layouts/main-onedev-issues.json"));
  assert.deepEqual(slot, { mode: "hidden", columnShown: false, active: "files", childIds: ["files", "changes", "onedev-issues"], shared: false });
});

test("readPanel: my-main.json after the default install has both issues children and separate buttons", () => {
  const r = installLayout(json("test/fixtures/my-main.json"));
  assert.equal(r.ok, true);
  const slot = readPanel(r.layout);
  assert.deepEqual(slot.childIds, ["files", "changes", "issues", "onedev-issues"]);
  assert.equal(slot.mode, "hidden");
  assert.equal(slot.shared, false);
});

test("readPanel: shared only when the upstream panel is there and its button is gone", () => {
  const src = json("test/fixtures/my-main.json");
  const replaced = installLayout(src, { mode: "replace" });
  assert.equal(readPanel(replaced.layout).shared, true);
  assert.equal(readPanel(installLayout(replaced.layout, { mode: "remove" }).layout).shared, false);
  assert.equal(readPanel(installLayout(src, { mode: "replace" }).layout).childIds.includes("issues"), true);
  const noPanel = structuredClone(replaced.layout);
  const body = find(noPanel, "panel-body");
  body.children = body.children.filter((c) => c.id !== "issues");
  assert.equal(readPanel(noPanel).shared, false);
  const own = installLayout(src);
  assert.equal(readPanel(own.layout).shared, false);
  find(own.layout, "tab-bar").children = [];
  assert.equal(readPanel(own.layout).shared, true);
});

test("readPanel: shown column and active child give onedev-issues, issues or hidden", () => {
  const layout = json("layouts/main-onedev-issues.json");
  const body = find(layout, "panel-body");
  find(layout, "panel").hidden = false;
  for (const [active, mode] of [["onedev-issues", "onedev-issues"], ["issues", "issues"], ["files", "hidden"], ["changes", "hidden"]]) {
    body.active = active;
    assert.equal(readPanel(layout).mode, mode, active);
  }
  body.active = "onedev-issues";
  find(layout, "panel").hidden = true;
  assert.equal(readPanel(layout).mode, "hidden");
});

test("readPanel: wrong-typed children and active do not throw", () => {
  const l = { id: "panel-body", active: 7, children: [null, 3, { id: 5 }, { id: "files" }] };
  assert.deepEqual(readPanel(l), { mode: "hidden", columnShown: true, active: "files", childIds: ["files"], shared: false });
  assert.equal(readPanel({ id: "panel-body", children: "x" }).mode, "hidden");
});

const ctx = (cwd, space = "s1", on = null) => ({ space, cwd, on, key: contextKey(cwd, on) });
const slot = (mode, active, over = {}) => ({ mode, columnShown: mode !== "hidden", active, childIds: ["files", "changes", "issues", "onedev-issues"], shared: true, ...over });
const HIDDEN = slot("hidden", "files", { columnShown: false });
const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
const MIN = 60_000;
const base = (over) => ({
  ctx: ctx("/a"), slot: HIDDEN, checks: {}, lastProject: {}, opening: false, configError: null, now: NOW, ...over,
});
const A = ctx("/a"), B = ctx("/b");
const known = (v, at = NOW) => ({ kind: "known", verdict: v, at });
const SHOWN = slot("onedev-issues", "onedev-issues");
const SEP_HIDDEN = slot("hidden", "files", { columnShown: false, shared: false });
const SEP_GITHUB = slot("issues", "issues", { shared: false });

const ROUTES = [
  ["hidden, no verdict: no lookup, no action, not checking", base({}), { lookups: [], select: null, show: false, opened: false, checking: true }],
  ["onedev-issues shown, no verdict: look up, keep the child", base({ slot: SHOWN }), { lookups: [A], select: null, show: false, opened: false, checking: true }],
  ["onedev-issues shown, lookup running: no second lookup", base({ slot: SHOWN, checks: { [A.key]: { kind: "asking", prior: null } } }), { lookups: [], select: null, show: false, opened: false, checking: true }],
  ["onedev-issues shown, fresh onedev verdict: nothing", base({ slot: SHOWN, checks: { [A.key]: known(V) } }), { lookups: [], select: null, show: false, opened: false, checking: false }],
  ["onedev-issues shown, verdict 10 min old: not yet stale", base({ slot: SHOWN, checks: { [A.key]: known(V, NOW - 10 * MIN) } }), { lookups: [], select: null, show: false, opened: false, checking: false }],
  ["onedev-issues shown, verdict over 10 min old: ask again, still routing on it", base({ slot: SHOWN, checks: { [A.key]: known(V, NOW - 10 * MIN - 1) } }), { lookups: [A], select: null, show: false, opened: false, checking: false }],
  ["hidden, stale verdict: no lookup while nothing shows", base({ checks: { [A.key]: known(V, 0) } }), { lookups: [], select: null, show: false, opened: false, checking: false }],
  ["onedev-issues shown, re-asking with a prior verdict: route on the prior, no second lookup", base({ slot: SHOWN, checks: { [A.key]: { kind: "asking", prior: NOT } } }), { lookups: [], select: "issues", show: false, opened: false, checking: false }],
  ["onedev-issues shown, github verdict, issues child exists: switch to issues", base({ slot: SHOWN, checks: { [A.key]: known(NOT) } }), { lookups: [], select: "issues", show: false, opened: false, checking: false }],
  ["issues shown, onedev verdict: switch to onedev-issues", base({ slot: slot("issues", "issues"), checks: { [A.key]: known(V) } }), { lookups: [], select: "onedev-issues", show: false, opened: false, checking: false }],
  ["issues shown, no verdict: keep, look up", base({ slot: slot("issues", "issues") }), { lookups: [A], select: null, show: false, opened: false, checking: true }],
  ["Files shown (mode hidden, column shown): never steal the panel", base({ slot: { ...HIDDEN, columnShown: true }, checks: { [A.key]: known(V) } }), { lookups: [], select: null, show: false, opened: false, checking: false }],
  ["click, verdict cached: select, show and open at once", base({ opening: true, checks: { [A.key]: known(V) } }), { lookups: [], select: "onedev-issues", show: true, opened: true, checking: false }],
  ["click, stale verdict: open on it at once and ask again", base({ opening: true, checks: { [A.key]: known(V, 0) } }), { lookups: [A], select: "onedev-issues", show: true, opened: true, checking: false }],
  ["click, no verdict: look up and wait", base({ opening: true }), { lookups: [A], select: null, show: false, opened: false, checking: true }],
    ["click, no focus at all: open the empty state", base({ opening: true, ctx: null }), { lookups: [], select: "onedev-issues", show: true, opened: true, checking: false }],
  ["click, github verdict: open the issues child", base({ opening: true, checks: { [A.key]: known(NOT) } }), { lookups: [], select: "issues", show: true, opened: true, checking: false }],
  ["click, column already shown on Files: select without show", base({ opening: true, slot: { ...HIDDEN, columnShown: true }, checks: { [A.key]: known(V) } }), { lookups: [], select: "onedev-issues", show: false, opened: true, checking: false }],
  ["click, column hidden but onedev-issues already active: show only", base({ opening: true, slot: { ...HIDDEN, active: "onedev-issues" }, checks: { [A.key]: known(V) } }), { lookups: [], select: null, show: true, opened: true, checking: false }],
  ["bad config: no lookups, the config message is published", base({ slot: SHOWN, configError: "bad path" }), { lookups: [], select: null, show: false, opened: false, checking: false, error: "bad path" }],
  ["shared, lookup failed, onedev-issues shown: switch to the GitHub panel, keep the error", base({ slot: SHOWN, checks: { [A.key]: { kind: "failed", message: "odev: not found" } } }), { lookups: [], select: "issues", show: false, opened: false, checking: false, error: "odev: not found" }],
  ["shared, click, lookup failed: open the GitHub panel", base({ opening: true, checks: { [A.key]: { kind: "failed", message: "boom" } } }), { lookups: [], select: "issues", show: true, opened: true, checking: false, error: "boom" }],
  ["no issues child, click, lookup failed: open the OneDev panel with the error", base({ opening: true, slot: slot("hidden", "files", { columnShown: false, childIds: ["files", "onedev-issues"], shared: false }), checks: { [A.key]: { kind: "failed", message: "boom" } } }), { lookups: [], select: "onedev-issues", show: true, opened: true, checking: false, error: "boom" }],
  ["no issues child, OneDev panel shown, lookup failed: stay, show the error", base({ slot: slot("onedev-issues", "onedev-issues", { childIds: ["files", "onedev-issues"], shared: false }), checks: { [A.key]: { kind: "failed", message: "boom" } } }), { lookups: [], select: null, show: false, opened: false, checking: false, error: "boom" }],
  ["separate, click, OneDev folder: open the OneDev panel", base({ opening: true, slot: SEP_HIDDEN, checks: { [A.key]: known(V) } }), { lookups: [], select: "onedev-issues", show: true, opened: true, checking: false }],
  ["separate, click, not-onedev folder: open the OneDev panel, not the GitHub one", base({ opening: true, slot: SEP_HIDDEN, checks: { [A.key]: known(NOT) } }), { lookups: [], select: "onedev-issues", show: true, opened: true, checking: false }],
  ["separate, click, lookup failed: open the OneDev panel and show the error", base({ opening: true, slot: SEP_HIDDEN, checks: { [A.key]: { kind: "failed", message: "boom" } } }), { lookups: [], select: "onedev-issues", show: true, opened: true, checking: false, error: "boom" }],
  ["separate, click, no verdict: look up and wait", base({ opening: true, slot: SEP_HIDDEN }), { lookups: [A], select: null, show: false, opened: false, checking: true }],
  ["separate, GitHub panel shown, OneDev folder: never pull the panel away", base({ slot: SEP_GITHUB, checks: { [A.key]: known(V) } }), { lookups: [], select: null, show: false, opened: false, checking: false }],
  ["separate, GitHub panel shown, not-onedev folder: stay", base({ slot: SEP_GITHUB, checks: { [A.key]: known(NOT) } }), { lookups: [], select: null, show: false, opened: false, checking: false }],
  ["separate, OneDev panel shown, not-onedev folder: stay on the OneDev panel", base({ slot: slot("onedev-issues", "onedev-issues", { shared: false }), checks: { [A.key]: known(NOT) } }), { lookups: [], select: null, show: false, opened: false, checking: false }],
  ["no issues child in the layout: never select it", base({ slot: slot("onedev-issues", "onedev-issues", { childIds: ["files", "onedev-issues"], shared: false }), checks: { [A.key]: known(NOT) } }), { lookups: [], select: null, show: false, opened: false, checking: false }],
];

for (const [name, input, want] of ROUTES) {
  test(`routeStep: ${name}`, () => {
    const step = routeStep(input);
    assert.deepEqual(step.lookups, want.lookups);
    assert.equal(step.select, want.select);
    assert.equal(step.show, want.show);
    assert.equal(step.opened, want.opened);
    assert.equal(step.publish.checking, want.checking);
    assert.equal(step.publish.error, want.error ?? null);
  });
}

test("routeStep: focus moving mid-lookup routes the folder now, with the landed verdict kept for its own folder", () => {
  const first = routeStep(base({ ctx: A, slot: SHOWN }));
  assert.deepEqual(first.lookups, [A]);
  const landed = endCheck(beginCheck({}, A.key), A.key, { ok: true, value: V }, NOW);
  const afterMove = routeStep(base({ ctx: B, slot: SHOWN, checks: landed }));
  assert.deepEqual(afterMove.lookups, [B]);
  assert.equal(afterMove.remember, null);
  assert.equal(afterMove.publish.checking, true);
  const back = routeStep(base({ ctx: A, slot: SHOWN, checks: landed }));
  assert.deepEqual(back.lookups, []);
  assert.equal(back.remember.project, "team/app");
});

test("routeStep: a click survives a focus move and waits on the folder focused now", () => {
  const waiting = routeStep(base({ ctx: B, opening: true, checks: { [A.key]: known(V) } }));
  assert.equal(waiting.opened, false);
  assert.deepEqual(waiting.lookups, [B]);
  const done = routeStep(base({ ctx: B, opening: true, checks: { [A.key]: known(V), [B.key]: known(NOT) } }));
  assert.equal(done.select, "issues");
  assert.equal(done.opened, true);
});

test("routeStep: the project shown is the verdict's, else the space's last one, else none", () => {
  const last = { s1: verdict({ project: "team/other" }) };
  assert.equal(routeStep(base({ lastProject: last })).publish.project.project, "team/other");
  assert.equal(routeStep(base({ lastProject: last, checks: { [A.key]: known(V) } })).publish.project.project, "team/app");
  assert.equal(routeStep(base({ lastProject: last, checks: { [A.key]: known(NOT) } })).publish.project.project, "team/other");
  assert.equal(routeStep(base({})).publish.project, null);
  assert.equal(routeStep(base({ ctx: null })).publish.space, null);
});

test("checks: a folder the 200 cap dropped is asked again", () => {
  const folders = Array.from({ length: 201 }, (_, i) => ctx(`/f${i}`));
  let checks = {};
  for (const f of folders) checks = endCheck(beginCheck(checks, f.key), f.key, { ok: true, value: NOT }, NOW);
  assert.equal(Object.keys(checks).length, 200);
  assert.deepEqual(routeStep(base({ ctx: folders[0], slot: SHOWN, checks })).lookups, [folders[0]]);
  assert.deepEqual(routeStep(base({ ctx: folders[1], slot: SHOWN, checks })).lookups, []);
});

test("checks: beginCheck keeps a known verdict as the prior; a failure or nothing starts with none", () => {
  const checks = { a: known(V), b: { kind: "failed", message: "x" } };
  assert.deepEqual(beginCheck(checks, "a").a, { kind: "asking", prior: V });
  assert.deepEqual(beginCheck(checks, "b").b, { kind: "asking", prior: null });
  assert.deepEqual(beginCheck(checks, "c").c, { kind: "asking", prior: null });
  assert.deepEqual(checks.a, known(V));
});

test("checks: endCheck stores a verdict with its time, or a clean one-line failure", () => {
  const ok = endCheck({ a: { kind: "asking", prior: null } }, "a", { ok: true, value: V }, NOW);
  assert.deepEqual(ok.a, known(V, NOW));
  const bad = endCheck({ a: { kind: "asking", prior: V } }, "a", { ok: false, error: { kind: "exit", message: "odev: \u001b[31mdown\u001b[0m\nmore" } }, NOW);
  assert.deepEqual(bad.a, { kind: "failed", message: "odev: down more" });
});

test("checks: a re-seen folder moves to the newest slot", () => {
  let c = {};
  for (let i = 0; i < 5; i++) c = endCheck(c, `k${i}`, { ok: true, value: NOT }, NOW, 3);
  assert.deepEqual(Object.keys(c), ["k2", "k3", "k4"]);
  c = endCheck(c, "k2", { ok: true, value: V }, NOW, 3);
  assert.deepEqual(Object.keys(c), ["k3", "k4", "k2"]);
});

test("focusContext: a terminal gives its folder, a mod pane keeps the last, and a remote terminal gives its machine", () => {
  const spaces = [{ id: "s1", folder: "/home", machine: null }];
  const f = { space: "s1", pane: "p1", terminal: "t1", cwd: "/x" };
  const got = focusContext(f, [{ pane: "p1", terminal: "t1", cwd: "/repo" }], spaces, null);
  assert.deepEqual(got, { space: "s1", cwd: "/repo", on: null, key: contextKey("/repo", null) });
  const mod = focusContext({ ...f, pane: "p2", terminal: null }, [{ pane: "p2", terminal: null, cwd: null }], spaces, got);
  assert.equal(mod, got);
  const block = focusContext({ space: "s1", pane: null, terminal: "box/t9", cwd: "/r" }, [], spaces, null);
  assert.equal(block.on, "box");
  assert.equal(focusContext(null, [], spaces, got), got);
  assert.equal(focusContext({ ...f, pane: null, terminal: null, cwd: null }, [], [], null), null);
});

test("parseCommand: refresh and focus, with and without the mod prefix", () => {
  assert.deepEqual(parseCommand("refresh"), { kind: "refresh" });
  assert.deepEqual(parseCommand("onedev-issues.refresh"), { kind: "refresh" });
  assert.deepEqual(parseCommand("focus"), { kind: "focus" });
});

test("parseCommand: open-<n> with and without the prefix", () => {
  assert.deepEqual(parseCommand("open-14"), { kind: "open", number: 14 });
  assert.deepEqual(parseCommand("onedev-issues.open-14"), { kind: "open", number: 14 });
  assert.deepEqual(parseCommand("open-999999999"), { kind: "open", number: 999999999 });
});

test("parseCommand: open-0, open-1e3, open-, a sign, a space and a 30-digit number are unknown", () => {
  for (const bad of ["open-0", "open-000", "open-1e3", "open-", "open--1", "open-+1", "open- 1", "open-1.5", "open-" + "9".repeat(30), "open-1234567890", "onedev-issues.onedev-issues.refresh", "", "nope"]) {
    assert.equal(parseCommand(bad).kind, "unknown", bad);
  }
  assert.deepEqual(parseCommand(undefined), { kind: "unknown", name: "" });
  assert.deepEqual(parseCommand(12), { kind: "unknown", name: "" });
});

test("withPanels: adds what is missing, keeps the same array when nothing is, and resets unknown shapes", () => {
  const a = ["files", "changes", "issues", "onedev-issues"];
  assert.equal(withPanels(a, ["onedev-issues", "issues"]), a);
  assert.deepEqual(withPanels(["files", "changes"], ["onedev-issues", "issues"]), ["files", "changes", "onedev-issues", "issues"]);
  assert.deepEqual(withPanels(["files", "changes", "issues"], ["onedev-issues", "issues"]), ["files", "changes", "issues", "onedev-issues"]);
  for (const bad of [undefined, null, "files", { a: 1 }, ["files", 3]]) {
    assert.deepEqual(withPanels(bad, ["onedev-issues"]), ["files", "changes", "onedev-issues"]);
  }
});

const R = [
  row(1, { title: "a", updated: "2026-11-01T00:00:00.000Z", commentCount: 5 }),
  row(2, { title: "b", updated: "2026-11-03T00:00:00.000Z", commentCount: 0 }),
  row(3, { title: "c", state: "Closed", stateOrdinal: 1 }),
  row(4, { title: "d", updated: "2026-11-02T00:00:00.000Z", commentCount: 9 }),
];
const prefs = (over = {}) => ({ state: null, mine: false, sort: "newest", selected: null, menu: false, ...over });
const nums = (rows) => rows.map((r) => r.number);

test("visibleRows: state filter, defaulting to the first tab, and an unknown state falls back to it", () => {
  const c = cacheOf(R);
  assert.deepEqual(nums(visibleRows(c, prefs())), [4, 2, 1]);
  assert.deepEqual(nums(visibleRows(c, prefs({ state: "Closed" }))), [3]);
  assert.deepEqual(nums(visibleRows(c, prefs({ state: "Nope" }))), [4, 2, 1]);
  assert.equal(effectiveState(cacheOf([]), prefs()), null);
  assert.deepEqual(visibleRows(cacheOf([]), prefs()), []);
});

test("visibleRows: Mine keeps only the assigned numbers", () => {
  const c = cacheOf(R, { mine: [1, 3] });
  assert.deepEqual(nums(visibleRows(c, prefs({ mine: true }))), [1]);
  assert.deepEqual(nums(visibleRows(c, prefs({ mine: true, state: "Closed" }))), [3]);
  assert.deepEqual(nums(visibleRows(cacheOf(R), prefs({ mine: true }))), []);
});

test("visibleRows: each sort, and an unknown sort id uses Newest", () => {
  const c = cacheOf(R);
  const by = (sort) => nums(visibleRows(c, prefs({ sort })));
  assert.deepEqual(by("newest"), [4, 2, 1]);
  assert.deepEqual(by("oldest"), [1, 2, 4]);
  assert.deepEqual(by("updated"), [2, 4, 1]);
  assert.deepEqual(by("stale"), [1, 4, 2]);
  assert.deepEqual(by("comments"), [4, 1, 2]);
  assert.deepEqual(by("bogus"), [4, 2, 1]);
});

test("selectRow: a cached row selects itself, switches to its state and clears Mine", () => {
  const c = cacheOf(R);
  assert.deepEqual(selectRow(prefs({ mine: true }), c, 3), prefs({ selected: 3, state: "Closed", mine: false }));
});

test("selectRow: a known-only number selects without moving the tabs, and an unknown number changes nothing", () => {
  const c = cacheOf(R, { known: { 50: { number: 50, title: "k", state: "Open" }, 51: null } });
  const p = prefs({ state: "Closed", mine: true });
  assert.deepEqual(selectRow(p, c, 50), { ...p, selected: 50 });
  assert.equal(selectRow(p, c, 51), p);
  assert.equal(selectRow(p, c, 999), p);
});

test("mentionRows: cached row, then known, in scan order; misses and nulls are dropped; at most 8", () => {
  const c = cacheOf(R, { known: { 50: { number: 50, title: "k", state: "Open" }, 51: null } });
  assert.deepEqual(mentionRows(c, [4, 51, 50, 777, 1]), [
    { number: 4, title: "d", state: "Open" },
    { number: 50, title: "k", state: "Open" },
    { number: 1, title: "a", state: "Open" },
  ]);
  const many = cacheOf(Array.from({ length: 12 }, (_, i) => row(i + 1)));
  assert.equal(mentionRows(many, Array.from({ length: 12 }, (_, i) => i + 1)).length, 8);
  assert.deepEqual(mentionRows(c, []), []);
});

test("bodyKind: no project, loading, no match and list", () => {
  const ok = { userSyncing: false, error: null, note: null };
  assert.equal(bodyKind(null, cacheOf(R), ok, R), "no-project");
  assert.equal(bodyKind(V, null, ok, []), "loading");
  assert.equal(bodyKind(V, cacheOf([], { synced: 0 }), { ...ok, userSyncing: true }, []), "loading");
  assert.equal(bodyKind(V, cacheOf([], { synced: 0 }), { ...ok, error: "x" }, []), "no-match");
  assert.equal(bodyKind(V, cacheOf([]), ok, []), "no-match");
  assert.equal(bodyKind(V, cacheOf(R), ok, R), "list");
});

test("verdict memo: bad JSON, wrong shapes and bad entries give an empty or filtered result", () => {
  for (const bad of [null, undefined, "", "{", "[]", "3", "null", '"x"', 7, "[1,2]"]) assert.deepEqual(parseChecks(bad), {}, String(bad));
  const text = JSON.stringify({
    ok: { verdict: V, at: 5 },
    no: { verdict: NOT, at: 6 },
    reason: { verdict: { kind: "not-onedev", reason: "new-reason" }, at: 1 },
    host: { verdict: { ...V, host: "" }, at: 1 },
    pid: { ...V, projectId: "72" },
    pid0: { ...V, projectId: 0 },
    kind: { kind: "git" },
    arr: [],
    nul: null,
  });
  assert.deepEqual(parseChecks(text), { ok: known(V, 5), no: known(NOT, 6) });
});

test("verdict memo: the old bare-verdict format loads as stale, and a bad time counts as stale", () => {
  const got = parseChecks(JSON.stringify({ old: V, neg: { verdict: NOT, at: -4 }, str: { verdict: NOT, at: "1" } }));
  assert.deepEqual(got, { old: known(V, 0), neg: known(NOT, 0), str: known(NOT, 0) });
  assert.deepEqual(routeStep(base({ slot: SHOWN, checks: { [A.key]: got.old } })).lookups, [A]);
});

test("verdict memo: only known verdicts are written, and they read back the same", () => {
  const checks = { a: known(V, 7), b: { kind: "asking", prior: V }, c: { kind: "failed", message: "x" }, d: known(NOT, 9) };
  const text = serializeChecks(checks);
  assert.deepEqual(JSON.parse(text), { a: { verdict: V, at: 7 }, d: { verdict: NOT, at: 9 } });
  assert.deepEqual(parseChecks(text), { a: known(V, 7), d: known(NOT, 9) });
});

test("verdict memo: __proto__ stays a plain key and does not change the prototype", () => {
  const got = parseChecks('{"__proto__": {"verdict": {"kind":"not-onedev","reason":"no-git"}, "at": 1}}');
  assert.equal(Object.getPrototypeOf(got), Object.prototype);
  assert.equal(Object.keys(got).length, 1);
});

test("verdict memo: a stored map over the cap keeps the newest 200", () => {
  const stored = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k${i}`, { verdict: NOT, at: i }]));
  const got = parseChecks(JSON.stringify(stored));
  assert.equal(Object.keys(got).length, 200);
  assert.equal(Object.keys(got)[0], "k100");
});

test("spaces memo: remembering moves the space to the end and keeps the newest 200", () => {
  let m = {};
  for (let i = 0; i < 5; i++) m = rememberProject(m, `s${i}`, V, 3);
  assert.deepEqual(Object.keys(m), ["s2", "s3", "s4"]);
  m = rememberProject(m, "s2", verdict({ project: "team/other" }), 3);
  assert.deepEqual(Object.keys(m), ["s3", "s4", "s2"]);
  assert.equal(m.s2.project, "team/other");
  for (let i = 0; i < 250; i++) m = rememberProject(m, `t${i}`, V);
  assert.equal(Object.keys(m).length, 200);
  const stored = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`s${i}`, V]));
  const parsed = parseSpaces(JSON.stringify(stored));
  assert.equal(Object.keys(parsed).length, 200);
  assert.equal(Object.keys(parsed)[0], "s100");
});

test("spaces memo and context and prefs parse at the boundary", () => {
  assert.deepEqual(parseSpaces(JSON.stringify({ s1: V, s2: NOT, s3: 5 })), { s1: V });
  assert.deepEqual(parseSpaces("{"), {});
  assert.deepEqual(parseContext(undefined), { space: null, project: null, error: null, checking: false });
  assert.deepEqual(parseContext({ space: 3, project: NOT, error: 4, checking: "yes" }), { space: null, project: null, error: null, checking: false });
  assert.deepEqual(parseContext({ space: "s", project: V, error: "e", checking: true }), { space: "s", project: V, error: "e", checking: true });
  assert.deepEqual(parsePrefs("{"), prefs());
  assert.deepEqual(parsePrefs(JSON.stringify({ state: "Closed", mine: true, sort: "oldest", selected: 9, menu: true })), prefs({ state: "Closed", mine: true, sort: "oldest" }));
  assert.equal(parsePrefs(JSON.stringify({ sort: "bogus", state: 4, mine: "yes" })).sort, "newest");
});

test("slotShowsIssues: shared, either issues panel counts; separate, only the OneDev panel", () => {
  const mk = (mode, shared) => ({ mode, columnShown: mode !== "hidden", active: mode, childIds: [], shared });
  assert.deepEqual(["hidden", "onedev-issues", "issues"].map((m) => slotShowsIssues(mk(m, true))), [false, true, true]);
  assert.deepEqual(["hidden", "onedev-issues", "issues"].map((m) => slotShowsIssues(mk(m, false))), [false, true, false]);
});
