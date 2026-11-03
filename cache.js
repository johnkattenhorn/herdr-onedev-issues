// @ts-check

import { parseIssueRow, utf8Length } from "./odev.js";

/** @typedef {import("./odev.js").OnedevProject} OnedevProject */
/** @typedef {import("./odev.js").Verdict} Verdict */
/** @typedef {import("./odev.js").IssueRow} IssueRow */
/** @typedef {import("./odev.js").Known} Known */
/** @typedef {import("./odev.js").Odev} Odev */
/** @typedef {import("./odev.js").Exec} Exec */

/**
 * @typedef {{
 *   version: 1,
 *   host: string,
 *   project: string,
 *   issues: Record<string, IssueRow>,
 *   known: Record<string, Known | null>,
 *   mine: number[],
 *   synced: number,
 * }} Cache
 */

/**
 * @typedef {{
 *   probe(path: string): Promise<Probe>,
 *   readText(path: string): Promise<string>,
 *   writeText(path: string, text: string): Promise<void>,
 *   mkdirp(dir: string): Promise<void>,
 * }} CacheIO
 */

/** @typedef {{ kind: "absent" } | { kind: "file", bytes: number } | { kind: "symlink" | "directory" | "other" }} Probe */

/** @typedef {{ userSyncing: boolean, error: string | null, note: string | null }} StoreStatus */

/** @typedef {{ changed: boolean }} Changed */

/**
 * @typedef {{
 *   cache(): Readonly<Cache>,
 *   status(): StoreStatus,
 *   load(): Promise<Cache>,
 *   sync(opts?: { user?: boolean }): Promise<Changed>,
 *   resolve(numbers: number[]): Promise<Changed>,
 * }} ProjectStore
 */

/** @typedef {{ get(project: OnedevProject): ProjectStore }} Caches */

const VERSION = 1;
const RETRY_MISS_MS = 60_000;
const KNOWN_CAP = 200;
const FAILED_CAP = 200;
const MAX_ASK = 8;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;

/**
 * @param {{ io: CacheIO, odev: Odev, dir: string, now: () => number }} deps
 * @returns {Caches}
 */
export function createCaches({ io, odev, dir, now }) {
  /** @type {Map<string, ProjectStore>} */
  const stores = new Map();
  return {
    get(project) {
      const name = cacheFileName(project);
      let store = stores.get(name);
      if (!store) {
        store = createStore({ io, odev, dir, now, project, path: `${dir}/${name}` });
        stores.set(name, store);
      }
      return store;
    },
  };
}

/**
 * @param {{ io: CacheIO, odev: Odev, dir: string, now: () => number, project: OnedevProject, path: string }} d
 * @returns {ProjectStore}
 */
