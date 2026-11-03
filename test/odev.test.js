import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as odevModule from "../odev.js";
import { fakeExec, nodeExec, reply, verdict, wireRow, writeExecutable } from "./helpers.js";

const { createOdev, loadConfig, parseIssueRow, parseOdevConfig, utf8Length } = odevModule;
const V = verdict();
const isRoot = process.getuid?.() === 0;
const json = JSON.stringify;
const odevWith = (answer) => {
  const exec = fakeExec(answer);
  return { exec, odev: createOdev({ exec, path: "odev" }) };
};
const listWith = (stdout, code = 0, stderr = "") => odevWith(() => reply(stdout, code, stderr)).odev.list({ verdict: V });

let dir;
before(() => { dir = mkdtempSync(join(tmpdir(), "odev-test-")); });
after(() => rmSync(dir, { recursive: true, force: true }));

test("verdict: onedev answer parses with host, project and projectId", async () => {
  const { exec, odev } = odevWith(() => reply(json(V)));
  const r = await odev.which("/home/user/code/odev");
  assert.deepEqual(r, { ok: true, value: V });
  assert.deepEqual(exec.calls[0].args, ["-C", "/home/user/code/odev", "project", "which", "--json"]);
});

for (const reason of ["no-git", "no-origin", "unknown-host", "no-project"]) {
  test(`verdict: not-onedev with reason ${reason} parses`, async () => {
    const r = await odevWith(() => reply(json({ kind: "not-onedev", reason }))).odev.which("/tmp");
    assert.deepEqual(r, { ok: true, value: { kind: "not-onedev", reason } });
  });
}

test("verdict: an unknown reason is a shape error", async () => {
  const r = await odevWith(() => reply(json({ kind: "not-onedev", reason: "volcano" }))).odev.which("/tmp");
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, "shape");
});

test("verdict: a missing projectId is a shape error", async () => {
  const { projectId, ...rest } = V;
  const r = await odevWith(() => reply(json(rest))).odev.which("/tmp");
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, "shape");
});

test("verdict: a string, zero or fractional projectId is a shape error", async () => {
  for (const projectId of ["72", 0, 1.5, null]) {
    const r = await odevWith(() => reply(json({ ...V, projectId }))).odev.which("/tmp");
    assert.equal(r.ok, false, `projectId ${json(projectId)}`);
  }
});

test("verdict: an empty host or project is a shape error", async () => {
  for (const over of [{ host: "" }, { project: "" }, { host: 5 }]) {
    const r = await odevWith(() => reply(json({ ...V, ...over }))).odev.which("/tmp");
    assert.equal(r.ok, false, json(over));
  }
});

test("verdict: an unknown kind is a shape error", async () => {
  const r = await odevWith(() => reply(json({ kind: "gitlab" }))).odev.which("/tmp");
  assert.equal(r.error.kind, "shape");
});

test("verdict: an array where an object belongs is a shape error", async () => {
  const r = await odevWith(() => reply("[]")).odev.which("/tmp");
  assert.equal(r.error.kind, "shape");
});

test("verdict: exit 1 (could not decide) is an exit error carrying the stderr line", async () => {
  const r = await odevWith(() => reply("", 1, "odev: no token for http://192.0.2.30:6610\n")).odev.which("/tmp");
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, "exit");
  assert.equal(r.error.message, "odev: no token for http://192.0.2.30:6610");
  assert.equal(r.error.code, 1);
});

test("verdict: the space's machine is passed to exec as `on`", async () => {
  const { exec, odev } = odevWith(() => reply(json(V)));
  await odev.which("/srv/x", "nas");
  assert.deepEqual(exec.calls[0].opts, { on: "nas" });
});

test("list: argv carries the project flags, the row cap and no -C", async () => {
  const { exec, odev } = odevWith(() => reply("[]"));
  const r = await odev.list({ verdict: V });
  assert.deepEqual(r, { ok: true, value: [] });
  assert.deepEqual(exec.calls[0].args, [
    "issue", "list", "--json", "--state", "all", "-L", "500",
    "--host", V.host, "--project", V.project,
  ]);
});

