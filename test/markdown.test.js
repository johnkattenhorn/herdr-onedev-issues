import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { issueFromUrl, issueUrl, pullUrl, splitCode, toBlocks, webUrl } from "../mods/onedev-issues/markdown.js";

const fixture = (name) => readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");

const T = { host: "http://192.0.2.30:6610", project: "team/app" };
const link = (n, p = "team/app", label = "") => `[${label}#${n}](http://192.0.2.30:6610/${p}/~issues/${n})`;
const text = (md) => toBlocks(md, T).map((b) => b.text ?? `IMG(${b.image}|${b.alt})`).join("|");

test("links: #123 and project#123 outside code become issue links", () => {
  assert.equal(text("see #12 and other/proj#7."), `see ${link(12)} and ${link(7, "other/proj", "other/proj")}.`);
  assert.equal(text("(#5)"), `(${link(5)})`);
});

test("links: code spans and fenced blocks are left alone", () => {
  assert.equal(text("run `fix #3` now #4"), `run \`fix #3\` now ${link(4)}`);
  assert.equal(text("```\n#9\n```\n#10"), `\`\`\`\n#9\n\`\`\`\n${link(10)}`);
  assert.equal(text("~~~js\n#9\n~~~\n"), "~~~js\n#9\n~~~\n");
});

test("links: an unclosed fence is code to the end", () => {
  assert.equal(text("#1\n```\n#2\n#3"), `${link(1)}\n\`\`\`\n#2\n#3`);
  assert.deepEqual(splitCode("a\n```\nb"), [{ code: false, text: "a\n" }, { code: true, text: "```\nb" }]);
});

test("links: no link inside a word, a URL fragment, an existing link or a number run", () => {
  assert.equal(text("abc#12 http://x/y#13 [t](u#14) #12abc ##15"), "abc#12 http://x/y#13 [t](u#14) #12abc ##15");
  assert.equal(text("#1234567890"), "#1234567890");
});

test("links: pull request #N, pull #N and PR #N link to the pull, not the issue with that number", () => {
  const pull = (n, p = "team/app", label = "") => `[${label}#${n}](http://192.0.2.30:6610/${p}/~pulls/${n})`;
  const [onedev] = JSON.parse(fixture("timeline-42-pull.json"));
  assert.equal(text(onedev.body), `State changed as pull request ${pull(84)} is open`);
  assert.equal(text("see PR #3, Pull #4, PULL REQUEST #5 and pr other/proj#6"),
    `see PR ${pull(3)}, Pull ${pull(4)}, PULL REQUEST ${pull(5)} and pr ${pull(6, "other/proj", "other/proj")}`);
  assert.equal(text("(PR #7) and #8"), `(PR ${pull(7)}) and ${link(8)}`);
  assert.equal(text("APR #9 pulled #10 `PR #11`"), `APR ${link(9)} pulled ${link(10)} \`PR #11\``);
  assert.equal(pullUrl(T.host + "/", "team/app", 84), "http://192.0.2.30:6610/team/app/~pulls/84");
  assert.equal(issueFromUrl(pullUrl(T.host, "team/app", 84), T.host), null, "a pull link opens in the browser, not in the dialog");
});

test("code: an indented block after a blank line is code, neither escaped nor linked", () => {
  const body = fixture("description-21.md");
  const line = "    Proved: <test id> fails with <what you broke> and passes with it restored\n";
  assert.ok(body.includes(`:\n\n${line}\n`), "the fixture holds #21's indented block");
  assert.ok(text(body).includes(`:\n\n${line}\n`));
  assert.equal(text("#1\n\n    #2 <b>\n\n    \tx\n\n#3"), `${link(1)}\n\n    #2 <b>\n\n    \tx\n\n${link(3)}`);
  assert.equal(text("    <i> #4\nok #5"), `    <i> #4\nok ${link(5)}`);
  assert.equal(text("# Head\n    <i> #6"), "# Head\n    <i> #6");
  assert.deepEqual(splitCode("a\n\n    b\n\n\nc"), [{ code: false, text: "a\n\n" }, { code: true, text: "    b\n" }, { code: false, text: "\n\nc" }]);
});