function createStore({ io, odev, dir, now, project, path }) {
  let state = emptyCache(project);
  /** @type {{ sync: string | null, save: string | null, lookup: string | null, blocked: string | null }} */
  const errors = { sync: null, save: null, lookup: null, blocked: null };
  /** @type {string | null} */
  let note = null;
  /** @type {Map<number, number>} */
  const failedAt = new Map();

  /** @param {number} n @param {number} at */
  function failed(n, at) {
    failedAt.delete(n);
    failedAt.set(n, at);
    if (failedAt.size > FAILED_CAP) failedAt.delete(failedAt.keys().next().value);
  }

  let tail = Promise.resolve();
  /** @param {() => Promise<Changed>} fn @returns {Promise<Changed>} */
  const enqueue = (fn) => {
    const done = tail.then(fn).catch((e) => {
      errors.sync = `internal error: ${errText(e)}`;
      return { changed: true };
    });
    tail = done.then(() => undefined);
    return done;
  };

  const loaded = (async () => {
    const r = await load(io, path, project);
    state = r.cache;
    note = r.note;
    errors.blocked = r.blocked;
    return state;
  })();
  tail = loaded.then(() => undefined, () => undefined);

  const errorText = () => errors.sync ?? errors.save ?? errors.lookup ?? errors.blocked;

  async function persist() {
    const r = await save(io, dir, path, state);
    errors.save = r.ok === false ? r.message : null;
    if (r.ok === true) errors.blocked = null;
  }

  /** @param {string} message @param {string | null} before @returns {Changed} */
  function syncFailed(message, before) {
    errors.sync = message;
    return { changed: errorText() !== before };
  }

  /** @type {{ user: boolean, promise: Promise<Changed> } | null} */
  let inflight = null;

  /** @param {boolean} user */
  function startSync(user) {
    /** @type {{ user: boolean, promise: Promise<Changed> }} */
    const entry = { user, promise: null };
    entry.promise = enqueue(async () => {
      try {
        const before = errorText();
        const [all, mine] = await Promise.all([
          odev.list({ verdict: project }),
          odev.list({ verdict: project, mine: true }),
        ]);
        if (all.ok === false) return syncFailed(all.error.message, before);
        if (mine.ok === false) return syncFailed(mine.error.message, before);
        errors.sync = null;
        const issues = rowsByNumber(all.value);
        const next = { ...state, issues, known: withoutKnown(state.known, issues), mine: unique(mine.value.map((r) => r.number)) };
        const rows = state.synced === 0 || !sameRows(next, state);
        if (rows) state = { ...next, synced: now() };
        if (rows || errors.save !== null || errors.blocked !== null) await persist();
        return { changed: rows || errorText() !== before };
      } finally {
        if (inflight === entry) inflight = null;
      }
    });
    inflight = entry;
    return entry.promise;
  }

  return {
    cache: () => state,
    load: () => loaded,
    status: () => ({ userSyncing: inflight?.user === true, error: errorText(), note }),
    sync(opts) {
      const user = opts?.user === true;
      if (inflight === null) return startSync(user);
      if (user) inflight.user = true;
      return inflight.promise;
    },
    resolve(numbers) {
      return enqueue(async () => {
        const before = errorText();
        const at = now();
        const ask = unique(/** @type {number[]} */ (Array.isArray(numbers) ? numbers : []))
          .filter((n) => Number.isSafeInteger(n) && n > 0)
          .filter((n) => !(String(n) in state.issues) && !(String(n) in state.known))
          .filter((n) => at - (failedAt.get(n) ?? -Infinity) >= RETRY_MISS_MS)
          .slice(0, MAX_ASK);
        if (ask.length === 0) return { changed: false };
        const r = await odev.lookup(project, ask);
        if (r.ok === false) {
          for (const n of ask) failed(n, at);
          errors.lookup = r.error.message;
          return { changed: errorText() !== before };
        }
        errors.lookup = null;
        const known = { ...state.known };
        /** @type {Set<string>} */
        const fresh = new Set();
        for (const n of ask) {
          const v = r.value.get(n);
          if (v === undefined) failed(n, at);
          else {
            known[String(n)] = v;
            fresh.add(String(n));
          }
        }
        if (fresh.size > 0) {
          state = { ...state, known: capKnown(known, fresh) };
          await persist();
        }
        return { changed: fresh.size > 0 || errorText() !== before };
      });
    },
  };
}

/** @param {Cache} a @param {Cache} b @returns {boolean} */
function sameRows(a, b) {
  return JSON.stringify(a.issues) === JSON.stringify(b.issues)
    && JSON.stringify(a.mine) === JSON.stringify(b.mine)
    && Object.keys(a.known).length === Object.keys(b.known).length;
}

/**
 * @param {Cache["known"]} known @param {Set<string>} [fresh]
 * @returns {Cache["known"]}
 */
function capKnown(known, fresh = new Set()) {
  const keys = Object.keys(known);
  if (keys.length <= KNOWN_CAP) return known;
  const rest = keys.filter((k) => !fresh.has(k)).sort((a, b) => Number(b) - Number(a));
  const keep = new Set([...fresh, ...rest].slice(0, KNOWN_CAP));
  return Object.fromEntries(Object.entries(known).filter(([k]) => keep.has(k)));
}

/** @param {IssueRow[]} rows @returns {Record<string, IssueRow>} */
function rowsByNumber(rows) {
  /** @type {Record<string, IssueRow>} */
  const out = {};
  for (const r of rows) if (!(String(r.number) in out)) out[String(r.number)] = r;
  return out;
}

function withoutKnown(/** @type {Cache["known"]} */ known, /** @type {Cache["issues"]} */ issues) {
  return Object.fromEntries(Object.entries(known).filter(([n]) => !(n in issues)));
}

/** @template T @param {T[]} xs @returns {T[]} */
function unique(xs) {
  return [...new Set(xs)];
}