test("list: since is written as RFC 3339 with Z, floored to the second, and mine adds --assignee me", async () => {
  const { exec, odev } = odevWith(() => reply("[]"));
  await odev.list({ verdict: V, since: Date.UTC(2026, 10, 3, 9, 0, 0, 999), mine: true });
  const a = exec.calls[0].args;
  assert.equal(a[a.indexOf("--since") + 1], "2026-11-03T09:00:00Z");
  assert.equal(a[a.indexOf("--assignee") + 1], "me");
});

test("list: an invalid since is a call error and nothing runs", async () => {
  for (const since of [NaN, Infinity, -5, "yesterday", null]) {
    const { exec, odev } = odevWith(() => reply("[]"));
    const r = await odev.list({ verdict: V, since });
    assert.equal(r.ok, false, String(since));
    assert.equal(r.error.kind, "call");
    assert.equal(exec.calls.length, 0);
  }
});

test("row: a wire row keeps the list fields and drops description", () => {
  const row = parseIssueRow(wireRow(12));
  assert.equal(row.number, 12);
  assert.equal(row.title, "Issue 12");
  assert.equal(row.state, "Open");
  assert.equal(row.stateOrdinal, 0);
  assert.deepEqual(row.submitter, { id: 3, login: "john" });
  assert.deepEqual(row.fields, { Assignees: null, Tags: ["a"] });
  assert.equal("description" in row, false);
});

test("row: parsing a parsed row changes nothing", () => {
  const once = parseIssueRow(wireRow(5, { stateOrdinal: null, submitter: null, commentCount: null }));
  assert.deepEqual(parseIssueRow(once), once);
});

test("row: a missing number rejects the row", () => {
  const { number, ...rest } = wireRow(1);
  assert.equal(parseIssueRow(rest), null);
});

test("row: a string number rejects the row and is never coerced", () => {
  assert.equal(parseIssueRow(wireRow(1, { number: "12" })), null);
});

test("row: zero, negative, fractional and unsafe numbers reject the row", () => {
  for (const number of [0, -3, 1.5, 2 ** 60, null, NaN]) assert.equal(parseIssueRow(wireRow(1, { number })), null, String(number));
});

test("row: a missing title or state rejects the row", () => {
  assert.equal(parseIssueRow(wireRow(1, { title: undefined })), null);
  assert.equal(parseIssueRow(wireRow(1, { title: 5 })), null);
  assert.equal(parseIssueRow(wireRow(1, { state: undefined })), null);
  assert.equal(parseIssueRow(wireRow(1, { state: "" })), null);
});

test("row: not an object rejects the row", () => {
  for (const x of [null, undefined, 5, "row", [], [wireRow(1)]]) assert.equal(parseIssueRow(x), null);
});

test("row: a title of 10 000 characters is kept whole", () => {
  const title = "x".repeat(10_000);
  assert.equal(parseIssueRow(wireRow(1, { title })).title, title);
});

test("row: titles with RTL marks, emoji, ZWJ, ANSI and markdown are kept raw", () => {
  const titles = [
    "\u202Eevil\u202C title \u200F",
    "party \u{1F389} and family \u{1F468}\u200D\u{1F469}\u200D\u{1F467}",
    "\u001b[31mred\u001b[0m and \u001b]0;title\u0007",
    "# heading **bold** [link](http://x) `code` <b>html</b>",
  ];
  for (const title of titles) assert.equal(parseIssueRow(wireRow(1, { title })).title, title);
});

test("row: stateOrdinal null stays null and a non-integer ordinal becomes null", () => {
  assert.equal(parseIssueRow(wireRow(1, { stateOrdinal: null })).stateOrdinal, null);
  assert.equal(parseIssueRow(wireRow(1, { stateOrdinal: "2" })).stateOrdinal, null);
  assert.equal(parseIssueRow(wireRow(1, { stateOrdinal: 1.5 })).stateOrdinal, null);
  assert.equal(parseIssueRow(wireRow(1, { stateOrdinal: 2 })).stateOrdinal, 2);
});

test("row: malformed ordering fields degrade to null instead of rejecting the row", () => {
  const row = parseIssueRow(wireRow(1, { updated: 5, submitDate: {}, commentCount: "3", submitter: "john", fields: [1], confidential: "yes" }));
  assert.deepEqual(
    [row.updated, row.submitDate, row.commentCount, row.submitter, row.fields, row.confidential],
    [null, null, null, null, null, false],
  );
});