test("code: an indented line that continues a paragraph or sits in a list item stays prose", () => {
  assert.equal(text("a\n    b<c #1"), `a\n    b&lt;c ${link(1)}`);
  assert.equal(text("- item\n\n    x<y #2"), `- item\n\n    x&lt;y ${link(2)}`);
  assert.equal(text("1. one\n   more\n\n    x<y"), "1. one\n   more\n\n    x&lt;y");
  assert.equal(text("- item\n\nafter\n\n    x<y"), "- item\n\nafter\n\n    x<y");
});

test("links: a bare issue URL becomes a link, and issueFromUrl reads it back", () => {
  const url = issueUrl(T.host, "team/app", 79);
  assert.equal(url, "http://192.0.2.30:6610/team/app/~issues/79");
  assert.equal(text(`see ${url}`), `see [#79](${url})`);
  assert.deepEqual(issueFromUrl(url, T.host), { project: "team/app", number: 79 });
  assert.deepEqual(issueFromUrl(`${url}#comment-3`, T.host), { project: "team/app", number: 79 });
  assert.equal(issueFromUrl("http://evil.example/team/app/~issues/79", T.host), null);
  assert.equal(issueFromUrl("javascript:alert(1)", T.host), null);
  assert.equal(issueFromUrl(`${T.host}/a/~issues/0`, T.host), null);
});

test("html: raw HTML and script are escaped to text, an autolink stays a link", () => {
  assert.equal(text("<script>alert(1)</script> <b>x</b>"), "&lt;script>alert(1)&lt;/script> &lt;b>x&lt;/b>");
  assert.equal(text("<https://a.example/x>"), "[https://a.example/x](https://a.example/x)");
  assert.equal(text("`<b>`"), "`<b>`");
});

test("images: markdown and html images are cut out as their own block", () => {
  assert.equal(text("a ![shot](https://x.example/a.png) b"), "a |IMG(https://x.example/a.png|shot)| b");
  assert.equal(text('<img src="https://x.example/b.png" alt="two" width="50">'), "IMG(https://x.example/b.png|two)");
  assert.equal(text("![r](/files/c.png)"), "IMG(http://192.0.2.30:6610/files/c.png|r)");
  assert.equal(text("[![b](https://x.example/d.png)](https://y.example)"), "IMG(https://x.example/d.png|b)");
});

test("images: an image inside code stays code; a file or javascript source has no url", () => {
  assert.equal(text("`![a](https://x.example/a.png)`"), "`![a](https://x.example/a.png)`");
  assert.equal(text("```\n![a](https://x.example/a.png)\n```"), "```\n![a](https://x.example/a.png)\n```");
  assert.equal(text("![a](file:///etc/passwd)"), "IMG(null|a)");
  assert.equal(text("![a](javascript:alert(1))"), "IMG(null|a)");
  assert.equal(text("![a](//evil.example/a.png)"), "IMG(null|a)");
});

test("hostile: a 1 MB body, 10 000 list levels, only zero-width characters and a 50 000 px image all finish fast", () => {
  const started = Date.now();
  assert.ok(text("word #1 ".repeat(130_000)).length > 1_000_000);
  assert.ok(text("  ".repeat(10_000) + "- deep").length > 0);
  assert.equal(text("​​"), "​​");
  assert.equal(text('<img src="https://x.example/e.png" width="50000" alt="wide">'), "IMG(https://x.example/e.png|wide)");
  assert.equal(text("```".repeat(50_000)).length > 0, true);
  assert.ok(Date.now() - started < 5000, "took too long");
});

test("webUrl: only http and https without spaces reach the browser; javascript, file, a leading dash and control characters do not", () => {
  assert.equal(webUrl("https://x.example/a?b=c#d"), "https://x.example/a?b=c#d");
  assert.equal(webUrl("HTTP://x.example"), "HTTP://x.example");
  for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "--help", "-o /tmp/x", "https://x.example/a b", 'https://x.example/"q"\n', "https://x\u0000.example", "ftp://x.example", "", null, 5, `https://${"a".repeat(5000)}`]) {
    assert.equal(webUrl(bad), null, String(bad).slice(0, 40));
  }
});