/** @param {OnedevProject} p @returns {Cache} */
function emptyCache(p) {
  return { version: VERSION, host: p.host, project: p.project, issues: {}, known: {}, mine: [], synced: 0 };
}

/**
 * A name over 200 bytes keeps a 160-byte prefix plus a 32-bit FNV-1a hash of
 * the whole name, under ext4's 255-byte limit.
 * @param {OnedevProject} p @returns {string}
 */
export function cacheFileName(p) {
  const name = `project-${escapeName(p.host)}__${escapeName(p.project)}`;
  if (name.length <= 200) return `${name}.json`;
  return `${name.slice(0, 160)}-${fnv1a(name)}.json`;
}

/** @param {string} s @returns {string} */
function escapeName(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const cp = /** @type {number} */ (s.codePointAt(i));
    if (cp > 0xffff) i++;
    if (cp < 0x80 && /[A-Za-z0-9.-]/.test(s[i])) {
      out += s[i];
      continue;
    }
    for (const b of encodeCodePoint(cp)) out += "_" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

/** @param {number} cp @returns {number[]} */
function encodeCodePoint(cp) {
  if (cp < 0x80) return [cp];
  if (cp < 0x800) return [0xc0 | (cp >> 6), 0x80 | (cp & 63)];
  if (cp < 0x10000) return [0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63)];
  return [0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63)];
}

/** @param {string} s @returns {string} */
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * @param {CacheIO} io @param {string} path @param {OnedevProject} p
 * @returns {Promise<{ cache: Cache, note: string | null, blocked: string | null }>}
 */
async function load(io, path, p) {
  const empty = emptyCache(p);
  /** @type {Probe} */
  let probe;
  try {
    probe = await io.probe(path);
  } catch (e) {
    return { cache: empty, note: `cannot check cache file: ${errText(e)}`, blocked: null };
  }
  if (probe.kind === "absent") return { cache: empty, note: null, blocked: null };
  if (probe.kind !== "file") return { cache: empty, note: null, blocked: `cache path is ${describeKind(probe.kind)}: ${path}` };
  if (probe.bytes > MAX_CACHE_BYTES) return { cache: empty, note: "cache file is too large; refetched", blocked: null };
  /** @type {string} */
  let text;
  try {
    text = await io.readText(path);
  } catch (e) {
    return { cache: empty, note: `cannot read cache file: ${errText(e)}`, blocked: null };
  }
  if (utf8Length(text) > MAX_CACHE_BYTES) return { cache: empty, note: "cache file is too large; refetched", blocked: null };
  const parsed = parseCache(text, p);
  return parsed.ok === true
    ? { cache: parsed.cache, note: null, blocked: null }
    : { cache: empty, note: `${parsed.reason}; refetched`, blocked: null };
}

/** @param {"symlink" | "directory" | "other"} kind @returns {string} */
const describeKind = (kind) => (kind === "other" ? "not a regular file" : `a ${kind}`);

/**
 * Not atomic: the runtime fs has no rename.
 * @param {CacheIO} io @param {string} dir @param {string} path @param {Cache} cache
 * @returns {Promise<{ ok: true } | { ok: false, message: string }>}
 */
async function save(io, dir, path, cache) {
  try {
    const probe = await io.probe(path);
    if (probe.kind !== "absent" && probe.kind !== "file") return { ok: false, message: `cannot save cache: path is ${describeKind(probe.kind)}: ${path}` };
    const text = JSON.stringify(cache);
    const bytes = utf8Length(text);
    if (bytes > MAX_CACHE_BYTES) return { ok: false, message: `cannot save cache: ${bytes} bytes is over the ${MAX_CACHE_BYTES} limit` };
    await io.mkdirp(dir);
    await io.writeText(path, text);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: `cannot save cache: ${errText(e)}` };
  }
}

/**
 * @param {string} text @param {OnedevProject} p
 * @returns {{ ok: true, cache: Cache } | { ok: false, reason: string }}
 */