test("row: a __proto__ key in fields becomes data and pollutes nothing", () => {
  const row = parseIssueRow(JSON.parse('{"number":1,"title":"t","state":"Open","fields":{"__proto__":["x"],"ok":"y"}}'));
  assert.equal(Object.getPrototypeOf(row.fields), Object.prototype);
  assert.equal(({}).x, undefined);
  assert.deepEqual(Object.keys(row.fields).sort(), ["__proto__", "ok"]);
});

test("list: rows parse and notes on stderr do not matter on exit 0", async () => {
  const r = await listWith(json([wireRow(2), wireRow(1)]), 0, "Note: showing 2 of 73 issues\n");
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.map((x) => x.number), [2, 1]);
  assert.equal(r.skipped, undefined);
});

test("list: bad rows are dropped and counted, good rows survive", async () => {
  const bad = [null, 5, wireRow(3, { number: "3" }), wireRow(4, { number: undefined }), wireRow(5, { title: 7 })];
  const r = await listWith(json([wireRow(1), ...bad, wireRow(2)]));
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.map((x) => x.number), [1, 2]);
  assert.equal(r.skipped, 5);
});

test("list: a duplicate number keeps the first row and counts the second", async () => {
  const r = await listWith(json([wireRow(7, { title: "newer" }), wireRow(8), wireRow(7, { title: "older" })]));
  assert.deepEqual(r.value.map((x) => [x.number, x.title]), [[7, "newer"], [8, "Issue 8"]]);
  assert.equal(r.skipped, 1);
});

test("list: an object where an array belongs is a shape error", async () => {
  const r = await listWith(json({ issues: [] }));
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, "shape");
});

test("list: 8 MiB of rows parses fast and is capped at 1000 rows", async (t) => {
  const rows = [];
  let bytes = 2;
  for (let n = 1; bytes < 8 * 1024 * 1024; n++) {
    const row = wireRow(n, { description: "d".repeat(100) });
    rows.push(row);
    bytes += json(row).length + 1;
  }
  const body = json(rows);
  assert.ok(body.length >= 8 * 1024 * 1024);
  const t0 = performance.now();
  const r = await listWith(body);
  const ms = performance.now() - t0;
  t.diagnostic(`${rows.length} rows, ${(body.length / 1048576).toFixed(1)} MiB parsed in ${ms.toFixed(0)} ms`);
  assert.equal(r.ok, true);
  assert.equal(r.value.length, 1000);
  assert.equal(r.skipped, rows.length - 1000);
  assert.ok(ms < 2000, `took ${ms} ms`);
});

test("list: output cut at the 8 MiB runtime limit fails with a message that says so", async () => {
  const body = json(Array.from({ length: 60_000 }, (_, i) => wireRow(i + 1))).slice(0, 8 * 1024 * 1024);
  const r = await listWith(body);
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, "shape");
  assert.match(r.error.message, /8 MiB/);
});

test("list: multibyte output cut at the 8 MiB byte limit says so, though its character count is far below", async () => {
  const body = '["' + "é".repeat(4 * 1024 * 1024 + 100);
  assert.ok(body.length < 8 * 1024 * 1024 - 4096);
  const r = await listWith(body);
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, "shape");
  assert.match(r.error.message, /8 MiB/);
});

test("stdout: mise noise lines before the JSON are a shape error and the JSON is not used", async () => {
  const noise = "mise node@22.1.0 install\nmise node@22.1.0 installed\n";
  const r = await listWith(noise + json([wireRow(1)]));
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, "shape");
  assert.equal(r.error.message, "odev printed text that is not JSON");
  assert.equal("value" in r, false);
});

test("stdout: a shape error never carries stdout, and carries the stderr line when there is one", async () => {
  const noisy = "token=abc123 description text";
  const r = await listWith(noisy, 0, "warning: slow\nodev: config has no default host\n");
  assert.equal(r.error.kind, "shape");
  assert.doesNotMatch(r.error.message, /abc123|description/);
  assert.equal(r.error.message, "odev printed text that is not JSON (stderr: odev: config has no default host)");
});

test("stdout: truncated JSON is a shape error", async () => {
  const r = await listWith(json([wireRow(1), wireRow(2)]).slice(0, 150));
  assert.equal(r.error.kind, "shape");
});

test("stdout: an empty body is a shape error", async () => {
  for (const body of ["", "  \n"]) {
    const r = await listWith(body);
    assert.equal(r.error.kind, "shape", json(body));
    assert.match(r.error.message, /nothing/);
  }
});

