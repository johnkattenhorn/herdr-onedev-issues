import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { SORTS, cacheFileName, chooseView, createCaches, displayText, herdrIO, stateTabs } from "../mods/onedev-issues/cache.js";
import { parseIssueRow } from "../mods/onedev-issues/odev.js";
import { nodeExec, verdict, wireRow } from "./helpers.js";

const V = verdict();
const isRoot = process.getuid?.() === 0;
const T0 = Date.UTC(2026, 10, 3, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

let root;
let seq = 0;
before(() => { root = mkdtempSync(join(tmpdir(), "cache-test-")); });
after(() => {
  for (const d of readdirSync(root)) chmodSync(join(root, d), 0o755);
  rmSync(root, { recursive: true, force: true });
});

const row = (n, over = {}) => parseIssueRow(wireRow(n, over));
const rows = (...ns) => ns.map((n) => row(n));
const numbers = (cache) => Object.keys(cache.issues).map(Number).sort((a, b) => a - b);

function fakeOdev(data = {}) {
  const events = [];
  const odev = {
    data: { all: [], mine: [], lookup: () => new Map(), ...data },
    events,
    lists: [],
    lookups: [],
    delay: 0,
    async list(q) {
      odev.lists.push(q);
      events.push(`list${q.mine ? ":mine" : ""}:start`);
      if (odev.delay) await new Promise((r) => setTimeout(r, odev.delay));
      events.push(`list${q.mine ? ":mine" : ""}:end`);
      const v = odev.data[q.mine ? "mine" : "all"];
      if (typeof v === "function") return v(q);
      return v && !Array.isArray(v) && "ok" in v ? v : { ok: true, value: v };
    },
    async lookup(verdict, ns) {
      odev.lookups.push(ns);
      events.push("lookup:start");
      if (odev.delay) await new Promise((r) => setTimeout(r, odev.delay));
      events.push("lookup:end");
      const v = odev.data.lookup(ns);
      return v instanceof Map ? { ok: true, value: v } : v;
    },
  };
  return odev;
}

function setup({ odev = fakeOdev(), dir, io } = {}) {
  const data = dir ?? join(root, `case-${++seq}`, "data", "onedev-issues");
  const clock = { t: T0 };
  const caches = createCaches({ io: io ?? herdrIO({ exec: nodeExec, fs }), odev, dir: data, now: () => clock.t });
  return { odev, dir: data, clock, caches, get store() { return caches.get(V); }, file: join(data, cacheFileName(V)) };
}

const writeCache = (file, over = {}) => {
  mkdirSync(join(file, ".."), { recursive: true });
  const c = { version: 1, host: V.host, project: V.project, issues: {}, known: {}, mine: [], synced: T0 - HOUR, full: T0 - HOUR, ...over };
  writeFileSync(file, JSON.stringify(c));
};
const readCache = (file) => JSON.parse(readFileSync(file, "utf8"));

test("sync: the first sync fills the cache, writes the file and reports a change", async () => {
  const s = setup({ odev: fakeOdev({ all: rows(3, 2, 1), mine: rows(2) }) });
  assert.deepEqual(await s.store.sync(), { changed: true });
  const cache = s.store.cache();
  assert.deepEqual(numbers(cache), [1, 2, 3]);
  assert.deepEqual(cache.mine, [2]);
  assert.equal(cache.synced, T0);
  assert.equal(s.odev.lists.every((q) => q.since === undefined), true);
  assert.deepEqual(readCache(s.file).issues["2"], cache.issues["2"]);
  assert.equal(s.store.status().error, null);
});

test("rows by number: duplicate numbers in one result collapse to the first row", async () => {
  const s = setup({ odev: fakeOdev({ all: [row(1, { title: "first" }), row(1, { title: "second" })] }) });
  await s.store.sync();
  const cache = s.store.cache();
  assert.equal(Object.keys(cache.issues).length, 1);
  assert.equal(cache.issues["1"].title, "first");
});

test("sync: every sync replaces the rows: an issue that is gone disappears", async () => {
  const s = setup({ odev: fakeOdev({ all: rows(1, 2, 3) }) });
  await s.store.sync();
  s.clock.t += 30_000;
  s.odev.data.all = rows(2, 3);
  await s.store.sync();
  assert.deepEqual(numbers(s.store.cache()), [2, 3]);
});

test("sync: a number that was a remembered miss and is now a row leaves known", async () => {
  const s = setup({ odev: fakeOdev({ all: rows(1), lookup: () => new Map([[50, null]]) }) });
  await s.store.sync();
  await s.store.resolve([50]);
  assert.equal(s.store.cache().known["50"], null);
  s.odev.data.all = rows(1, 50);
  s.clock.t += 30_000;
  await s.store.sync();
  const cache = s.store.cache();
  assert.equal("50" in cache.known, false);
  assert.equal(cache.issues["50"].number, 50);
});

test("a failed odev run keeps the old cache and shows the error; the next success clears it", async () => {
  const s = setup({ odev: fakeOdev({ all: rows(1, 2) }) });
  await s.store.sync();
  const before = readFileSync(s.file, "utf8");
  s.odev.data.all = { ok: false, error: { kind: "shape", message: "odev printed text that is not JSON" } };
  s.clock.t += 30_000;
  assert.deepEqual(await s.store.sync(), { changed: true });
  assert.deepEqual(numbers(s.store.cache()), [1, 2]);
  assert.equal(s.store.cache().synced, T0);
  assert.equal(s.store.status().error, "odev printed text that is not JSON");
  assert.equal(readFileSync(s.file, "utf8"), before);
  assert.deepEqual(await s.store.sync(), { changed: false });
  s.odev.data.all = rows(1, 2);
  assert.deepEqual(await s.store.sync(), { changed: true });
  assert.equal(s.store.status().error, null);
});

test("mine: a full sync takes the numbers of the --assignee me list", async () => {
  const s = setup({ odev: fakeOdev({ all: rows(1, 2, 3, 4), mine: rows(4, 2) }) });
  await s.store.sync();
  assert.deepEqual(s.store.cache().mine, [4, 2]);
  assert.deepEqual(s.odev.lists.map((q) => !!q.mine).sort(), [false, true]);
});

test("mine: a full sync drops a number that is no longer assigned", async () => {
  const s = setup({ odev: fakeOdev({ all: rows(1, 2), mine: rows(1, 2) }) });
  await s.store.sync();
  s.clock.t += 30_000;
  s.odev.data.mine = rows(1);
  await s.store.sync();
  assert.deepEqual(s.store.cache().mine, [1]);
});

test("mine: a failed mine call fails the whole sync and keeps the old cache", async () => {
  const s = setup({ odev: fakeOdev({ all: rows(1), mine: rows(1) }) });
  await s.store.sync();
  s.clock.t += 30_000;
  s.odev.data.all = [row(1, { title: "new title" })];
  s.odev.data.mine = { ok: false, error: { kind: "exit", message: "odev: no user me" } };
  await s.store.sync();
  const cache = s.store.cache();
  assert.equal(cache.issues["1"].title, "Issue 1");
  assert.equal(cache.synced, T0);
  assert.equal(s.store.status().error, "odev: no user me");
});

test("version mismatch: a file of another version is ignored, noted, and refetched in full", async () => {
  const s = setup({ odev: fakeOdev({ all: rows(1) }) });
  writeCache(s.file, { version: 2, issues: { 9: wireRow(9) } });
  assert.deepEqual(await s.store.load(), s.store.cache());
  assert.deepEqual(numbers(s.store.cache()), []);
  assert.match(s.store.status().note, /another version/);
  await s.store.sync();
  assert.equal(readCache(s.file).version, 1);
});

test("wrong host or project file: a file that belongs to another key is not trusted", async () => {
  for (const over of [{ project: "team/other" }, { host: "http://10.0.0.1" }]) {
    const s = setup({ odev: fakeOdev({ all: rows(1) }) });
    writeCache(s.file, { ...over, issues: { 9: row(9) } });
    await s.store.load();
    assert.deepEqual(numbers(s.store.cache()), [], JSON.stringify(over));
    assert.match(s.store.status().note, /another project/);
    await s.store.sync();
    assert.equal(readCache(s.file).project, V.project);
  }
});

test("a valid file loads at once; an old file's full key is accepted and not written back", async () => {
  const s = setup({ odev: fakeOdev({ all: rows(4, 5), mine: rows(4) }) });
  writeCache(s.file, { issues: { 4: row(4) }, mine: [4], known: { 7: { number: 7, title: "t", state: "Open" }, 8: null } });
  const cache = await s.store.load();
  assert.deepEqual(numbers(cache), [4]);
  assert.deepEqual(cache.mine, [4]);
  assert.deepEqual(Object.keys(cache.known), ["7", "8"]);
  assert.equal(s.store.status().note, null);
  s.clock.t = T0;
  assert.deepEqual(await s.store.sync(), { changed: true });
  assert.equal("full" in readCache(s.file), false);
  assert.deepEqual(Object.keys(readCache(s.file).issues), ["4", "5"]);
});

test("load: a file with a bad row, a row under another key or a bad mine list is refetched whole", async () => {
  const bad = [
    { issues: { 1: row(1), 2: { number: 2, title: 5, state: "Open" } } },
    { issues: { 1: row(2) } },
    { issues: {}, mine: ["x"] },
    { issues: {}, mine: [1.5] },
    { issues: [] },
    { issues: {}, synced: "now" },
  ];
  for (const over of bad) {
    const s = setup();
    writeCache(s.file, over);
    await s.store.load();
    assert.deepEqual(numbers(s.store.cache()), [], JSON.stringify(over));
    assert.equal(s.store.cache().synced, 0);
    assert.ok(s.store.status().note, JSON.stringify(over));
  }
});

test("load: a bad known entry is dropped and the rest of the file is kept", async () => {
  const s = setup();
  writeCache(s.file, { issues: { 1: row(1) }, known: { 5: { number: 6, title: "t", state: "Open" }, x: null, 7: "s", 8: { number: 8, title: "ok", state: "Open" } } });
  const cache = await s.store.load();
  assert.deepEqual(numbers(cache), [1]);
  assert.deepEqual(Object.keys(cache.known), ["8"]);
});

test("load: a truncated file is refetched and then replaced by a good one", async () => {
  const s = setup({ odev: fakeOdev({ all: rows(1) }) });
  writeCache(s.file, { issues: { 1: row(1) } });
  const text = readFileSync(s.file, "utf8");
  writeFileSync(s.file, text.slice(0, text.length / 2));
  await s.store.load();
  assert.deepEqual(numbers(s.store.cache()), []);
  assert.match(s.store.status().note, /not JSON/);
  await s.store.sync();
  assert.deepEqual(Object.keys(readCache(s.file).issues), ["1"]);
});

test("load: a file that is not JSON, an empty file and a JSON array are refetched", async () => {
  for (const text of ["this is not json", "", "[]", "null", "42"]) {
    const s = setup();
    mkdirSync(s.dir, { recursive: true });
    writeFileSync(s.file, text);
    await s.store.load();
    assert.equal(s.store.cache().synced, 0, JSON.stringify(text));
    assert.ok(s.store.status().note, JSON.stringify(text));
  }
});

test("load: a 50 MB file is not read, is noted, and is replaced by the next sync", async () => {
  const s = setup({ odev: fakeOdev({ all: rows(1) }) });
  mkdirSync(s.dir, { recursive: true });
  const fh = await fs.open(s.file, "w");
  await fh.truncate(50 * 1024 * 1024);
  await fh.close();
  const t0 = performance.now();
  await s.store.load();
  assert.ok(performance.now() - t0 < 2000);
  assert.match(s.store.status().note, /too large/);
  assert.equal(s.store.cache().synced, 0);
  await s.store.sync();
  assert.ok(readFileSync(s.file).length < 100_000);
  assert.deepEqual(Object.keys(readCache(s.file).issues), ["1"]);
});

test("load: a symlink at the cache path is never followed or written through", async () => {
  const s = setup({ odev: fakeOdev({ all: rows(1) }) });
  mkdirSync(s.dir, { recursive: true });
  const target = join(root, `target-${seq}.json`);
  writeFileSync(target, "precious");
  symlinkSync(target, s.file);
  await s.store.load();
  assert.deepEqual(numbers(s.store.cache()), []);
  assert.match(s.store.status().error, /is a symlink/);
  await s.store.sync();
  const cache = s.store.cache();
  assert.deepEqual(numbers(cache), [1]);
  assert.equal(readFileSync(target, "utf8"), "precious");
  assert.match(s.store.status().error, /symlink/);
});

test("load: a blocked path clears once the obstacle is gone and a later sync saves", async () => {
  const s = setup({ odev: fakeOdev({ all: rows(1) }) });
  mkdirSync(s.dir, { recursive: true });
  symlinkSync(join(root, `gone-${seq}.json`), s.file);
  await s.store.sync();
  assert.match(s.store.status().error, /symlink/);
  rmSync(s.file);
  await s.store.sync({ user: true });
  assert.equal(s.store.status().error, null);
  assert.deepEqual(Object.keys(readCache(s.file).issues), ["1"]);
});

test("load: a symlink to a valid cache file is not trusted either", async () => {
  const s = setup();
  const target = join(root, `valid-${seq}.json`);
  writeCache(target, { issues: { 1: row(1) } });
  mkdirSync(s.dir, { recursive: true });
  symlinkSync(target, s.file);
  await s.store.load();
  assert.deepEqual(numbers(s.store.cache()), []);
});

test("load: a dangling symlink is blocked, not treated as absent", async () => {
  const s = setup({ odev: fakeOdev({ all: rows(1) }) });
  mkdirSync(s.dir, { recursive: true });
  symlinkSync(join(root, "does-not-exist"), s.file);
  await s.store.load();
  await s.store.sync();
  assert.match(s.store.status().error, /symlink/);
  assert.deepEqual(readdirSync(root).includes("does-not-exist"), false);
});

test("load: a directory at the cache path is blocked and the sync still fills memory", async () => {
  const s = setup({ odev: fakeOdev({ all: rows(1, 2) }) });
  mkdirSync(s.file, { recursive: true });
  await s.store.load();
  assert.match(s.store.status().error, /is a directory/);
  await s.store.sync();
  const cache = s.store.cache();
  assert.deepEqual(numbers(cache), [1, 2]);
  assert.deepEqual(readdirSync(s.file), []);
});

test("load: a named pipe at the cache path is blocked and never opened", async () => {
  const s = setup({ odev: fakeOdev({ all: rows(1) }) });
  mkdirSync(s.dir, { recursive: true });
  assert.equal(spawnSync("mkfifo", [s.file]).status, 0);
  await s.store.load();
  assert.match(s.store.status().error, /not a regular file/);
  assert.deepEqual(numbers((await s.store.sync(), s.store.cache())), [1]);
});

test("load: an unreadable file is noted and refetched", { skip: isRoot }, async () => {
  const s = setup({ odev: fakeOdev({ all: rows(1) }) });
  writeCache(s.file, { issues: { 1: row(1) } });
  chmodSync(s.file, 0o000);
  await s.store.load();
  assert.match(s.store.status().note, /cannot (check|read) cache file/);
  assert.deepEqual(numbers((await s.store.sync(), s.store.cache())), [1]);
});

test("load: a missing probe program (no sh) is noted, and rows still sync into memory with a save error", async () => {
  const io = herdrIO({ exec: async () => { throw new Error("spawn sh ENOENT"); }, fs });
  const s = setup({ io, odev: fakeOdev({ all: rows(1) }) });
  await s.store.load();
  assert.match(s.store.status().note, /cannot check cache file: spawn sh ENOENT/);
  assert.deepEqual(numbers((await s.store.sync(), s.store.cache())), [1]);
  assert.match(s.store.status().error, /cannot save cache/);
});

test("save: a read-only data folder keeps the rows in memory and reports the error, then recovers", { skip: isRoot }, async () => {
  const s = setup({ odev: fakeOdev({ all: rows(1, 2) }) });
  mkdirSync(s.dir, { recursive: true });
  chmodSync(s.dir, 0o555);
  await s.store.sync();
  const cache = s.store.cache();
  assert.deepEqual(numbers(cache), [1, 2]);
  assert.deepEqual(numbers(s.store.cache()), [1, 2]);
  assert.match(s.store.status().error, /^cannot save cache: .*EACCES/);
  assert.deepEqual(readdirSync(s.dir), []);
  chmodSync(s.dir, 0o755);
  await s.store.sync();
  assert.equal(s.store.status().error, null);
  assert.deepEqual(Object.keys(readCache(s.file).issues), ["1", "2"]);
});

test("save: a data folder that cannot be created reports the error and keeps the rows", { skip: isRoot }, async () => {
  const parent = join(root, `ro-parent-${++seq}`);
  mkdirSync(parent);
  chmodSync(parent, 0o555);
  const s = setup({ dir: join(parent, "data", "onedev-issues"), odev: fakeOdev({ all: rows(1) }) });
  assert.deepEqual(numbers((await s.store.sync(), s.store.cache())), [1]);
  assert.match(s.store.status().error, /cannot save cache/);
});

test("save: a cache that would exceed the size cap is not written and says so", async () => {
  const fat = rows(1).map((r) => ({ ...r, title: "x".repeat(9 * 1024 * 1024) }));
  const s = setup({ odev: fakeOdev({ all: fat }) });
  await s.store.sync();
  const cache = s.store.cache();
  assert.deepEqual(numbers(cache), [1]);
  assert.match(s.store.status().error, /over the .* limit/);
  assert.equal(existsSync(s.dir), false);
});

test("save: the file survives a reload with rows, mine and known intact", async () => {
  const a = setup({ odev: fakeOdev({ all: rows(1, 2), mine: rows(2), lookup: () => new Map([[40, { number: 40, title: "t", state: "Open" }], [41, null]]) }) });
  await a.store.sync();
  await a.store.resolve([40, 41]);
  const b = createCaches({ io: herdrIO({ exec: nodeExec, fs }), odev: fakeOdev(), dir: a.dir, now: () => T0 }).get(V);
  assert.deepEqual(await b.load(), a.store.cache());
});

test("serialised syncs: two concurrent sync calls share one run", async () => {
  const odev = fakeOdev({ all: rows(1, 2) });
  odev.delay = 20;
  const s = setup({ odev });
  const [a, b] = await Promise.all([s.store.sync(), s.store.sync()]);
  assert.equal(a, b);
  assert.equal(odev.lists.length, 2);
  assert.equal(s.store.status().userSyncing, false);
});

test("serialised syncs: a user sync during a user sync, and a background call, join it", async () => {
  const odev = fakeOdev({ all: rows(1) });
  odev.delay = 20;
  const s = setup({ odev });
  await Promise.all([s.store.sync({ user: true }), s.store.sync({ user: true }), s.store.sync()]);
  assert.equal(odev.lists.length, 2);
});

test("save: the size cap counts UTF-8 bytes, not characters", async () => {
  const title = "\u00e9".repeat(4.3 * 1024 * 1024);
  assert.ok(title.length < 8 * 1024 * 1024);
  const s = setup({ odev: fakeOdev({ all: [row(1, { title })] }) });
  await s.store.sync();
  const cache = s.store.cache();
  assert.deepEqual(numbers(cache), [1]);
  assert.match(s.store.status().error, /bytes is over the/);
  assert.equal(existsSync(s.file), false);
});

test("serialised syncs: concurrent syncs never write the file at the same time", async () => {
  let active = 0;
  let overlap = 0;
  let writes = 0;
  const base = herdrIO({ exec: nodeExec, fs });
  const io = {
    ...base,
    async writeText(p, t) {
      overlap = Math.max(overlap, ++active);
      writes++;
      await new Promise((r) => setTimeout(r, 10));
      await base.writeText(p, t);
      active--;
    },
  };
  const odev = fakeOdev({ all: rows(1), lookup: (ns) => new Map(ns.map((n) => [n, null])) });
  odev.delay = 5;
  const s = setup({ io, odev });
  await Promise.all([
    s.store.sync(), s.store.sync({ user: true }), s.store.resolve([100]),
    s.store.sync({ user: true }), s.store.resolve([101]), s.store.sync(),
  ]);
  assert.equal(overlap, 1);
  assert.ok(writes >= 2);
  assert.doesNotThrow(() => JSON.parse(readFileSync(s.file, "utf8")));
  assert.deepEqual(Object.keys(readCache(s.file).known), ["100", "101"]);
});

test("serialised syncs: a lookup waits for the running sync", async () => {
  const odev = fakeOdev({ all: rows(1) });
  odev.delay = 15;
  const s = setup({ odev });
  const sync = s.store.sync();
  const look = s.store.resolve([77]);
  await Promise.all([sync, look]);
  assert.ok(odev.events.indexOf("lookup:start") > odev.events.lastIndexOf("list:mine:end"), odev.events.join(" "));
});

test("one store per project: both host spellings reach one canonical verdict, one store and one file", async () => {
  const s = setup({ odev: fakeOdev({ all: rows(1) }) });
  const viaIp = s.caches.get(verdict({ host: "http://192.0.2.30:6610" }));
  const viaName = s.caches.get(verdict({ host: "http://192.0.2.30:6610", projectId: 72 }));
  assert.equal(viaIp, viaName);
  await Promise.all([viaIp.sync(), viaName.sync()]);
  assert.equal(readdirSync(s.dir).filter((f) => f.startsWith("project-")).length, 1);
  assert.notEqual(s.caches.get(verdict({ project: "team/other" })), viaIp);
  assert.notEqual(s.caches.get(verdict({ host: "https://onedev.example.com" })), viaIp);
});

test("resolve: asks only for numbers that are in neither issues nor known, and remembers misses", async () => {
  const odev = fakeOdev({ all: rows(1, 2), lookup: (ns) => new Map(ns.map((n) => [n, n === 99 ? null : { number: n, title: `T${n}`, state: "Open" }])) });
  const s = setup({ odev });
  await s.store.sync();
  await s.store.resolve([1, 2, 50, 99]);
  const cache = s.store.cache();
  assert.deepEqual(odev.lookups, [[50, 99]]);
  assert.deepEqual(cache.known["50"], { number: 50, title: "T50", state: "Open" });
  assert.equal(cache.known["99"], null);
  await s.store.resolve([1, 2, 50, 99]);
  assert.equal(odev.lookups.length, 1);
});

test("resolve: the steady state runs no odev at all", async () => {
  const odev = fakeOdev({ all: rows(1) });
  const s = setup({ odev });
  await s.store.sync();
  await s.store.resolve([1]);
  await s.store.resolve([]);
  await s.store.resolve([0, -1, 1.5, "x", NaN]);
  assert.equal(odev.lookups.length, 0);
});

test("resolve: at most 8 numbers go to one lookup", async () => {
  const odev = fakeOdev({ lookup: (ns) => new Map(ns.map((n) => [n, null])) });
  const s = setup({ odev });
  await s.store.resolve(Array.from({ length: 20 }, (_, i) => i + 100));
  assert.equal(odev.lookups[0].length, 8);
});

test("resolve: a failed lookup is not remembered, is retried after 60 s, and shows an error", async () => {
  const odev = fakeOdev({ lookup: () => ({ ok: false, error: { kind: "exit", message: "odev: host down" } }) });
  const s = setup({ odev });
  await s.store.resolve([50]);
  assert.equal(s.store.status().error, "odev: host down");
  assert.deepEqual(s.store.cache().known, {});
  s.clock.t += 59_000;
  await s.store.resolve([50]);
  assert.equal(odev.lookups.length, 1);
  s.clock.t += 2_000;
  odev.data.lookup = () => new Map([[50, null]]);
  await s.store.resolve([50]);
  assert.equal(odev.lookups.length, 2);
  assert.equal(s.store.status().error, null);
  assert.equal(s.store.cache().known["50"], null);
});

test("resolve: a number the lookup left out (a non-miss error) is retried, not remembered", async () => {
  const odev = fakeOdev({ lookup: () => new Map() });
  const s = setup({ odev });
  await s.store.resolve([50]);
  assert.deepEqual(s.store.cache().known, {});
  s.clock.t += 61_000;
  await s.store.resolve([50]);
  assert.equal(odev.lookups.length, 2);
});

function countingIO() {
  const base = herdrIO({ exec: nodeExec, fs });
  const io = { ...base, writes: 0, async writeText(p, t) { io.writes++; await base.writeText(p, t); } };
  return io;
}

test("sync: a title edit that OneDev did not count as activity reaches the cache on the next background sync", async () => {
  const s = setup({ odev: fakeOdev({ all: rows(1, 2) }) });
  await s.store.sync();
  s.clock.t += 30_000;
  s.odev.data.all = [row(1), row(2, { title: "edited", updated: "2026-11-03T10:00:00.000Z" })];
  assert.deepEqual(await s.store.sync(), { changed: true });
  assert.equal(s.store.cache().issues["2"].title, "edited");
  assert.equal(s.store.cache().synced, T0 + 30_000);
  assert.equal(readCache(s.file).issues["2"].title, "edited");
});

test("sync: every call lists all rows and mine, never --since", async () => {
  const s = setup({ odev: fakeOdev({ all: rows(1), mine: rows(1) }) });
  for (let i = 0; i < 3; i++) {
    s.clock.t += 30_000;
    await s.store.sync(i === 1 ? { user: true } : { user: false });
  }
  assert.equal(s.odev.lists.length, 6);
  assert.equal(s.odev.lists.every((q) => q.since === undefined), true);
  assert.deepEqual(s.odev.lists.map((q) => q.mine === true), [false, true, false, true, false, true]);
});

test("sync: rows and mine equal to the current ones keep the same state, write no file and report no change", async () => {
  const io = countingIO();
  const s = setup({ io, odev: fakeOdev({ all: rows(1, 2), mine: rows(2) }) });
  await s.store.sync();
  const state = s.store.cache();
  const writes = io.writes;
  s.clock.t += 30_000;
  s.odev.data.all = rows(1, 2);
  s.odev.data.mine = rows(2);
  assert.deepEqual(await s.store.sync(), { changed: false });
  assert.equal(s.store.cache(), state);
  assert.equal(s.store.cache().synced, T0);
  assert.equal(io.writes, writes);
  s.odev.data.mine = rows(1);
  assert.deepEqual(await s.store.sync(), { changed: true });
  assert.deepEqual(s.store.cache().mine, [1]);
  assert.equal(io.writes, writes + 1);
});

test("sync: a first sync that finds no rows still counts as synced and is written", async () => {
  const s = setup({ odev: fakeOdev({ all: [], mine: [] }) });
  assert.deepEqual(await s.store.sync(), { changed: true });
  assert.equal(s.store.cache().synced, T0);
  assert.deepEqual(readCache(s.file).issues, {});
});

test("status: only a user sync is userSyncing; a user call joining a background sync turns it on", async () => {
  const odev = fakeOdev({ all: rows(1) });
  odev.delay = 20;
  const s = setup({ odev });
  const background = s.store.sync({ user: false });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(s.store.status().userSyncing, false);
  const user = s.store.sync({ user: true });
  assert.equal(s.store.status().userSyncing, true);
  await Promise.all([background, user]);
  assert.equal(odev.lists.length, 2);
  assert.equal(s.store.status().userSyncing, false);
  const alone = s.store.sync({ user: true });
  assert.equal(s.store.status().userSyncing, true);
  await alone;
  assert.equal(s.store.status().userSyncing, false);
});

test("resolve: changed is true when known gains an entry or the error changes, and false in the steady state", async () => {
  const odev = fakeOdev({ all: rows(1), lookup: (ns) => new Map(ns.map((n) => [n, null])) });
  const s = setup({ odev });
  await s.store.sync();
  assert.deepEqual(await s.store.resolve([50]), { changed: true });
  assert.deepEqual(await s.store.resolve([50, 1]), { changed: false });
  assert.deepEqual(await s.store.resolve([]), { changed: false });
  odev.data.lookup = () => ({ ok: false, error: { kind: "exit", message: "odev: host down" } });
  assert.deepEqual(await s.store.resolve([60]), { changed: true });
  s.clock.t += 61_000;
  assert.deepEqual(await s.store.resolve([60]), { changed: false });
  s.clock.t += 61_000;
  odev.data.lookup = () => new Map();
  assert.deepEqual(await s.store.resolve([60]), { changed: true });
});

test("resolve: a lookup that adds nothing writes no file", async () => {
  const io = countingIO();
  const s = setup({ io, odev: fakeOdev({ all: rows(1), lookup: () => new Map() }) });
  await s.store.sync();
  const writes = io.writes;
  await s.store.resolve([50]);
  assert.equal(io.writes, writes);
});

test("resolve: known keeps 200 entries, the ones just answered first, then the highest numbers", async () => {
  const s = setup({ odev: fakeOdev({ lookup: (ns) => new Map(ns.map((n) => [n, null])) }) });
  const old = Object.fromEntries(Array.from({ length: 199 }, (_, i) => [String(1000 + i), null]));
  writeCache(s.file, { issues: { 1: row(1) }, known: old });
  await s.store.load();
  await s.store.resolve([2, 3, 4, 5, 6, 7, 8, 9]);
  const keys = Object.keys(s.store.cache().known).map(Number);
  assert.equal(keys.length, 200);
  for (const n of [2, 9, 1007, 1198]) assert.ok(keys.includes(n), String(n));
  for (const n of [1000, 1006]) assert.equal(keys.includes(n), false, String(n));
  assert.equal(Object.keys(readCache(s.file).known).length, 200);
});

test("resolve: failure memory holds 200 numbers, so the oldest failure is asked again before 60 s", async () => {
  const odev = fakeOdev({ lookup: () => ({ ok: false, error: { kind: "exit", message: "odev: host down" } }) });
  const s = setup({ odev });
  for (let b = 0; b < 26; b++) await s.store.resolve(Array.from({ length: 8 }, (_, i) => 100 + b * 8 + i));
  assert.equal(odev.lookups.length, 26);
  await s.store.resolve([307]);
  assert.equal(odev.lookups.length, 26);
  await s.store.resolve([100]);
  assert.equal(odev.lookups.length, 27);
});

test("file name: the canonical host and project give a readable, stable name", () => {
  assert.equal(cacheFileName(V), "project-http_3A_2F_2F192.0.2.30_3A6610__team_2Fapp.json");
});

test("file name: both host spellings give one file when the canonical host is equal", () => {
  assert.equal(cacheFileName(verdict({ projectId: 1 })), cacheFileName(verdict({ projectId: 2 })));
  assert.notEqual(cacheFileName(verdict()), cacheFileName(verdict({ host: "https://onedev.example.com" })));
});

test("file name: spaces and unicode in the project path are escaped, and the name is one safe path segment", () => {
  const name = cacheFileName(verdict({ project: "my group/проект 日本 \u{1F389}" }));
  assert.match(name, /^[A-Za-z0-9._-]+$/);
  assert.match(name, /__my_20group_2F_D0_BF/);
  assert.ok(name.endsWith(".json"));
});

test("file name: an underscore is escaped so a_b, a/b and a-b never collide", () => {
  const names = ["a_b", "a/b", "a-b", "a b", "a__b", "a_5Fb"].map((project) => cacheFileName(verdict({ project })));
  assert.equal(new Set(names).size, names.length);
  assert.match(names[0], /__a_5Fb\.json$/);
});

test("file name: dots, slashes and traversal in the project cannot leave the data folder", () => {
  for (const project of ["../../etc/passwd", "..", ".", "a/../b", "/abs", "x\0y", "x\ny", "\uD800lone"]) {
    const name = cacheFileName(verdict({ project }));
    assert.match(name, /^project-[A-Za-z0-9._-]+\.json$/, project);
    assert.equal(name.includes("/"), false);
  }
  assert.equal(new Set(["x\0y", "x\ny", "\uD800lone", "\uD801lone"].map((project) => cacheFileName(verdict({ project })))).size, 4);
});

test("file name: a long name keeps a prefix plus a hash, fits 255 bytes, and stays distinct and stable", () => {
  const long = (tail) => cacheFileName(verdict({ project: "g/" + "very-long-segment-".repeat(30) + tail }));
  const a = long("one");
  const b = long("two");
  assert.ok(a.length <= 255 && a.length >= 160);
  assert.notEqual(a, b);
  assert.equal(a, long("one"));
  assert.match(a, /-[0-9a-f]{8}\.json$/);
  const unicodeLong = cacheFileName(verdict({ project: "日本".repeat(200) }));
  assert.ok(Buffer.byteLength(unicodeLong) <= 255);
});

test("file name: a long project path really works as a file on disk", async () => {
  const s = setup({ odev: fakeOdev({ all: rows(1) }) });
  const p = verdict({ project: "g/" + "日本語-".repeat(120) });
  const store = s.caches.get(p);
  await store.sync();
  assert.deepEqual(readdirSync(s.dir).length, 1);
});

test("herdrIO probe: absent, file with size, symlink, directory and other", async () => {
  const dir = join(root, `probe-${++seq}`);
  mkdirSync(dir);
  const io = herdrIO({ exec: nodeExec, fs });
  writeFileSync(join(dir, "f"), "12345");
  symlinkSync(join(dir, "f"), join(dir, "l"));
  mkdirSync(join(dir, "d"));
  spawnSync("mkfifo", [join(dir, "p")]);
  assert.deepEqual(await io.probe(join(dir, "nope")), { kind: "absent" });
  assert.deepEqual(await io.probe(join(dir, "f")), { kind: "file", bytes: 5 });
  assert.deepEqual(await io.probe(join(dir, "l")), { kind: "symlink" });
  assert.deepEqual(await io.probe(join(dir, "d")), { kind: "directory" });
  assert.deepEqual(await io.probe(join(dir, "p")), { kind: "other" });
});

test("herdrIO probe: a path with spaces, quotes, $ and a newline is passed as data, not as shell", async () => {
  const dir = join(root, `probe-${++seq}`);
  mkdirSync(dir);
  const io = herdrIO({ exec: nodeExec, fs });
  const evil = join(dir, "a b'c\"d$(touch injected-by-probe)`touch injected-too`;\ne");
  writeFileSync(evil, "xyz");
  assert.deepEqual(await io.probe(evil), { kind: "file", bytes: 3 });
  for (const f of ["injected-by-probe", "injected-too"]) {
    assert.equal(existsSync(join(process.cwd(), f)) || existsSync(join(dir, f)), false, f);
  }
});

test("herdrIO probe: an unexpected answer or a failing shell throws", async () => {
  const bad = (stdout, code = 0) => herdrIO({ exec: async () => ({ code, stdout, stderr: "sh: boom" }), fs });
  await assert.rejects(bad("banana\n").probe("/x"), /probe answered/);
  await assert.rejects(bad("file\nabc\n").probe("/x"), /probe answered/);
  await assert.rejects(bad("file\n").probe("/x"), /probe answered/);
  await assert.rejects(bad("", 127).probe("/x"), /probe failed \(127\): sh: boom/);
});

const OD = { kind: "onedev", host: "http://h", project: "g/p", projectId: 1 };
const LAST = { kind: "onedev", host: "http://h", project: "g/last", projectId: 2 };
const NO = { kind: "not-onedev", reason: "no-origin" };

test("chooseView: a onedev folder selects onedev-issues for that project, in either mode", () => {
  for (const shared of [true, false]) {
    assert.deepEqual(chooseView(OD, shared, LAST), { action: "show", child: "onedev-issues", project: OD });
    assert.deepEqual(chooseView(OD, shared, null), { action: "show", child: "onedev-issues", project: OD });
  }
});

test("chooseView: shared, a not-onedev folder selects the upstream issues child", () => {
  assert.deepEqual(chooseView(NO, true, LAST), { action: "show", child: "issues", project: LAST });
  assert.deepEqual(chooseView(NO, true, null), { action: "show", child: "issues", project: null });
});

test("chooseView: separate, a not-onedev folder keeps the OneDev panel and the last project", () => {
  assert.deepEqual(chooseView(NO, false, LAST), { action: "show", child: "onedev-issues", project: LAST });
});

test("chooseView: separate, a not-onedev folder in a space that never had a project gives the empty state", () => {
  assert.deepEqual(chooseView(NO, false, null), { action: "show", child: "onedev-issues", project: null });
});

test("chooseView: every not-onedev reason behaves the same", () => {
  for (const reason of ["no-git", "no-origin", "unknown-host", "no-project"]) {
    assert.deepEqual(chooseView({ kind: "not-onedev", reason }, true, LAST), { action: "show", child: "issues", project: LAST });
    assert.deepEqual(chooseView({ kind: "not-onedev", reason }, false, LAST), { action: "show", child: "onedev-issues", project: LAST });
  }
});

test("chooseView: a failed lookup goes to the GitHub panel when shared, to the OneDev panel when separate", () => {
  assert.deepEqual(chooseView({ kind: "failed" }, true, LAST), { action: "show", child: "issues", project: LAST });
  assert.deepEqual(chooseView({ kind: "failed" }, true, null), { action: "show", child: "issues", project: null });
  assert.deepEqual(chooseView({ kind: "failed" }, false, LAST), { action: "show", child: "onedev-issues", project: LAST });
});

test("chooseView: no verdict yet keeps the current view, in either mode", () => {
  for (const shared of [true, false]) {
    assert.deepEqual(chooseView(null, shared, LAST), { action: "keep" });
    assert.deepEqual(chooseView(undefined, shared, null), { action: "keep" });
  }
});

const cacheOf = (...rs) => ({ issues: Object.fromEntries(rs.map((r) => [String(r.number), r])) });

test("stateTabs: one tab per state with counts, ordered by stateOrdinal, then name", () => {
  const tabs = stateTabs(cacheOf(
    row(1, { state: "Closed", stateOrdinal: 1 }), row(2, { state: "Open", stateOrdinal: 0 }), row(3, { state: "Open", stateOrdinal: 0 }),
    row(4, { state: "In Review", stateOrdinal: 2 }), row(5, { state: "Closed", stateOrdinal: 1 }), row(6, { state: "Closed", stateOrdinal: 1 }),
  ));
  assert.deepEqual(tabs, [
    { name: "Open", ordinal: 0, count: 2 },
    { name: "Closed", ordinal: 1, count: 3 },
    { name: "In Review", ordinal: 2, count: 1 },
  ]);
});

test("stateTabs: states without an ordinal come last, in name order, and a null row does not hide a known ordinal", () => {
  const tabs = stateTabs(cacheOf(
    row(1, { state: "Zed", stateOrdinal: null }), row(2, { state: "Alpha", stateOrdinal: null }),
    row(3, { state: "Open", stateOrdinal: null }), row(4, { state: "Open", stateOrdinal: 0 }), row(5, { state: "Closed", stateOrdinal: 1 }),
  ));
  assert.deepEqual(tabs.map((t) => [t.name, t.ordinal, t.count]), [["Open", 0, 2], ["Closed", 1, 1], ["Alpha", null, 1], ["Zed", null, 1]]);
});

test("stateTabs: an empty cache gives no tabs", () => {
  assert.deepEqual(stateTabs(cacheOf()), []);
});

const sorted = (id, ...rs) => rs.sort(SORTS.find((s) => s.id === id).compare).map((r) => r.number);

test("SORTS: the menu is Newest, Oldest, Recently updated, Least recently updated, Most commented", () => {
  assert.deepEqual(SORTS.map((s) => s.label), ["Newest", "Oldest", "Recently updated", "Least recently updated", "Most commented"]);
  assert.deepEqual(SORTS.map((s) => s.id), ["newest", "oldest", "updated", "stale", "comments"]);
});

test("SORTS: newest and oldest go by number", () => {
  const rs = () => [row(2), row(9), row(5)];
  assert.deepEqual(sorted("newest", ...rs()), [9, 5, 2]);
  assert.deepEqual(sorted("oldest", ...rs()), [2, 5, 9]);
});

test("SORTS: updated and stale go by the updated time, unknown times last, ties by number", () => {
  const rs = () => [
    row(1, { updated: "2026-11-01T00:00:00Z" }), row(2, { updated: "2026-11-03T00:00:00Z" }),
    row(3, { updated: null }), row(4, { updated: "garbage" }), row(5, { updated: "2026-11-03T00:00:00Z" }),
  ];
  assert.deepEqual(sorted("updated", ...rs()), [5, 2, 1, 4, 3]);
  assert.deepEqual(sorted("stale", ...rs()), [1, 2, 5, 3, 4]);
});

test("SORTS: comments go by commentCount, null counts as 0, ties by number newest first", () => {
  const rs = () => [row(1, { commentCount: 5 }), row(2, { commentCount: null }), row(3, { commentCount: 5 }), row(4, { commentCount: 0 }), row(5, { commentCount: 9 })];
  assert.deepEqual(sorted("comments", ...rs()), [5, 3, 1, 4, 2]);
});

test("displayText: ANSI sequences, controls and OSC titles are removed", () => {
  assert.equal(displayText("\u001b[31mred\u001b[0m"), "red");
  assert.equal(displayText("a\u001b]0;evil title\u0007b"), "ab");
  assert.equal(displayText("a\u001b]8;;http://x\u001b\\link\u001b]8;;\u001b\\"), "alink");
  assert.equal(displayText("a\u0000b\u0007c\u007fd\u0085e\u009bf"), "abcdef");
  assert.equal(displayText("\u001b[1;38;5;196mx\u001b[K"), "x");
});

test("displayText: bidi controls and zero-width spaces are removed", () => {
  assert.equal(displayText("‮evil‬ ⁦x⁩ ‎left‏​gone﻿"), "evil x leftgone");
});

test("displayText: ZWJ, ZWNJ and emoji are kept", () => {
  const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
  assert.equal(displayText(`hi ${family} \u{1F389}`), `hi ${family} \u{1F389}`);
  assert.equal(displayText("a‌b"), "a‌b");
});

test("displayText: whitespace runs, tabs and newlines become one space and the ends are trimmed", () => {
  assert.equal(displayText("  a \t\n b\r\nc d  "), "a b c d");
});

test("displayText: markdown and html are left as they are", () => {
  assert.equal(displayText("# **bold** [x](y) <b>"), "# **bold** [x](y) <b>");
});

test("displayText: truncation keeps the result within max, ends with an ellipsis, and does not split an emoji", () => {
  assert.equal(displayText("abcdef", 6), "abcdef");
  assert.equal(displayText("abcdef", 5), "abcd…");
  assert.equal(displayText("ab\u{1F389}cd", 4), "ab…");
  assert.equal(displayText("ab\u{1F389}cd", 5), "ab\u{1F389}…");
  assert.equal(displayText("abc", 1), "…");
  assert.equal(displayText("abc", 0), "");
  const long = displayText("x".repeat(10_000), 120);
  assert.equal(long.length, 120);
  assert.ok(long.endsWith("…"));
});

test("displayText: a non-string gives an empty string", () => {
  for (const x of [null, undefined, 5, {}, []]) assert.equal(displayText(x, 10), "");
});

test("displayText: a hostile 1 MB string with escapes is handled quickly", () => {
  const t0 = performance.now();
  displayText("\u001b[".repeat(250_000), 50);
  displayText("\u001b]".repeat(250_000), 50);
  displayText(" \t".repeat(500_000), 50);
  assert.ok(performance.now() - t0 < 500, `took ${performance.now() - t0} ms`);
});