function parseCache(text, p) {
  /** @type {any} */
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return { ok: false, reason: "cache file was not JSON" };
  }
  if (typeof j !== "object" || j === null || Array.isArray(j)) return { ok: false, reason: "cache file was not an object" };
  if (j.version !== VERSION) return { ok: false, reason: "cache file has another version" };
  if (j.host !== p.host || j.project !== p.project) return { ok: false, reason: "cache file belongs to another project" };
  if (typeof j.issues !== "object" || j.issues === null || Array.isArray(j.issues)) return { ok: false, reason: "cache file has no issues object" };
  /** @type {Record<string, IssueRow>} */
  const issues = {};
  for (const [key, raw] of Object.entries(j.issues)) {
    const row = parseIssueRow(raw);
    if (!row || String(row.number) !== key) return { ok: false, reason: "cache file has a bad issue row" };
    issues[key] = row;
  }
  if (!Array.isArray(j.mine) || !j.mine.every((/** @type {any} */ n) => Number.isSafeInteger(n) && n > 0)) return { ok: false, reason: "cache file has a bad mine list" };
  if (typeof j.synced !== "number" || !Number.isFinite(j.synced) || j.synced < 0) return { ok: false, reason: "cache file has a bad time" };
  /** @type {Record<string, Known | null>} */
  const known = {};
  if (typeof j.known === "object" && j.known !== null && !Array.isArray(j.known)) {
    for (const [key, v] of Object.entries(j.known)) {
      if (!/^[1-9][0-9]{0,15}$/.test(key)) continue;
      if (v === null) known[key] = null;
      else if (typeof v === "object" && v.number === Number(key) && typeof v.title === "string" && typeof v.state === "string") {
        known[key] = { number: v.number, title: v.title, state: v.state };
      }
    }
  }
  return {
    ok: true,
    cache: { version: VERSION, host: p.host, project: p.project, issues, known: capKnown(known), mine: unique(j.mine), synced: j.synced },
  };
}

/**
 * The Herdr runtime's fs/promises has no stat or lstat, so probe runs a shell.
 * @param {{ exec: Exec, fs: {
 *   readFile(path: string, enc: "utf8"): Promise<string>,
 *   writeFile(path: string, text: string): Promise<unknown>,
 *   mkdir(path: string, opts: { recursive: true }): Promise<unknown>,
 * } }} deps
 * @returns {CacheIO}
 */
export function herdrIO({ exec, fs }) {
  const script =
    'if [ -L "$1" ]; then echo symlink; elif [ -d "$1" ]; then echo directory;' +
    ' elif [ -f "$1" ]; then echo file; wc -c < "$1"; elif [ -e "$1" ]; then echo other;' +
    " else echo absent; fi";
  return {
    async probe(path) {
      const r = await exec("sh", ["-c", script, "_", path]);
      if (r.code !== 0) throw new Error(`probe failed (${r.code}): ${r.stderr.trim().split("\n")[0]}`);
      const [kind, size] = r.stdout.trim().split(/\s*\n\s*/);
      if (kind === "absent" || kind === "symlink" || kind === "directory" || kind === "other") return { kind };
      const bytes = Number(size);
      if (kind === "file" && Number.isSafeInteger(bytes) && bytes >= 0) return { kind, bytes };
      throw new Error(`probe answered ${JSON.stringify(r.stdout.slice(0, 40))}`);
    },
    readText: (path) => fs.readFile(path, "utf8"),
    writeText: async (path, text) => {
      await fs.writeFile(path, text);
    },
    mkdirp: async (dir) => {
      await fs.mkdir(dir, { recursive: true });
    },
  };
}

/** @typedef {{ action: "keep" } | { action: "show", child: "onedev-issues" | "issues", project: OnedevProject | null }} View */

/**
 * @param {Verdict | null} verdict
 * @param {string[]} childIds
 * @param {OnedevProject | null} lastProject
 * @returns {View}
 */
export function chooseView(verdict, childIds, lastProject) {
  if (verdict?.kind === "onedev") return { action: "show", child: "onedev-issues", project: verdict };
  if (verdict?.kind !== "not-onedev") return { action: "keep" };
  if (Array.isArray(childIds) && childIds.includes("issues")) return { action: "show", child: "issues", project: lastProject };
  return { action: "show", child: "onedev-issues", project: lastProject };
}

const MAX_LINE = 4096;
const MENTION_LIMIT = 8;

/**
 * @param {OnedevProject} project
 * @param {string[]} authorities
 * @returns {(screen: string, limit?: number) => number[]}
 */