test("stdout: JSON with a trailing newline is accepted", async () => {
  assert.equal((await listWith(json([wireRow(1)]) + "\n")).ok, true);
});

test("stdout: valid JSON on a failing exit is not used", async () => {
  const r = await listWith(json([wireRow(1)]), 1, "odev: HTTP 500\n");
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, "exit");
});

test("exit: non-zero exit surfaces the first odev: stderr line and keeps the full stderr", async () => {
  const stderr = "warning: slow link\nodev: HTTP 502: bad gateway\nhint: retry later\n";
  const r = await listWith("", 1, stderr);
  assert.deepEqual(r, { ok: false, error: { kind: "exit", message: "odev: HTTP 502: bad gateway", stderr, code: 1 } });
});

test("exit: without an odev: line the first stderr line is the message, and with none it says the code", async () => {
  assert.equal((await listWith("", 3, "\nsegfault in libx\nmore\n")).error.message, "segfault in libx");
  assert.equal((await listWith("", 7, "")).error.message, "odev exited 7");
});

test("exit: stderr is capped at 4 KiB and control characters in the message are blanked", async () => {
  const r = await listWith("", 1, "odev: \u001b[31mboom\u001b[0m\n" + "x".repeat(10_000));
  assert.equal(r.error.stderr.length, 4096);
  assert.doesNotMatch(r.error.message, /[\u0000-\u001f]/);
});

test("exec: a rejecting exec (missing binary) is a spawn error and never rejects", async () => {
  const exec = async () => { throw Object.assign(new Error("spawn /no/odev ENOENT"), { code: "ENOENT" }); };
  const odev = createOdev({ exec, path: "/no/odev" });
  for (const r of [
    await odev.which("/tmp"),
    await odev.list({ verdict: V }),
    await odev.lookup(V, [1, 2]),
  ]) {
    assert.equal(r.ok, false);
    assert.equal(r.error.kind, "spawn");
    assert.match(r.error.message, /^cannot run \/no\/odev: spawn \/no\/odev ENOENT/);
  }
});

test("exec: a synchronous throw, a string rejection and a garbage result stay failures", async () => {
  const cases = [
    () => { throw new Error("sync boom"); },
    () => Promise.reject("just a string"),
    () => undefined,
    () => ({ code: "0", stdout: "[]", stderr: "" }),
  ];
  for (const exec of cases) {
    const r = await createOdev({ exec, path: "odev" }).list({ verdict: V });
    assert.equal(r.ok, false);
    assert.equal(r.error.kind, "spawn");
  }
});

test("exec: a non-string stdout is treated as empty", async () => {
  const r = await createOdev({ exec: async () => ({ code: 0, stdout: null, stderr: null }), path: "odev" }).list({ verdict: V });
  assert.equal(r.error.kind, "shape");
});

test("api: bad arguments become call failures, never throws", async () => {
  const odev = createOdev({ exec: fakeExec(() => reply("[]")), path: "odev" });
  for (const r of [await odev.list({}), await odev.list(undefined), await odev.lookup(undefined, [1, 2]), await odev.which(undefined)]) {
    assert.equal(r.ok, false);
    assert.equal(r.error.kind, "call");
  }
  assert.equal((await odev.spellings(undefined)).error.kind, "call");
});

const view = (...entries) => json(entries);
const found = (n, title = `Issue ${n}`, state = "Open") => ({ issue: { id: n, number: n, title, state, updated: "x", description: "", confidential: false }, fields: {}, comments: [], pulls: [], submitter: null });
const notFound = (n) => ({ ref: `team/app#${n}`, error: `issue #${n} not found in team/app` });

test("lookup: exit 0 array gives known entries with number, title and state only", async () => {
  const { exec, odev } = odevWith(() => reply(view(found(1, "A", "Closed"), found(2))));
  const r = await odev.lookup(V, [1, 2]);
  assert.deepEqual([...r.value], [[1, { number: 1, title: "A", state: "Closed" }], [2, { number: 2, title: "Issue 2", state: "Open" }]]);
  assert.deepEqual(exec.calls[0].args, ["issue", "view", "1", "2", "--json", "--host", V.host, "--project", V.project]);
});

