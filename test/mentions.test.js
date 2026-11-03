import { test } from "node:test";
import assert from "node:assert/strict";
import { mentionScanner } from "../cache.js";
import { verdict } from "./helpers.js";

const V = verdict();
const AUTH = ["192.0.2.30:6610", "onedev.example.com"];
const scan = mentionScanner(V, AUTH);

test("order: the bottom line comes first and each line reads left to right", () => {
  assert.deepEqual(scan("#1\n#2 #3\n#4"), [4, 2, 3, 1]);
});

test("order: one line with a #, a project ref and a URL keeps screen order", () => {
  assert.deepEqual(scan("see #3 #7 http://onedev.example.com/team/app/~issues/5"), [3, 7, 5]);
  assert.deepEqual(scan("team/app#9 then #2 then https://192.0.2.30:6610/team/app/~issues/4"), [9, 2, 4]);
});

test("dedupe: a number seen twice counts once, at its first position", () => {
  assert.deepEqual(scan("#5 #6\n#5 #7 #6"), [5, 7, 6]);
});

test("limit: at most 8 numbers by default, and a custom limit is honoured", () => {
  const screen = Array.from({ length: 20 }, (_, i) => `#${i + 1}`).join("\n");
  assert.deepEqual(scan(screen), [20, 19, 18, 17, 16, 15, 14, 13]);
  assert.deepEqual(scan(screen, 3), [20, 19, 18]);
  assert.deepEqual(scan(screen, 0), []);
});

test("#N: a bare number sign form matches after space, bracket, quote and line start", () => {
  assert.deepEqual(scan("#1"), [1]);
  assert.deepEqual(scan("fixes (#2), \"#3\" [#4]: #5."), [2, 3, 4, 5]);
});

test("#N: leading zeros read as the number and #0 is not an issue", () => {
  assert.deepEqual(scan("#007 #0 #00"), [7]);
});

test("#N: glued to a word, a slash, an ampersand or another # is not a mention", () => {
  assert.deepEqual(scan("a#5 abc#6 &#35; x/#7 ##8 user/other#9"), []);
});

test("#N: followed by a word character or a hyphen is not a mention", () => {
  assert.deepEqual(scan("#12abc #13_x #14-fix #15"), [15]);
});

test("<project>#N: this project's ref matches and another project's ref does not", () => {
  assert.deepEqual(scan("team/app#12 other/proj#13 team/app2#14 xteam/app#15 my-team/app#16"), [12]);
});

test("URL: both host spellings, http and https, match", () => {
  const urls = [
    "http://192.0.2.30:6610/team/app/~issues/1",
    "https://192.0.2.30:6610/team/app/~issues/2",
    "http://onedev.example.com/team/app/~issues/3",
    "https://onedev.example.com/team/app/~issues/4",
  ];
  assert.deepEqual(scan(urls.join(" ")), [1, 2, 3, 4]);
});

test("URL: a scheme-less URL, a query string and a trailing slash still match", () => {
  assert.deepEqual(scan("onedev.example.com/team/app/~issues/5?x=1 and http://onedev.example.com/team/app/~issues/6/"), [5, 6]);
});

test("URL: another host, another project, a look-alike host and a longer path are not mentions", () => {
  const screen = [
    "http://github.com/team/app/~issues/1",
    "http://onedev.example.com/team/other/~issues/2",
    "http://evilonedev.example.com/team/app/~issues/3",
    "http://onedev.example.com.evil.com/team/app/~issues/4",
    "http://onedev.example.com/x/team/app/~issues/5",
    "http://onedev.example.com/team/app/issues/6",
    "http://user@onedev.example.com/team/app/~issues/7",
  ].join("\n");
  assert.deepEqual(scan(screen), []);
});

test("URL: a host that odev did not list is not a mention, and an empty list still finds # forms", () => {
  const bare = mentionScanner(V, []);
  assert.deepEqual(bare("http://onedev.example.com/team/app/~issues/5 #6 team/app#7"), [6, 7]);
  assert.deepEqual(mentionScanner(V, ["onedev.example.com"])("http://192.0.2.30:6610/team/app/~issues/8"), []);
});

test("project: regex characters and unicode in the project path are matched literally", () => {
  const dots = mentionScanner(verdict({ project: "a.b/c+d" }), ["h.example"]);
  assert.deepEqual(dots("a.b/c+d#1 aXb/c+d#2 http://h.example/a.b/c+d/~issues/3 http://hXexample/a.b/c+d/~issues/4"), [1, 3]);
  const uni = mentionScanner(verdict({ project: "домой/проект" }), []);
  assert.deepEqual(uni("домой/проект#5 #6"), [5, 6]);
});

test("number size: 1 to 9 digits count, longer runs do not", () => {
  assert.deepEqual(scan("#123456789"), [123456789]);
  assert.deepEqual(scan("#1234567890"), []);
});

test("hostile: a 30-digit number is not a mention, alone or inside a URL or project ref", () => {
  const big = "9".repeat(30);
  assert.deepEqual(scan(`#${big} team/app#${big} http://onedev.example.com/team/app/~issues/${big}`), []);
});

test("hostile: 300 lines of # find nothing and finish quickly", () => {
  const screen = Array.from({ length: 300 }, () => "#".repeat(200)).join("\n");
  const t0 = performance.now();
  assert.deepEqual(scan(screen), []);
  assert.ok(performance.now() - t0 < 200);
});

test("hostile: 300 lines of # with one mention at the top still find it", () => {
  const screen = ["see #42", ...Array.from({ length: 300 }, () => "#".repeat(100))].join("\n");
  assert.deepEqual(scan(screen), [42]);
});

test("hostile: one line of 10 000 numbers returns the first 8 in under 200 ms", () => {
  for (const line of [
    Array.from({ length: 10_000 }, (_, i) => `#${i + 1}`).join(" "),
    Array.from({ length: 10_000 }, (_, i) => `${i + 1}`).join(" "),
    Array.from({ length: 10_000 }, (_, i) => `team/app#${i + 1}`).join(" "),
  ]) {
    const t0 = performance.now();
    const found = scan(line);
    const ms = performance.now() - t0;
    assert.ok(ms < 200, `took ${ms} ms`);
    assert.ok(found.length <= 8);
  }
  const t0 = performance.now();
  assert.deepEqual(scan(Array.from({ length: 10_000 }, (_, i) => `#${i + 1}`).join(" ")), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(performance.now() - t0 < 200);
});

test("hostile: a line of 10 000 numbers with no # and a very long token are cheap", () => {
  const t0 = performance.now();
  assert.deepEqual(scan("#".repeat(1_000_000)), []);
  assert.deepEqual(scan("a".repeat(1_000_000) + " #5"), []);
  assert.deepEqual(scan("x#".repeat(500_000)), []);
  assert.ok(performance.now() - t0 < 200, `took ${performance.now() - t0} ms`);
});

test("hostile: a line over 4096 characters is cut at a token boundary, never inside a number", () => {
  const line = " ".repeat(4093) + "#12345";
  assert.deepEqual(scan(line), []);
  assert.deepEqual(scan("#7 " + " ".repeat(5000) + "#8"), [7]);
});

test("input: CRLF lines, empty input and a non-string are handled", () => {
  assert.deepEqual(scan("#1\r\n#2\r\n"), [2, 1]);
  assert.deepEqual(scan(""), []);
  assert.deepEqual(scan(undefined), []);
});

test("scanner: repeated calls give the same answer (the compiled regex keeps no state)", () => {
  const screen = "#1 #2\nhttp://onedev.example.com/team/app/~issues/3";
  assert.deepEqual(scan(screen), scan(screen));
});
