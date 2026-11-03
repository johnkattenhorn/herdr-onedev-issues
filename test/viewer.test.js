import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { actorName, ago, copyTexts, groupTimeline, initials, stateColorKey } from "../issue-model.js";
import { createOdev, parseIssueView, parseTimeline } from "../odev.js";
import { fakeExec, reply, verdict } from "./helpers.js";

const john = { id: 4, login: "john", fullName: "John" };
const system = { id: -1, login: "OneDev", fullName: "OneDev" };
const field = (name, v) => ({ name, type: "Enumeration", values: [v] });
const fieldChange = (id, date, actor, name, from, to) => ({
  kind: "change", id, date, actor, type: "IssueFieldChangeData",
  data: { oldFields: { [name]: field(name, from) }, newFields: { [name]: field(name, to) } },
});
const state = (id, date, actor, from, to) => ({ kind: "change", id, date, actor, type: "IssueStateChangeData", data: { oldState: from, newState: to } });
const comment = (id, date, actor, body) => ({ kind: "comment", id, date, actor, body });

test("timeline: one actor's field changes within a minute become one line", () => {
  const items = parseTimeline([
    fieldChange(1, "2026-11-03T10:00:00Z", john, "Priority", "Normal", "Major"),
    fieldChange(2, "2026-11-03T10:00:40Z", john, "Type", "Bug", "Task"),
    fieldChange(3, "2026-11-03T10:01:20Z", john, "Priority", "Major", "Critical"),
  ]).value;
  const out = groupTimeline(items);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].changes, [
    { name: "Priority", from: "Normal", to: "Critical" },
    { name: "Type", from: "Bug", to: "Task" },
  ]);
});

test("timeline: another actor, a gap over a minute, or a comment between keeps lines apart", () => {
  const split = (b) => groupTimeline(parseTimeline([fieldChange(1, "2026-11-03T10:00:00Z", john, "Priority", "A", "B"), b]).value).length;
  assert.equal(split(fieldChange(2, "2026-11-03T10:00:10Z", system, "Type", "A", "B")), 2);
  assert.equal(split(fieldChange(2, "2026-11-03T10:02:00Z", john, "Type", "A", "B")), 2);
  assert.equal(split(comment(2, "2026-11-03T10:00:05Z", john, "hi")), 2);
});

test("timeline: a change and its reversal cancel out, and an empty field change is dropped", () => {
  const out = groupTimeline(parseTimeline([
    fieldChange(1, "2026-11-03T10:00:00Z", john, "Priority", "A", "B"),
    fieldChange(2, "2026-11-03T10:00:10Z", john, "Priority", "B", "A"),
    { kind: "change", id: 3, date: "2026-11-03T11:00:00Z", actor: john, type: "IssueFieldChangeData", data: {} },
  ]).value);
  assert.deepEqual(out, []);
});

test("timeline: items sort oldest first, then change, comment, link; an item without a date is last", () => {
  const out = groupTimeline(parseTimeline([
    { kind: "link", id: 9, date: null, actor: null, direction: "outward", ref: "p#2", project: "p", number: 2, title: "t", state: "Open" },
    comment(5, "2026-11-03T10:00:00Z", john, "c"),
    state(6, "2026-11-03T10:00:00Z", system, "Open", "Closed"),
    comment(4, "2026-11-02T10:00:00Z", john, "first"),
    comment(8, null, john, "undated"),
  ]).value);
  assert.deepEqual(out.map((e) => `${e.kind}${e.id}`), ["comment4", "state6", "comment5", "comment8", "link9"]);
});

test("timeline: #79 from odev gives comment, state, note, comment, state with OneDev as the actor", () => {
  const raw = JSON.parse(readFileSync(new URL("fixtures/timeline-79.json", import.meta.url), "utf8"));
  const out = groupTimeline(parseTimeline(raw).value);
  assert.deepEqual(out.map((e) => e.kind), ["comment", "state", "note", "comment", "state"]);
  assert.equal(actorName(out[0].actor), "OneDev");
  assert.deepEqual([out[1].from, out[1].to], ["Open", "In Review"]);
});

test("timeline: an unknown kind, an unknown change type, a null actor and a year-9999 date all survive", () => {
  const out = groupTimeline(parseTimeline([
    { kind: "reaction", id: 1, date: "2026-11-03T10:00:00Z", actor: null },
    { kind: "change", id: 2, date: "9999-12-31T23:59:59Z", actor: null, type: "IssueSomethingNewData", data: { x: 1 } },
    { kind: "change", id: 3, date: "not a date", actor: john, type: null },
    42, null, "x",
  ]).value);
  assert.equal(out.length, 3);
  assert.match(out[0].text, /reaction/);
  assert.equal(actorName(out[0].actor), "unknown");
  assert.equal(out[1].text, "made a change: something new");
  assert.equal(ago("9999-12-31T23:59:59Z", Date.parse("2026-11-03T10:00:00Z")), "9999-12-31");
  assert.equal(ago("nope", 0), "at an unknown time");
});

test("timeline: a 5000-item list is capped at 2000 and the rest counts as skipped", () => {
  const raw = Array.from({ length: 5000 }, (_, i) => comment(i + 1, "2026-11-03T10:00:00Z", john, "x"));
  const r = parseTimeline(raw);
  assert.equal(r.value.length, 2000);
  assert.equal(r.skipped, 3000);
});