test("lookup: exit 1 with a partial array is accepted, and a not-found entry is a remembered miss", async () => {
  const r = await odevWith(() => reply(view(found(1), notFound(99999)), 1, "odev: 1 of 2 refs failed\n")).odev.lookup(V, [1, 99999]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.get(1), { number: 1, title: "Issue 1", state: "Open" });
  assert.equal(r.value.get(99999), null);
  assert.equal(r.value.has(99999), true);
});

test("lookup: a lone number is repeated so odev prints an array", async () => {
  const { exec, odev } = odevWith(() => reply(view(found(7), found(7))));
  const r = await odev.lookup(V, [7]);
  assert.deepEqual(exec.calls[0].args.slice(0, 4), ["issue", "view", "7", "7"]);
  assert.deepEqual(r.value.get(7), { number: 7, title: "Issue 7", state: "Open" });
  assert.equal(r.value.size, 1);
});

test("lookup: a miss and another error differ, since only the miss is remembered", async () => {
  const other = { ref: "team/app#2", error: "HTTP 500: server error" };
  const r = await odevWith(() => reply(view(notFound(1), other), 1, "odev: 2 of 2 refs failed\n")).odev.lookup(V, [1, 2]);
  assert.equal(r.ok, true);
  assert.equal(r.value.get(1), null);
  assert.equal(r.value.has(2), false);
});

test("lookup: not-found matching ignores case", async () => {
  const r = await odevWith(() => reply(view({ ref: "x", error: "Issue #3 NOT FOUND" }, found(4)), 1)).odev.lookup(V, [3, 4]);
  assert.equal(r.value.get(3), null);
});

test("lookup: an array of the wrong length is a shape error on exit 0 and an exit error on exit 1", async () => {
  const a = await odevWith(() => reply(view(found(1)))).odev.lookup(V, [1, 2]);
  assert.equal(a.error.kind, "shape");
  const b = await odevWith(() => reply(view(found(1)), 1, "odev: boom\n")).odev.lookup(V, [1, 2]);
  assert.deepEqual([b.error.kind, b.error.message], ["exit", "odev: boom"]);
});

test("lookup: a bare object where an array belongs is a shape error", async () => {
  const r = await odevWith(() => reply(json(found(1)))).odev.lookup(V, [1, 2]);
  assert.equal(r.error.kind, "shape");
});

test("lookup: exit 1 with an empty body (single ref not found) is an exit error with the stderr line", async () => {
  const r = await odevWith(() => reply("", 1, "odev: issue #5 not found in team/app\n")).odev.lookup(V, [5]);
  assert.deepEqual([r.error.kind, r.error.message], ["exit", "odev: issue #5 not found in team/app"]);
});

test("lookup: exit 2 is an exit error even when the body is an array", async () => {
  const r = await odevWith(() => reply(view(found(1), found(2)), 2, "odev: usage\n")).odev.lookup(V, [1, 2]);
  assert.equal(r.error.kind, "exit");
});

test("lookup: an entry that answers another number is left out", async () => {
  const r = await odevWith(() => reply(view(found(9), found(2)))).odev.lookup(V, [1, 2]);
  assert.equal(r.value.has(1), false);
  assert.equal(r.value.has(2), true);
});

test("lookup: malformed entries are left out, not fatal", async () => {
  const r = await odevWith(() => reply(view(null, { issue: { number: 2, title: 5, state: "Open" } }, found(3)), 1)).odev.lookup(V, [1, 2, 3]);
  assert.deepEqual([...r.value.keys()], [3]);
});

test("lookup: numbers are deduplicated, filtered and cut at 8", async () => {
  const { exec, odev } = odevWith((args) => reply(view(...args.slice(2, args.indexOf("--json")).map((n) => found(Number(n))))));
  await odev.lookup(V, [1, 1, 2, "3", -4, 0, 1.5, 5, 6, 7, 8, 9, 10, 11]);
  assert.deepEqual(exec.calls[0].args.slice(2, exec.calls[0].args.indexOf("--json")), ["1", "2", "5", "6", "7", "8", "9", "10"]);
});

test("lookup: no valid numbers runs nothing", async () => {
  const { exec, odev } = odevWith(() => reply("[]"));
  for (const numbers of [[], ["x"], [0], undefined, null]) {
    const r = await odev.lookup(V, numbers);
    assert.equal(r.ok, true);
    assert.equal(r.value.size, 0);
  }
  assert.equal(exec.calls.length, 0);
});

