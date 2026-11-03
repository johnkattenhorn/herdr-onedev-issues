// @ts-check

/** @typedef {{ code: boolean, text: string }} Part */
/** @typedef {{ text: string } | { image: string | null, alt: string }} Block */
/** @typedef {{ host: string, project: string }} Target */

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const INLINE_CODE = /(``[^\n]*?``|`[^`\n]*`)/;
const IMAGE = /\[?!\[([^\]\n]*)\]\(\s*<?((?:[^()\s>]|\([^()\s]*\))+)>?(?:\s+"[^"\n]*")?\s*\)(?:\]\([^)\n]*\))?|<img\b([^>\n]*)>/g;
const REF = /(^|[\s(])((?:pull\s+request|pull|pr)\s+)?(?:([\w.-]+(?:\/[\w.-]+)+))?#(\d{1,9})(?![\w#])/gi;
const INDENTED = /^(?: {4}| {0,3}\t)/;
const BLANK = /^[ \t]*\n?$/;
const LIST_ITEM = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]|\n|$)/;
const HEADING = /^ {0,3}#{1,6}(?:[ \t]|\n|$)/;
const AUTOLINK = /<(https?:\/\/[^\s<>]+)>/g;

/**
 * Splits markdown into code (fenced blocks, indented blocks, inline spans) and
 * prose. A fence with no closing line runs to the end, as CommonMark reads it.
 * An indented block cannot continue a paragraph, and in a list it is taken as
 * the item's text.
 * @param {string} text @returns {Part[]}
 */
export function splitCode(text) {
  /** @type {Part[]} */
  const parts = [];
  /** @type {string[]} */
  let prose = [];
  /** @type {string[]} */
  let fence = [];
  /** @type {string | null} */
  let open = null;
  const flushProse = () => {
    if (prose.length === 0) return;
    for (const [i, piece] of prose.join("").split(INLINE_CODE).entries()) {
      if (piece !== "") parts.push({ code: i % 2 === 1, text: piece });
    }
    prose = [];
  };
  /** @type {string[]} */
  let indented = [];
  let paragraph = false;
  let list = false;
  let afterBlank = true;
  const flushIndented = () => {
    let end = indented.length;
    while (BLANK.test(indented[end - 1])) end--;
    parts.push({ code: true, text: indented.slice(0, end).join("") });
    prose = indented.slice(end);
    afterBlank = prose.length > 0;
    indented = [];
  };
  for (const line of text.match(/[^\n]*\n|[^\n]+/g) ?? []) {
    if (indented.length > 0) {
      if (BLANK.test(line) || INDENTED.test(line)) {
        indented.push(line);
        continue;
      }
      flushIndented();
    }
    if (open === null) {
      const blank = BLANK.test(line);
      const m = FENCE.exec(line);
      if (m) {
        flushProse();
        open = m[1];
        fence = [line];
      } else if (!blank && !paragraph && !list && INDENTED.test(line)) {
        flushProse();
        indented = [line];
      } else prose.push(line);
      if (LIST_ITEM.test(line)) list = true;
      else if (afterBlank && !blank && !/^[ \t]/.test(line)) list = false;
      paragraph = !blank && !m && !HEADING.test(line) && indented.length === 0;
      afterBlank = blank;
      continue;
    }
    fence.push(line);
    const m = FENCE.exec(line);
    if (m && m[1][0] === open[0] && m[1].length >= open.length && line.slice(m[0].length).trim() === "") {
      parts.push({ code: true, text: fence.join("") });
      open = null;
      fence = [];
    }
  }
  if (indented.length > 0) flushIndented();
  if (open !== null) parts.push({ code: true, text: fence.join("") });
  flushProse();
  return parts;
}

/** The one form that reaches the browser: http or https, no spaces, and so never a leading dash. @param {unknown} url @returns {string | null} */
export function webUrl(url) {
  return typeof url === "string" && url.length <= 4096 && /^https?:\/\/[^\s\x00-\x1f\x7f]+$/i.test(url) ? url : null;
}

/** @param {string} host @param {string} project @param {number} number @returns {string} */
export function issueUrl(host, project, number) {
  return `${host.replace(/\/+$/, "")}/${project}/~issues/${number}`;
}

/** @param {string} host @param {string} project @param {number} number @returns {string} */
export function pullUrl(host, project, number) {
  return `${host.replace(/\/+$/, "")}/${project}/~pulls/${number}`;
}

/**
 * @param {string} url @param {string} host
 * @returns {{ project: string, number: number } | null}
 */
export function issueFromUrl(url, host) {
  const base = host.replace(/\/+$/, "").toLowerCase();
  if (typeof url !== "string" || !url.toLowerCase().startsWith(base + "/")) return null;
  const m = /^\/([\w.-]+(?:\/[\w.-]+)*)\/~issues\/(\d{1,9})(?:[/?#].*)?$/.exec(url.slice(base.length));
  const number = m ? Number(m[2]) : 0;
  return m && number > 0 ? { project: m[1], number } : null;
}

/** @param {string} s @returns {string} */
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Raw HTML is text: `<` becomes an entity, and `<https://x>` stays a link. @param {string} prose @returns {string} */
function escapeHtml(prose) {
  return prose.replace(AUTOLINK, "[$1]($1)").replace(/<(?!https?:\/\/)/g, "&lt;");
}