test("copy: the four entries give link, reference, number, and number with title", () => {
  const texts = copyTexts({ host: "http://h:6610/", project: "team/app", number: 79, title: "issue changes:\n rows are  not sorted" });
  assert.deepEqual(texts.map((t) => t.label), ["Copy link", "Copy reference", "Copy number", "Copy number and title"]);
  assert.deepEqual(texts.map((t) => t.text), [
    "http://h:6610/team/app/~issues/79", "team/app#79", "#79", "#79 issue changes: rows are not sorted",
  ]);
  assert.equal(copyTexts({ host: "http://h", project: "p", number: 1, title: "  " })[3].text, "#1");
});

test("names: initials, actor names and the state colour", () => {
  assert.equal(initials("Jane Doe"), "JD");
  assert.equal(initials("odev-bot"), "OB");
  assert.equal(initials(""), "?");
  assert.equal(actorName({ id: null, login: null, fullName: "Full Name" }), "Full Name");
  assert.equal(actorName(null), "unknown");
  assert.equal(stateColorKey(0, "Open"), "ansi2");
  assert.equal(stateColorKey(1, "Closed"), "ansi5");
  assert.equal(stateColorKey(null, "Closed"), "ansi5");
  assert.equal(stateColorKey(-7, "x"), "ansi1");
});

const viewJson = (over = {}) => ({
  issue: { id: 1, number: 79, title: "T", state: "Closed", updated: "2026-11-03T14:01:33.626Z", description: "body", confidential: false },
  fields: { Priority: "Normal", Assignees: null, Tags: ["a", "b"] },
  comments: [],
  pulls: [{ number: 104, title: "fix", state: "MERGED", project: "team/app" }],
  submitter: { id: 4, login: "john", fullName: "John" },
  ...over,
});

test("parse: issue view gives the issue, fields, pulls and submitter", () => {
  const v = parseIssueView(viewJson());
  assert.equal(v.issue.number, 79);
  assert.equal(v.issue.description, "body");
  assert.deepEqual(v.fields, { Priority: "Normal", Assignees: null, Tags: ["a", "b"] });
  assert.deepEqual(v.pulls, [{ number: 104, title: "fix", state: "MERGED", project: "team/app" }]);
  assert.deepEqual(v.submitter, { id: 4, login: "john", fullName: "John" });
});

test("parse: pulls null, submitter null, wrong-typed fields and a missing description do not fail the view", () => {
  const v = parseIssueView(viewJson({ pulls: null, submitter: null, fields: { A: 5, B: ["x", 1], C: "ok" }, issue: { number: 3, title: "t", state: "Open" } }));
  assert.equal(v.pulls, null);
  assert.equal(v.submitter, null);
  assert.deepEqual(v.fields, { C: "ok" });
  assert.equal(v.issue.description, "");
  assert.deepEqual(parseIssueView(viewJson({ pulls: [null, { number: "x" }, { number: 5, state: "OPEN" }] })).pulls, [{ number: 5, title: "", state: "OPEN", project: null }]);
  assert.equal(parseIssueView(viewJson({ fields: "nope" })).fields, null);
});

test("parse: a view of the wrong shape is null", () => {
  for (const bad of [null, [], "x", {}, { issue: null }, { issue: { number: 0, title: "t", state: "Open" } }, { issue: { number: 1, title: 5, state: "Open" } }, { issue: { number: 1, title: "t", state: "" } }]) {
    assert.equal(parseIssueView(bad), null, JSON.stringify(bad));
  }
  assert.equal(parseTimeline({}), null);
});

test("odev: issue and timeline build the argv with host and project, and a failing odev gives an error result", async () => {
  const exec = fakeExec((args) => (args[1] === "view" ? reply(JSON.stringify(viewJson())) : reply("", 1, "odev: boom\n")));
  const odev = createOdev({ exec, path: "odev" });
  const v = await odev.issue(verdict(), 79);
  assert.equal(v.ok, true);
  assert.deepEqual(exec.calls[0].args, ["issue", "view", "79", "--json", "--host", "http://192.0.2.30:6610", "--project", "team/app"]);
  const t = await odev.timeline(verdict({ project: "other/proj" }), 5);
  assert.equal(t.ok, false);
  assert.equal(t.error.message, "odev: boom");
  assert.deepEqual(exec.calls[1].args, ["issue", "timeline", "5", "--json", "--host", "http://192.0.2.30:6610", "--project", "other/proj"]);
  assert.equal((await odev.issue(verdict(), 0)).ok, false);
  assert.equal((await odev.issue(verdict(), -1)).ok, false);
});

test("odev: output that is not JSON, or an exec that rejects, is an error result and never a throw", async () => {
  const bad = createOdev({ exec: fakeExec(() => reply("<html>", 0)), path: "odev" });
  assert.equal((await bad.issue(verdict(), 1)).ok, false);
  const gone = createOdev({ exec: async () => { throw new Error("ENOENT"); }, path: "odev" });
  const r = await gone.timeline(verdict(), 1);
  assert.equal(r.ok, false);
  assert.match(r.error.message, /ENOENT/);
});