const config = (aliases) => json({ configFile: "/x", host: { value: V.host, source: "x" }, ...(aliases === undefined ? {} : { aliases }) });

test("spellings: the verdict host plus every alias that targets it, with scheme and slash normalised", async () => {
  const { exec, odev } = odevWith(() => reply(config({
    "onedev.example.com": "http://192.0.2.30:6610",
    "https://Onedev2.example.com/": "http://192.0.2.30:6610/",
    "other.example": "http://10.0.0.9:80",
    "bad": 5,
  })));
  const r = await odev.spellings(V);
  assert.deepEqual(r, { ok: true, value: ["192.0.2.30:6610", "onedev.example.com", "onedev2.example.com"] });
  assert.deepEqual(exec.calls[0].args, ["config", "view", "--json"]);
});

test("spellings: no aliases key gives the verdict host alone", async () => {
  assert.deepEqual((await odevWith(() => reply(config(undefined))).odev.spellings(V)).value, ["192.0.2.30:6610"]);
  assert.deepEqual((await odevWith(() => reply(config(null))).odev.spellings(V)).value, ["192.0.2.30:6610"]);
});

test("spellings: a failed call falls back to the verdict host and carries a warning", async () => {
  for (const answer of [() => reply("", 1, "odev: no config\n"), () => reply("not json"), () => reply("[]")]) {
    const r = await odevWith(answer).odev.spellings(V);
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, ["192.0.2.30:6610"]);
    assert.equal(typeof r.warning, "string");
  }
});

test("config: a missing file, {} and a missing odev key give odev", () => {
  for (const text of [null, "{}", '{"other": 1}']) assert.deepEqual(parseOdevConfig(text), { ok: true, value: "odev" }, String(text));
});

test("config: a bare name and an absolute path are accepted", () => {
  assert.deepEqual(parseOdevConfig('{"odev":"odev-dev"}'), { ok: true, value: "odev-dev" });
  assert.deepEqual(parseOdevConfig('{"odev":"/home/user/.local/bin/odev"}'), { ok: true, value: "/home/user/.local/bin/odev" });
  assert.deepEqual(parseOdevConfig('{"odev":"C:\\\\tools\\\\odev.exe"}'), { ok: true, value: "C:\\tools\\odev.exe" });
});

test("config: a relative path with a separator is refused", () => {
  for (const p of ["bin/odev", "./odev", "../odev", "tools\\odev.exe", "~/bin/odev"]) {
    const r = parseOdevConfig(json({ odev: p }));
    assert.equal(r.ok, false, p);
    assert.equal(r.error.kind, "config");
  }
});

test("config: a number, null, an array and an empty string for odev are refused", () => {
  for (const v of [42, null, [], {}, true, "", "   "]) {
    const r = parseOdevConfig(json({ odev: v }));
    assert.equal(r.ok, false, json(v));
    assert.equal(r.error.kind, "config");
  }
});

test("config: a NUL byte in the path is refused", () => {
  assert.equal(parseOdevConfig('{"odev":"/bin/od\\u0000ev"}').error.kind, "config");
});

test("config: a path over 4096 characters is refused", () => {
  assert.equal(parseOdevConfig(json({ odev: "/" + "a".repeat(4096) })).error.kind, "config");
});

test("config: invalid JSON, an empty file and a non-object are refused", () => {
  for (const text of ["{", "", "not json", "[]", "5", "null", '"odev"']) {
    const r = parseOdevConfig(text);
    assert.equal(r.ok, false, json(text));
    assert.equal(r.error.kind, "config");
  }
});

test("config: loadConfig turns a reader that rejects into a config error and parses what it reads", async () => {
  const r = await loadConfig(async () => { throw new Error("EISDIR: illegal operation on a directory, read\nsecond line"); }, "/x/config.json");
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, "config");
  assert.equal(r.error.message, "cannot read config.json: EISDIR: illegal operation on a directory, read");
  assert.deepEqual(await loadConfig(async () => null, "/x/config.json"), { ok: true, value: "odev" });
  assert.deepEqual(await loadConfig(async () => '{"odev":"odev-dev"}', "/x/config.json"), { ok: true, value: "odev-dev" });
  assert.equal((await loadConfig(async () => "{", "/x/config.json")).error.kind, "config");
});

