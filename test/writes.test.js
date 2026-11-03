import assert from "node:assert/strict";
import { test } from "node:test";
import { createOdev } from "../odev.js";
import { CHANGED, assigneesAfter, changeRecord, createDrafts, createWriter, parseChange, postsOnSubmit, shortcutBody } from "../writes.js";
import { fakeExec, reply, verdict } from "./helpers.js";

const TARGET = ["--host", "http://192.0.2.30:6610", "--project", "team/app"];
const ok = () => reply(JSON.stringify({ number: 5 }));
const odevWith = (answer) => {
  const exec = fakeExec(answer);
  return { exec, odev: createOdev({ exec, path: "odev" }) };
};

test("comment: the body is one --body=<text> word, with a leading dash or an option inside it", async () => {
  const { exec, odev } = odevWith(ok);
  for (const body of ["-x", "--state Closed", "--body=evil -F Priority=Critical", "a\nb $(rm -rf /) `x` ; &"]) {
    const r = await odev.comment(verdict(), 5, body);
    assert.equal(r.ok, true);
  }
  assert.deepEqual(exec.calls.map((c) => c.args), [
    ["issue", "comment", "5", "--body=-x", "--json", ...TARGET],
    ["issue", "comment", "5", "--body=--state Closed", "--json", ...TARGET],
    ["issue", "comment", "5", "--body=--body=evil -F Priority=Critical", "--json", ...TARGET],
    ["issue", "comment", "5", "--body=a\nb $(rm -rf /) `x` ; &", "--json", ...TARGET],
  ]);
});

test("transition: the state and the comment are each one word; no comment sends no --comment", async () => {
  const { exec, odev } = odevWith(ok);
  await odev.transition(verdict(), 5, "In Progress", "--state Closed");
  await odev.transition(verdict(), 5, "Écrit ✓", "   ");
  assert.deepEqual(exec.calls[0].args, ["issue", "transition", "5", "--state=In Progress", "--comment=--state Closed", "--json", ...TARGET]);
  assert.deepEqual(exec.calls[1].args, ["issue", "transition", "5", "--state=Écrit ✓", "--json", ...TARGET]);
});

test("setField: NAME=VALUE is one word, a value may hold = and newlines; no values clears the field", async () => {
  const { exec, odev } = odevWith(ok);
  await odev.setField(verdict(), 5, "Priority", ["a=b\n\"c\""]);
  await odev.setField(verdict(), 5, "Assignees", ["a", "b"]);
  await odev.setField(verdict(), 5, "Assignees", []);
  assert.deepEqual(exec.calls.map((c) => c.args.slice(3, -5)), [
    ['--field=Priority=a=b\n"c"'],
    ["--field=Assignees=a", "--field=Assignees=b"],
    ["--field=Assignees="],
  ]);
});

test("refused before odev runs: empty or blank comment, NUL, too long, bad field name", async () => {
  const { exec, odev } = odevWith(ok);
  const refusals = [
    await odev.comment(verdict(), 5, ""),
    await odev.comment(verdict(), 5, " \n\t "),
    await odev.comment(verdict(), 5, "a\0b"),
    await odev.comment(verdict(), 5, "x".repeat(100_001)),
    await odev.transition(verdict(), 5, "", ""),
    await odev.transition(verdict(), 5, "Closed", "a\0"),
    await odev.setField(verdict(), 5, "A=B", ["x"]),
    await odev.setField(verdict(), 5, "Priority", ["x".repeat(4097)]),
    await odev.comment(verdict(), 0, "hi"),
  ];
  for (const r of refusals) assert.equal(r.ok, false);
  assert.match(refusals[0].error.message, /empty/);
  assert.match(refusals[2].error.message, /NUL/);
  assert.match(refusals[3].error.message, /longer/);
  assert.equal(exec.calls.length, 0);
});

test("a comment of 4 bytes per character is measured in bytes, not characters", async () => {
  const { odev } = odevWith(ok);
  assert.equal((await odev.comment(verdict(), 5, "😀".repeat(25_000))).ok, true);
  assert.equal((await odev.comment(verdict(), 5, "😀".repeat(25_001))).ok, false);
});