export function mentionScanner(project, authorities) {
  const auth = unique(authorities.filter((a) => typeof a === "string" && a !== "")).map(escapeRe);
  const proj = escapeRe(project.project);
  const urlForm = `(?:https?:\\/\\/|(?<![\\w.@-]))(?:${auth.join("|")})\\/${proj}\\/~issues\\/`;
  const projectRefForm = `(?<![\\w&/#.-])${proj}#`;
  const bareForm = "(?<![\\w&/#])#";
  const forms = [...(auth.length ? [urlForm] : []), projectRefForm, bareForm];
  const re = new RegExp(`(?:${forms.join("|")})(\\d{1,9})(?![\\w-])`, "g");
  return (screen, limit = MENTION_LIMIT) => {
    /** @type {number[]} */
    const found = [];
    if (typeof screen !== "string") return found;
    const lines = screen.split("\n");
    for (let i = lines.length - 1; i >= 0 && found.length < limit; i--) {
      for (const m of clip(lines[i]).matchAll(re)) {
        const n = Number(m[1]);
        if (n > 0 && !found.includes(n)) found.push(n);
        if (found.length >= limit) break;
      }
    }
    return found;
  };
}

/** @param {string} line @returns {string} */
function clip(line) {
  if (line.length <= MAX_LINE) return line;
  let end = MAX_LINE;
  while (end > 0 && /\S/.test(line[end]) && /\S/.test(line[end - 1])) end--;
  return line.slice(0, end);
}

/** @param {string} s @returns {string} */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

/**
 * @param {Cache} cache
 * @returns {{ name: string, ordinal: number | null, count: number }[]}
 */
export function stateTabs(cache) {
  /** @type {Map<string, { name: string, ordinal: number | null, count: number }>} */
  const tabs = new Map();
  for (const row of Object.values(cache.issues)) {
    const tab = tabs.get(row.state) ?? { name: row.state, ordinal: null, count: 0 };
    tab.count++;
    if (row.stateOrdinal !== null && (tab.ordinal === null || row.stateOrdinal < tab.ordinal)) tab.ordinal = row.stateOrdinal;
    tabs.set(row.state, tab);
  }
  return [...tabs.values()].sort((a, b) => {
    if (a.ordinal !== b.ordinal) return a.ordinal === null ? 1 : b.ordinal === null ? -1 : a.ordinal - b.ordinal;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

/** @param {string | null} s @returns {number} */
const time = (s) => {
  const t = s === null ? NaN : Date.parse(s);
  return Number.isNaN(t) ? -Infinity : t;
};
/** @param {number} a @param {number} b */
const byTimeDesc = (a, b) => (a === b ? 0 : a === -Infinity ? 1 : b === -Infinity ? -1 : b - a);
const byTimeAsc = (/** @type {number} */ a, /** @type {number} */ b) => (a === b ? 0 : a === -Infinity ? 1 : b === -Infinity ? -1 : a - b);

/**
 * Newest and Oldest go by issue number, which OneDev assigns in creation order.
 * @type {{ id: string, label: string, compare: (a: IssueRow, b: IssueRow) => number }[]}
 */
export const SORTS = [
  { id: "newest", label: "Newest", compare: (a, b) => b.number - a.number },
  { id: "oldest", label: "Oldest", compare: (a, b) => a.number - b.number },
  { id: "updated", label: "Recently updated", compare: (a, b) => byTimeDesc(time(a.updated), time(b.updated)) || b.number - a.number },
  { id: "stale", label: "Least recently updated", compare: (a, b) => byTimeAsc(time(a.updated), time(b.updated)) || a.number - b.number },
  { id: "comments", label: "Most commented", compare: (a, b) => (b.commentCount ?? 0) - (a.commentCount ?? 0) || b.number - a.number },
];

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const INVISIBLE = /[​‎‏‪-‮⁦-⁩؜﻿]/g;

/**
 * @param {unknown} s @param {number} [max]
 * @returns {string}
 */
export function displayText(s, max = Infinity) {
  if (typeof s !== "string") return "";
  const clean = s
    .replace(ANSI, "")
    .replace(INVISIBLE, "")
    .replace(/[\t\n\r\f\v\u2028\u2029]/g, " ")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= max) return clean;
  if (max < 1) return "";
  let cut = clean.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** @param {unknown} e @returns {string} */
function errText(e) {
  return typeof e === "object" && e !== null && "message" in e ? String(e.message) : String(e);
}