test("config: an unreadable config.json on disk (a directory, a mode-000 file) is a config error, never a rejection", async () => {
  const read = (p) => readFile(p, "utf8");
  const asDir = join(dir, "cfg-dir", "config.json");
  mkdirSync(asDir, { recursive: true });
  const r = await loadConfig(read, asDir);
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, "config");
  assert.match(r.error.message, /^cannot read config\.json: .*EISDIR/);
  if (isRoot) return;
  const locked = join(dir, "config-000.json");
  writeFileSync(locked, '{"odev":"odev"}');
  chmodSync(locked, 0o000);
  const l = await loadConfig(read, locked);
  chmodSync(locked, 0o644);
  assert.equal(l.ok, false);
  assert.match(l.error.message, /^cannot read config\.json: .*EACCES/);
});

test("config: a missing path passes the parser and fails at the first run as a spawn error", async () => {
  const cfg = parseOdevConfig('{"odev":"/no/such/dir/odev"}');
  assert.equal(cfg.ok, true);
  const r = await createOdev({ exec: nodeExec, path: cfg.value }).which("/tmp");
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, "spawn");
  assert.match(r.error.message, /ENOENT/);
});

test("config: a file that is not executable (mode 644) fails at the first run as a spawn error", async () => {
  const file = join(dir, "odev-644");
  writeFileSync(file, "#!/bin/sh\necho '[]'\n");
  chmodSync(file, 0o644);
  const cfg = parseOdevConfig(json({ odev: file }));
  assert.equal(cfg.ok, true);
  const r = await createOdev({ exec: nodeExec, path: cfg.value }).list({ verdict: V });
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, "spawn");
  assert.match(r.error.message, /EACCES/);
});

const STUB = `#!/bin/sh
case "$*" in
  *"project which"*) printf '{"kind":"onedev","host":"http://h:1","project":"a/b","projectId":3}\\n' ;;
  *"issue list"*) echo "Note: showing 1 of 1 issues" >&2
                  printf '[{"number":4,"title":"real child","state":"Open","updated":"2026-01-01T00:00:00.000Z"}]' ;;
  *"issue view"*) printf '[{"issue":{"number":4,"title":"real child","state":"Open"}},{"ref":"a/b#9","error":"issue #9 not found in a/b"}]'
                  echo "odev: 1 of 2 refs failed" >&2; exit 1 ;;
  *"config view"*) printf '{"aliases":{"git.example":"http://h:1"}}' ;;
  *) echo "odev: unknown command" >&2; exit 2 ;;
esac
`;

test("real child: a stub odev answers every call through a child_process exec", async () => {
  const stub = join(dir, "odev-stub");
  writeExecutable(stub, STUB);
  const odev = createOdev({ exec: nodeExec, path: stub });
  const w = await odev.which("/tmp");
  assert.equal(w.value.projectId, 3);
  const p = w.value;
  const l = await odev.list({ verdict: p, since: Date.now() - 86_400_000 });
  assert.deepEqual(l.value.map((r) => r.title), ["real child"]);
  const v = await odev.lookup(p, [4, 9]);
  assert.deepEqual([v.value.get(4).title, v.value.get(9)], ["real child", null]);
  assert.deepEqual((await odev.spellings(p)).value, ["h:1", "git.example"]);
});

test("real child: noise before the JSON and a failing exit with stderr are rejected", async () => {
  const noisy = join(dir, "odev-noisy");
  writeExecutable(noisy, "#!/bin/sh\necho 'mise installing node'\necho '[]'\n");
  const a = await createOdev({ exec: nodeExec, path: noisy }).list({ verdict: V });
  assert.equal(a.error.kind, "shape");
  const failing = join(dir, "odev-failing");
  writeExecutable(failing, "#!/bin/sh\necho 'odev: host down' >&2\nexit 1\n");
  const b = await createOdev({ exec: nodeExec, path: failing }).list({ verdict: V });
  assert.deepEqual([b.error.kind, b.error.message, b.error.code], ["exit", "odev: host down", 1]);
});

test("utf8Length matches the encoded size for ASCII, 2, 3 and 4 byte characters and lone surrogates", () => {
  for (const s of ["", "abc", "\u00e9", "\u20ac", "\u{1f600}", "a\u00e9\u20ac\u{1f600}", "\ud800", "\udc00x", "\ud800\ud800\udc00"]) {
    assert.equal(utf8Length(s), Buffer.byteLength(s), JSON.stringify(s));
  }
});