test("failure: a non-zero exit gives the stderr line, bad JSON on exit 0 is a shape error, a spawn failure is an error", async () => {
  const bad = await createOdev({ exec: fakeExec(() => reply("", 1, "odev: stub failure: server said no\nmore")), path: "odev" }).comment(verdict(), 5, "hi");
  assert.deepEqual([bad.ok, bad.error.kind, bad.error.message], [false, "exit", "odev: stub failure: server said no"]);
  const text = await createOdev({ exec: fakeExec(() => reply("created", 0)), path: "odev" }).comment(verdict(), 5, "hi");
  assert.deepEqual([text.ok, text.error.kind], [false, "shape"]);
  const array = await createOdev({ exec: fakeExec(() => reply("[]", 0)), path: "odev" }).comment(verdict(), 5, "hi");
  assert.equal(array.ok, false);
  const gone = await createOdev({ exec: async () => { throw new Error("ENOENT"); }, path: "odev" }).comment(verdict(), 5, "hi");
  assert.deepEqual([gone.ok, gone.error.kind], [false, "spawn"]);
});

test("states, fields and login parse odev's JSON and drop malformed entries", async () => {
  const { odev } = odevWith((args) => {
    if (args[1] === "states") return reply(JSON.stringify({ states: [{ name: "Open", ordinal: 0, closed: null }, { name: 3 }, { name: "" }, null, { name: "Closed", ordinal: 3, closed: true }] }));
    if (args[1] === "fields") return reply(JSON.stringify({ fields: [{ name: "Priority", type: "Enumeration", multiple: null, choices: ["Normal", 4, "Major"] }, { type: "x" }] }));
    return reply(JSON.stringify({ loginName: "john", token: "never read" }));
  });
  assert.deepEqual((await odev.states(verdict())).value, [{ name: "Open", ordinal: 0, closed: null }, { name: "Closed", ordinal: 3, closed: true }]);
  assert.deepEqual((await odev.fields(verdict())).value, [{ name: "Priority", type: "Enumeration", multiple: null, choices: ["Normal", "Major"] }]);
  assert.equal((await odev.login(verdict())).value, "john");
  const noLogin = await createOdev({ exec: fakeExec(() => reply(JSON.stringify({ loginName: 3 }))), path: "odev" }).login(verdict());
  assert.equal(noLogin.ok, false);
});

test("assigneesAfter: assign keeps the others, unassign removes only that login", () => {
  assert.deepEqual(assigneesAfter([], "john", "assign"), ["john"]);
  assert.deepEqual(assigneesAfter(["amy"], "john", "assign"), ["amy", "john"]);
  assert.deepEqual(assigneesAfter(["john", "amy"], "john", "assign"), ["amy", "john"]);
  assert.deepEqual(assigneesAfter(["amy", "john"], "john", "unassign"), ["amy"]);
  assert.deepEqual(assigneesAfter(["john"], "john", "unassign"), []);
  assert.deepEqual(assigneesAfter(["amy"], "john", "unassign"), ["amy"]);
});

test("changed record: {project, number, at}; parseChange refuses anything else", () => {
  assert.equal(CHANGED, "onedev-issues.changed");
  assert.deepEqual(changeRecord("p/q", 5, 99), { project: "p/q", number: 5, at: 99 });
  assert.deepEqual(parseChange({ project: "p/q", number: 5, at: 99, extra: 1 }), { project: "p/q", number: 5, at: 99 });
  for (const x of [null, undefined, [], "x", 3, {}, { project: "", number: 5, at: 1 }, { project: "p", number: 0, at: 1 }, { project: "p", number: 1.5, at: 1 }, { project: "p", number: 5, at: "1" }, { project: "p", number: 5, at: NaN }]) {
    assert.equal(parseChange(x), null);
  }
});

test("writer: a good write publishes the change record; a failed write does not and returns the message", async () => {
  const published = [];
  let code = 0;
  const { odev } = odevWith(() => (code === 0 ? ok() : reply("", 1, "odev: nope")));
  const w = createWriter({ odev, publish: (r) => published.push(r), now: () => 1234 });
  assert.deepEqual(await w.submit(verdict(), 5, { kind: "comment", body: "hi" }), { ok: true });
  assert.deepEqual(published, [{ project: "team/app", number: 5, at: 1234 }]);
  code = 1;
  assert.deepEqual(await w.submit(verdict(), 5, { kind: "comment", body: "hi" }), { ok: false, message: "odev: nope" });
  assert.equal(published.length, 1);
  assert.equal(w.busy(), false);
});