/**
 * @param {string} prose @param {Target} t @returns {string}
 */
function linkRefs(prose, t) {
  const bare = new RegExp(`(^|[\\s(])(${escapeRegExp(t.host.replace(/\/+$/, ""))}/[\\w./-]+/~issues/\\d{1,9})(?![\\w/])`, "gi");
  return prose
    .replace(bare, (_m, pre, url) => {
      const ref = issueFromUrl(url, t.host);
      return ref ? `${pre}[${ref.project === t.project ? "" : ref.project}#${ref.number}](${url})` : _m;
    })
    .replace(REF, (_m, pre, pull, other, number) => {
      const url = (pull ? pullUrl : issueUrl)(t.host, other ?? t.project, Number(number));
      return `${pre}${pull ?? ""}[${other ?? ""}#${number}](${url})`;
    });
}

/** @param {string} src @param {string} host @returns {string | null} */
function imageUrl(src, host) {
  if (/^https?:\/\//i.test(src)) return src;
  if (src.startsWith("/") && !src.startsWith("//")) return host.replace(/\/+$/, "") + src;
  return null;
}

/**
 * Prose becomes safe markdown with issue references as links, and each image
 * becomes a block of its own: Herdr's markdown view draws none.
 * @param {string} markdown @param {Target} t @returns {Block[]}
 */
export function toBlocks(markdown, t) {
  /** @type {Block[]} */
  const out = [];
  let buf = "";
  const flush = () => {
    if (buf.trim() !== "") out.push({ text: buf });
    buf = "";
  };
  const prose = (/** @type {string} */ s) => linkRefs(escapeHtml(s), t);
  for (const part of splitCode(markdown)) {
    if (part.code) {
      buf += part.text;
      continue;
    }
    let last = 0;
    IMAGE.lastIndex = 0;
    for (let m = IMAGE.exec(part.text); m !== null; m = IMAGE.exec(part.text)) {
      const attrs = m[3] ?? "";
      const src = m[2] ?? /\bsrc=["']([^"']+)["']/.exec(attrs)?.[1] ?? "";
      const alt = m[1] ?? /\balt=["']([^"']*)["']/.exec(attrs)?.[1] ?? "";
      buf += prose(part.text.slice(last, m.index));
      flush();
      out.push({ image: src === "" ? null : imageUrl(src, t.host), alt });
      last = m.index + m[0].length;
    }
    buf += prose(part.text.slice(last));
  }
  flush();
  return out;
}