test("writer: a second write while one runs does nothing", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { exec, odev } = odevWith(async () => { await gate; return ok(); });
  const w = createWriter({ odev, publish: () => {}, now: () => 1 });
  const first = w.submit(verdict(), 5, { kind: "comment", body: "one" });
  assert.equal(w.busy(), true);
  assert.equal(await w.submit(verdict(), 5, { kind: "comment", body: "two" }), null);
  release();
  assert.deepEqual(await first, { ok: true });
  assert.equal(exec.calls.length, 1);
  assert.equal(w.busy(), false);
  assert.deepEqual(await w.submit(verdict(), 5, { kind: "comment", body: "three" }), { ok: true });
});

test("writer: assign and unassign send John's login with the others, read once from auth status", async () => {
  const { exec, odev } = odevWith((args) => (args[0] === "auth" ? reply(JSON.stringify({ loginName: "john" })) : ok()));
  const w = createWriter({ odev, publish: () => {}, now: () => 1 });
  await w.submit(verdict(), 5, { kind: "assign", current: ["amy"] });
  await w.submit(verdict(), 5, { kind: "unassign", current: ["amy", "john"] });
  await w.submit(verdict(), 5, { kind: "unassign", current: ["john"] });
  const edits = exec.calls.filter((c) => c.args[1] === "edit").map((c) => c.args.slice(3, -5));
  assert.deepEqual(edits, [["--field=Assignees=amy", "--field=Assignees=john"], ["--field=Assignees=amy"], ["--field=Assignees="]]);
  assert.equal(exec.calls.filter((c) => c.args[0] === "auth").length, 1);
});

test("writer: an auth failure or a thrown publish is a message, never a throw, and frees the lock", async () => {
  const { odev } = odevWith((args) => (args[0] === "auth" ? reply("", 1, "odev: not signed in") : ok()));
  const w = createWriter({ odev, publish: () => { throw new Error("shared broke"); }, now: () => 1 });
  assert.deepEqual(await w.submit(verdict(), 5, { kind: "assign", current: [] }), { ok: false, message: "odev: not signed in" });
  assert.deepEqual(await w.submit(verdict(), 5, { kind: "comment", body: "x" }), { ok: false, message: "shared broke" });
  assert.equal(w.busy(), false);
});

test("shortcutBody: drops the one newline that Ctrl+Enter typed, and nothing else", () => {
  assert.equal(shortcutBody("hi\n"), "hi");
  assert.equal(shortcutBody("hi\r\n"), "hi");
  assert.equal(shortcutBody("hi\n\n"), "hi\n");
  assert.equal(shortcutBody("hi "), "hi ");
  assert.equal(shortcutBody("\n"), "");
  assert.equal(shortcutBody("a\nb"), "a\nb");
});

test("postsOnSubmit: Enter and Shift+Enter type a newline; only Ctrl+Enter (secondary) posts", () => {
  assert.equal(postsOnSubmit({}), false);
  assert.equal(postsOnSubmit({ secondary: false }), false);
  assert.equal(postsOnSubmit({ shift: true }), false);
  assert.equal(postsOnSubmit({ secondary: false, shift: true }), false);
  assert.equal(postsOnSubmit({ secondary: true }), true);
});

test("drafts: text typed on one issue does not follow a link or Back to another, and Back restores it", () => {
  const d = createDrafts();
  const A = "team/app-sandbox#418", B = "team/app-sandbox#419", C = "team/app#418";
  assert.equal(d.move(A, "draft for A", B), "", "the box on B starts empty");
  assert.equal(d.move(B, "", C), "", "same number in another project is another issue");
  assert.equal(d.move(C, "draft for C", B), "");
  assert.equal(d.move(B, "draft for B", A), "draft for A", "Back to A restores A's draft");
  assert.equal(d.move(A, "", B), "draft for B");
  assert.equal(d.move(B, "draft for B", A), "", "an emptied box leaves no draft behind");
  assert.equal(d.move(A, "", C), "draft for C");
});

test("drafts: a write clears only the text it posted", () => {
  const d = createDrafts();
  const A = "p#1", B = "p#2";
  assert.equal(d.posted(A, "hello", A, "hello"), "", "posted text on the open issue clears the box");
  assert.equal(d.posted(A, "hello", A, "hello and more"), "hello and more", "text typed while the write ran stays");
  d.move(A, "hello", B);
  assert.equal(d.posted(A, "hello", B, "on B"), "on B", "B's box is never touched by A's write");
  assert.equal(d.move(B, "on B", A), "", "A's posted draft is gone");
  d.move(A, "edited during the write", B);
  d.posted(A, "hello", B, "");
  assert.equal(d.move(B, "", A), "edited during the write", "a draft changed after it was sent is kept");
});
