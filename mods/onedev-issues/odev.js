// @ts-check

/** @typedef {OnedevProject | NotOnedev} Verdict */

/**
 * `host` is canonical: every spelling of one instance gives the same host.
 * @typedef {{ kind: "onedev", host: string, project: string, projectId: number }} OnedevProject
 */

/**
 * @typedef {{ kind: "not-onedev", reason: "no-git" | "no-origin" | "unknown-host" | "no-project" }} NotOnedev
 */

/**
 * @typedef {{
 *   id: number | null,
 *   number: number,
 *   title: string,
 *   state: string,
 *   updated: string | null,
 *   confidential: boolean,
 *   fields: Record<string, string | string[] | null> | null,
 *   submitter: { id: number | null, login: string | null } | null,
 *   submitDate: string | null,
 *   commentCount: number | null,
 *   stateOrdinal: number | null,
 * }} IssueRow
 */

/** @typedef {{ number: number, title: string, state: string }} Known */

/**
 * @typedef {{ kind: "spawn" | "exit" | "shape" | "config" | "call", message: string, stderr?: string, code?: number }} OdevError
 */

/**
 * @template T
 * @typedef {{ ok: true, value: T, skipped?: number, warning?: string } | { ok: false, error: OdevError }} Result
 */

/**
 * @typedef {{ code: number, stdout: string, stderr: string }} ExecResult
 * @typedef {(cmd: string, args: string[], opts?: { cwd?: string, on?: string | null }) => Promise<ExecResult>} Exec
 */

/**
 * @typedef {{
 *   which(cwd: string, on?: string | null): Promise<Result<Verdict>>,
 *   list(q: { verdict: OnedevProject, since?: number, mine?: boolean }): Promise<Result<IssueRow[]>>,
 *   lookup(verdict: OnedevProject, numbers: number[]): Promise<Result<Map<number, Known | null>>>,
 *   spellings(verdict: OnedevProject): Promise<Result<string[]>>,
 *   issue(verdict: OnedevProject, number: number): Promise<Result<IssueView>>,
 *   timeline(verdict: OnedevProject, number: number): Promise<Result<TimelineItem[]>>,
 *   states(verdict: OnedevProject): Promise<Result<StateInfo[]>>,
 *   fields(verdict: OnedevProject): Promise<Result<FieldInfo[]>>,
 *   login(verdict: OnedevProject): Promise<Result<string>>,
 *   comment(verdict: OnedevProject, number: number, body: string): Promise<Result<null>>,
 *   transition(verdict: OnedevProject, number: number, state: string, comment: string): Promise<Result<null>>,
 *   setField(verdict: OnedevProject, number: number, name: string, values: string[]): Promise<Result<null>>,
 * }} Odev
 */

/** @typedef {{ name: string, ordinal: number | null, closed: boolean | null }} StateInfo */
/** @typedef {{ name: string, type: string, multiple: boolean | null, choices: string[] }} FieldInfo */

/** @typedef {{ id: number | null, login: string | null, fullName: string | null }} Actor */

/**
 * @typedef {{
 *   issue: { number: number, title: string, state: string, description: string, updated: string | null, confidential: boolean },
 *   fields: Record<string, string | string[] | null> | null,
 *   pulls: { number: number, title: string, state: string, project: string | null }[] | null,
 *   submitter: Actor | null,
 * }} IssueView
 */

/**
 * @typedef {{ kind: "comment", id: number, date: string | null, actor: Actor | null, body: string }
 *   | { kind: "change", id: number, date: string | null, actor: Actor | null, type: string | null, data: unknown }
 *   | { kind: "link", id: number, date: string | null, direction: string | null, ref: string | null, project: string | null, number: number | null, title: string | null, state: string | null }
 *   | { kind: "other", id: number, date: string | null, actor: Actor | null, rawKind: string }
 * } TimelineItem
 */

const MAX_ROWS = 1000;
const MAX_LOOKUP = 8;
const MAX_TIMELINE = 2000;
const MAX_STDERR = 4096;
const MAX_COMMENT_BYTES = 100_000;
const MAX_VALUE_CHARS = 4096;
const OUTPUT_LIMIT = 8 * 1024 * 1024;
const REASONS = ["no-git", "no-origin", "unknown-host", "no-project"];

/**
 * A relative path with a separator is refused: exec would resolve it against
 * an arbitrary cwd.
 * @param {string | null} text
 * @returns {Result<string>}
 */
export function parseOdevConfig(text) {
  if (text === null || text === undefined) return ok("odev");
  /** @type {unknown} */
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return fail("config", `config.json is not JSON: ${oneLine(errText(e), 120)}`);
  }
  if (!isObject(json)) return fail("config", "config.json must hold a JSON object");
  if (!("odev" in json)) return ok("odev");
  const p = json.odev;
  if (typeof p !== "string") return fail("config", `config.json "odev" must be a string, not ${typeof p}`);
  if (p.trim() === "") return fail("config", 'config.json "odev" is empty');
  if (p.includes("\0")) return fail("config", 'config.json "odev" holds a NUL byte');
  if (p.length > 4096) return fail("config", 'config.json "odev" is longer than 4096 characters');
  const absolute = p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
  if (!absolute && /[\\/]/.test(p)) return fail("config", `config.json "odev" must be a bare name or an absolute path, not "${oneLine(p, 80)}"`);
  return ok(p);
}

/**
 * Herdr's readTextFile resolves null for a missing file and rejects for a
 * directory or an unreadable file.
 * @param {(path: string) => Promise<string | null>} read @param {string} path
 * @returns {Promise<Result<string>>}
 */
export async function loadConfig(read, path) {
  /** @type {string | null} */
  let text;
  try {
    text = await read(path);
  } catch (e) {
    return fail("config", `cannot read config.json: ${oneLine(errText(e), 200)}`);
  }
  return parseOdevConfig(text);
}

/**
 * @param {{ exec: Exec, path: string }} deps
 * @returns {Odev}
 */
export function createOdev({ exec, path }) {
  /**
   * @template A, T
   * @param {CallSpec<A, T>} spec
   * @param {A} args
   * @param {string | null} [on]
   * @returns {Promise<Result<T>>}
   */
  async function run(spec, args, on) {
    try {
      const argv = spec.argv(args);
      /** @type {ExecResult} */
      let r;
      try {
        r = await exec(path, argv, on ? { on } : undefined);
      } catch (e) {
        return fail("spawn", `cannot run ${oneLine(path, 120)}: ${oneLine(errText(e), 200)}`);
      }
      if (!isObject(r) || typeof r.code !== "number") return fail("spawn", `cannot run ${oneLine(path, 120)}: exec gave no exit code`);
      const stdout = typeof r.stdout === "string" ? r.stdout : "";
      const stderr = typeof r.stderr === "string" ? r.stderr : "";
      if (!spec.exits.includes(r.code)) return fail("exit", failureMessage(stderr, r.code), stderr, r.code);

      /** @type {unknown} */
      let json;
      try {
        json = JSON.parse(stdout);
      } catch {
        if (r.code !== 0) return fail("exit", failureMessage(stderr, r.code), stderr, r.code);
        const why = utf8Length(stdout) >= OUTPUT_LIMIT - 4096
          ? "odev output reached the 8 MiB limit and was cut"
          : stdout.trim() === ""
            ? "odev printed nothing"
            : "odev printed text that is not JSON";
        const line = stderrLine(stderr);
        return fail("shape", line ? `${why} (stderr: ${line})` : why, stderr, r.code);
      }
      const parsed = spec.parse(json, args);
      if (parsed === null) {
        if (r.code !== 0) return fail("exit", failureMessage(stderr, r.code), stderr, r.code);
        return fail("shape", `odev ${spec.name} printed JSON of the wrong shape`, stderr, r.code);
      }
      /** @type {Result<T>} */
      const result = { ok: true, value: parsed.value };
      if (parsed.skipped) result.skipped = parsed.skipped;
      if (parsed.warning) result.warning = parsed.warning;
      return result;
    } catch (e) {
      return fail("call", `bad call: ${oneLine(errText(e), 200)}`);
    }
  }

  /**
   * @template {unknown[]} A, R
   * @param {(...a: A) => Promise<Result<R>>} fn
   * @returns {(...a: A) => Promise<Result<R>>}
   */
  const safe = (fn) => async (...a) => {
    try {
      return await fn(...a);
    } catch (e) {
      return fail("call", `bad call: ${oneLine(errText(e), 200)}`);
    }
  };

  return {
    which: safe((cwd, on) => {
      if (typeof cwd !== "string" || cwd === "") throw new Error("cwd must be a non-empty string");
      return run(CALLS.which, [cwd], on);
    }),
    list: safe(async (q) => run(CALLS.list, [q.verdict, { since: q.since, mine: q.mine }])),
    lookup: safe(async (verdict, numbers) => {
      const refs = lookupRefs(numbers);
      if (refs.length === 0) return ok(new Map());
      return run(CALLS.view, [verdict, refs]);
    }),
    spellings: safe(async (verdict) => {
      const r = await run(CALLS.config, [verdict]);
      if (r.ok === true) return r;
      return { ok: true, value: [authorityOf(verdict.host)], warning: r.error.message };
    }),
    issue: safe(async (verdict, number) => {
      if (!isPositiveInt(number)) throw new Error("number must be a positive integer");
      return run(CALLS.issueView, [verdict, number]);
    }),
    timeline: safe(async (verdict, number) => {
      if (!isPositiveInt(number)) throw new Error("number must be a positive integer");
      return run(CALLS.timeline, [verdict, number]);
    }),
    states: safe(async (verdict) => run(CALLS.states, [verdict])),
    fields: safe(async (verdict) => run(CALLS.fields, [verdict])),
    login: safe(async (verdict) => run(CALLS.login, [verdict])),
    comment: safe(async (verdict, number, body) => {
      const refused = refuseText(body, "comment", MAX_COMMENT_BYTES, true);
      if (refused) return fail("call", refused);
      return run(CALLS.comment, [verdict, positive(number), body]);
    }),
    transition: safe(async (verdict, number, state, comment) => {
      const refused = refuseText(state, "state", MAX_VALUE_CHARS, true) ?? refuseText(comment, "comment", MAX_COMMENT_BYTES, false);
      if (refused) return fail("call", refused);
      return run(CALLS.transition, [verdict, positive(number), state, comment.trim() === "" ? "" : comment]);
    }),
    setField: safe(async (verdict, number, name, values) => {
      const refused = refuseText(name, "field name", 200, true) ?? values.map((v) => refuseText(v, "field value", MAX_VALUE_CHARS, false)).find(Boolean);
      if (refused) return fail("call", refused);
      if (name.includes("=")) return fail("call", "a field name cannot hold =");
      return run(CALLS.edit, [verdict, positive(number), name, values]);
    }),
  };
}

/**
 * @template A, T
 * @typedef {{
 *   name: string,
 *   argv: (args: A) => string[],
 *   exits: number[],
 *   parse: (json: unknown, args: A) => { value: T, skipped?: number, warning?: string } | null,
 * }} CallSpec
 */

const target = (/** @type {OnedevProject} */ p) => ["--host", p.host, "--project", p.project];

const CALLS = {
  which: /** @type {CallSpec<[string], Verdict>} */ ({
    name: "project which",
    argv: ([cwd]) => ["-C", cwd, "project", "which", "--json"],
    exits: [0],
    parse: (json) => {
      const v = parseVerdict(json);
      return v && { value: v };
    },
  }),

  list: /** @type {CallSpec<[OnedevProject, { since?: number, mine?: boolean }], IssueRow[]>} */ ({
    name: "issue list",
    argv: ([p, q]) => [
      "issue", "list", "--json", "--state", "all", "-L", "500",
      ...(q.since !== undefined ? ["--since", sinceArg(q.since)] : []),
      ...(q.mine ? ["--assignee", "me"] : []),
      ...target(p),
    ],
    exits: [0],
    parse: (json) => parseListPage(json),
  }),

  /** Exit 1 is accepted: odev prints the whole array and exits 1 when any ref failed. */
  view: /** @type {CallSpec<[OnedevProject, number[]], Map<number, Known | null>>} */ ({
    name: "issue view",
    argv: ([p, refs]) => ["issue", "view", ...refs.map(String), "--json", ...target(p)],
    exits: [0, 1],
    parse: (json, [, refs]) => {
      const m = parseViewBatch(json, refs);
      return m && { value: m };
    },
  }),

  issueView: /** @type {CallSpec<[OnedevProject, number], IssueView>} */ ({
    name: "issue view",
    argv: ([p, n]) => ["issue", "view", String(n), "--json", ...target(p)],
    exits: [0],
    parse: (json) => {
      const v = parseIssueView(json);
      return v && { value: v };
    },
  }),

  timeline: /** @type {CallSpec<[OnedevProject, number], TimelineItem[]>} */ ({
    name: "issue timeline",
    argv: ([p, n]) => ["issue", "timeline", String(n), "--json", ...target(p)],
    exits: [0],
    parse: (json) => parseTimeline(json),
  }),

  states: /** @type {CallSpec<[OnedevProject], StateInfo[]>} */ ({
    name: "issue states",
    argv: ([p]) => ["issue", "states", "--json", ...target(p)],
    exits: [0],
    parse: (json) => {
      if (!isObject(json) || !Array.isArray(json.states)) return null;
      const states = json.states.flatMap((/** @type {unknown} */ s) => isObject(s) && typeof s.name === "string" && s.name !== ""
        ? [{ name: s.name, ordinal: isSafeInt(s.ordinal) ? s.ordinal : null, closed: typeof s.closed === "boolean" ? s.closed : null }]
        : []);
      return { value: states };
    },
  }),

  fields: /** @type {CallSpec<[OnedevProject], FieldInfo[]>} */ ({
    name: "issue fields",
    argv: ([p]) => ["issue", "fields", "--json", ...target(p)],
    exits: [0],
    parse: (json) => {
      if (!isObject(json) || !Array.isArray(json.fields)) return null;
      const fields = json.fields.flatMap((/** @type {unknown} */ f) => isObject(f) && typeof f.name === "string" && f.name !== ""
        ? [{
            name: f.name,
            type: typeof f.type === "string" ? f.type : "",
            multiple: typeof f.multiple === "boolean" ? f.multiple : null,
            choices: Array.isArray(f.choices) ? f.choices.filter((/** @type {unknown} */ c) => typeof c === "string") : [],
          }]
        : []);
      return { value: fields };
    },
  }),

  login: /** @type {CallSpec<[OnedevProject], string>} */ ({
    name: "auth status",
    argv: ([p]) => ["auth", "status", "--json", ...target(p)],
    exits: [0],
    parse: (json) => (isObject(json) && typeof json.loginName === "string" && json.loginName !== "" ? { value: json.loginName } : null),
  }),

  /** Every value is one argv word in `--flag=value` form, so a text that starts with `-` is never an option. */
  comment: /** @type {CallSpec<[OnedevProject, number, string], null>} */ ({
    name: "issue comment",
    argv: ([p, n, body]) => ["issue", "comment", String(n), `--body=${body}`, "--json", ...target(p)],
    exits: [0],
    parse: (json) => (isObject(json) ? { value: null } : null),
  }),

  transition: /** @type {CallSpec<[OnedevProject, number, string, string], null>} */ ({
    name: "issue transition",
    argv: ([p, n, state, comment]) => ["issue", "transition", String(n), `--state=${state}`, ...(comment === "" ? [] : [`--comment=${comment}`]), "--json", ...target(p)],
    exits: [0],
    parse: (json) => (isObject(json) ? { value: null } : null),
  }),

  /** An empty list clears the field. */
  edit: /** @type {CallSpec<[OnedevProject, number, string, string[]], null>} */ ({
    name: "issue edit",
    argv: ([p, n, name, values]) => ["issue", "edit", String(n), ...(values.length === 0 ? [`--field=${name}=`] : values.map((v) => `--field=${name}=${v}`)), "--json", ...target(p)],
    exits: [0],
    parse: (json) => (isObject(json) ? { value: null } : null),
  }),

  /** odev's `aliases` map {spelling: canonical base URL}. */
  config: /** @type {CallSpec<[OnedevProject], string[]>} */ ({
    name: "config view",
    argv: () => ["config", "view", "--json"],
    exits: [0],
    parse: (json, [p]) => {
      const s = parseSpellings(json, p.host);
      return s && { value: s };
    },
  }),
};

/**
 * @param {unknown} text @param {string} what @param {number} max @param {boolean} required
 * @returns {string | null} why the text is refused, or null when it may go to odev
 */
function refuseText(text, what, max, required) {
  if (typeof text !== "string") return `${what} must be text`;
  if (text.includes("\0")) return `${what} holds a NUL byte, which cannot be sent`;
  if (required && text.trim() === "") return `${what} is empty`;
  if (utf8Length(text) > max) return `${what} is longer than ${max.toLocaleString("en")} bytes`;
  return null;
}

/** @param {number} n @returns {number} */
function positive(n) {
  if (!isPositiveInt(n)) throw new Error("number must be a positive integer");
  return n;
}

/** @param {unknown} json @returns {Verdict | null} */
function parseVerdict(json) {
  if (!isObject(json)) return null;
  if (json.kind === "onedev") {
    const { host, project, projectId } = json;
    if (typeof host !== "string" || host === "" || typeof project !== "string" || project === "") return null;
    if (!isPositiveInt(projectId)) return null;
    return { kind: "onedev", host, project, projectId };
  }
  if (json.kind === "not-onedev") {
    const reason = REASONS.find((r) => r === json.reason);
    return reason ? /** @type {NotOnedev} */ ({ kind: "not-onedev", reason }) : null;
  }
  return null;
}

/** @param {unknown} x @returns {IssueRow | null} */
export function parseIssueRow(x) {
  if (!isObject(x)) return null;
  if (!isPositiveInt(x.number) || typeof x.title !== "string" || typeof x.state !== "string" || x.state === "") return null;
  const submitter = isObject(x.submitter)
    ? {
        id: isSafeInt(x.submitter.id) ? x.submitter.id : null,
        login: typeof x.submitter.login === "string" ? x.submitter.login : null,
      }
    : null;
  return {
    id: isSafeInt(x.id) ? x.id : null,
    number: x.number,
    title: x.title,
    state: x.state,
    updated: typeof x.updated === "string" ? x.updated : null,
    confidential: x.confidential === true,
    fields: parseFields(x.fields),
    submitter,
    submitDate: typeof x.submitDate === "string" ? x.submitDate : null,
    commentCount: isSafeInt(x.commentCount) ? x.commentCount : null,
    stateOrdinal: isSafeInt(x.stateOrdinal) ? x.stateOrdinal : null,
  };
}

/**
 * `issue view --json` for one issue. `pulls`, `fields` and `submitter` are null when odev could not read them.
 * @param {unknown} json @returns {IssueView | null}
 */
export function parseIssueView(json) {
  if (!isObject(json) || !isObject(json.issue)) return null;
  const i = json.issue;
  if (!isPositiveInt(i.number) || typeof i.title !== "string" || typeof i.state !== "string" || i.state === "") return null;
  const pulls = Array.isArray(json.pulls)
    ? json.pulls.flatMap((/** @type {unknown} */ p) =>
        isObject(p) && isPositiveInt(p.number) && typeof p.state === "string"
          ? [{ number: p.number, title: typeof p.title === "string" ? p.title : "", state: p.state, project: typeof p.project === "string" ? p.project : null }]
          : [])
    : null;
  return {
    issue: {
      number: i.number,
      title: i.title,
      state: i.state,
      description: typeof i.description === "string" ? i.description : "",
      updated: typeof i.updated === "string" ? i.updated : null,
      confidential: i.confidential === true,
    },
    fields: parseFields(json.fields),
    pulls,
    submitter: parseActor(json.submitter),
  };
}

/** @param {unknown} x @returns {Actor | null} */
function parseActor(x) {
  if (!isObject(x)) return null;
  return {
    id: isSafeInt(x.id) ? x.id : null,
    login: typeof x.login === "string" ? x.login : null,
    fullName: typeof x.fullName === "string" ? x.fullName : null,
  };
}

/**
 * `issue timeline --json`. An item of a kind this version does not know stays as "other"; a non-object is dropped.
 * @param {unknown} json @returns {{ value: TimelineItem[], skipped: number } | null}
 */
export function parseTimeline(json) {
  if (!Array.isArray(json)) return null;
  /** @type {TimelineItem[]} */
  const items = [];
  let skipped = 0;
  for (const x of json) {
    if (!isObject(x) || items.length >= MAX_TIMELINE) {
      skipped++;
      continue;
    }
    const id = isSafeInt(x.id) ? x.id : 0;
    const date = typeof x.date === "string" ? x.date : null;
    const actor = parseActor(x.actor);
    const text = (/** @type {unknown} */ v) => (typeof v === "string" ? v : null);
    if (x.kind === "comment") items.push({ kind: "comment", id, date, actor, body: typeof x.body === "string" ? x.body : "" });
    else if (x.kind === "change") items.push({ kind: "change", id, date, actor, type: text(x.type), data: x.data ?? null });
    else if (x.kind === "link") {
      items.push({
        kind: "link", id, date, direction: text(x.direction), ref: text(x.ref), project: text(x.project),
        number: isPositiveInt(x.number) ? x.number : null, title: text(x.title), state: text(x.state),
      });
    } else items.push({ kind: "other", id, date, actor, rawKind: typeof x.kind === "string" ? x.kind.slice(0, 40) : typeof x.kind });
  }
  return { value: items, skipped };
}

/** @param {unknown} x @returns {Record<string, string | string[] | null> | null} */
function parseFields(x) {
  if (!isObject(x)) return null;
  const entries = Object.entries(x).filter(([, v]) =>
    v === null || typeof v === "string" || (Array.isArray(v) && v.every((s) => typeof s === "string")));
  return Object.fromEntries(entries);
}

/**
 * odev orders by newest activity, so the first copy of a number wins.
 * @param {unknown} json @returns {{ value: IssueRow[], skipped: number } | null}
 */
function parseListPage(json) {
  if (!Array.isArray(json)) return null;
  /** @type {IssueRow[]} */
  const rows = [];
  const seen = new Set();
  let skipped = 0;
  for (const raw of json) {
    const row = parseIssueRow(raw);
    if (!row || seen.has(row.number) || rows.length >= MAX_ROWS) {
      skipped++;
      continue;
    }
    seen.add(row.number);
    rows.push(row);
  }
  return { value: rows, skipped };
}

/**
 * @param {unknown} json @param {number[]} refs
 * @returns {Map<number, Known | null> | null}
 */
function parseViewBatch(json, refs) {
  if (!Array.isArray(json) || json.length !== refs.length) return null;
  /** @type {Map<number, Known | null>} */
  const out = new Map();
  json.forEach((entry, i) => {
    if (!isObject(entry)) return;
    const issue = entry.issue;
    if (isObject(issue)) {
      if (issue.number === refs[i] && typeof issue.title === "string" && typeof issue.state === "string") {
        out.set(refs[i], { number: issue.number, title: issue.title, state: issue.state });
      }
    } else if (typeof entry.error === "string" && /not found/i.test(entry.error)) {
      out.set(refs[i], null);
    }
  });
  return out;
}

/**
 * @param {unknown} json @param {string} host
 * @returns {string[] | null}
 */
function parseSpellings(json, host) {
  if (!isObject(json)) return null;
  const own = authorityOf(host);
  const aliases = json.aliases;
  const out = [own];
  if (isObject(aliases)) {
    const want = normalizeBase(host);
    for (const [spelling, to] of Object.entries(aliases)) {
      if (typeof to !== "string" || normalizeBase(to) !== want) continue;
      const a = authorityOf(spelling);
      if (a !== "" && !out.includes(a)) out.push(a);
    }
  }
  return out;
}

/** A lone number is doubled so odev prints an array. @param {number[]} numbers @returns {number[]} */
function lookupRefs(numbers) {
  const uniq = [...new Set(Array.isArray(numbers) ? numbers.filter(isPositiveInt) : [])].slice(0, MAX_LOOKUP);
  return uniq.length === 1 ? [uniq[0], uniq[0]] : uniq;
}

/** @param {number} ms @returns {string} */
function sinceArg(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0 || ms > 8.64e15) throw new Error(`since is not a valid time: ${String(ms)}`);
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

/** @param {string} s @returns {string} */
function authorityOf(s) {
  return s.trim().replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, "").split(/[/?#]/)[0].toLowerCase();
}

/** @param {string} s @returns {string} */
function normalizeBase(s) {
  return s.trim().replace(/\/+$/, "").toLowerCase();
}

/** @param {string} s @returns {number} */
export function utf8Length(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** @param {string} stderr @returns {string | null} */
function stderrLine(stderr) {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => l.startsWith("odev:")) ?? lines[0];
  return line ? oneLine(line, 300) : null;
}

/** @param {string} stderr @param {number} code @returns {string} */
function failureMessage(stderr, code) {
  return stderrLine(stderr) ?? `odev exited ${code}`;
}

/** @param {string} s @param {number} max @returns {string} */
function oneLine(s, max) {
  const first = s.trim().split(/[\r\n]/)[0].replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
  return first.length > max ? first.slice(0, max) + "..." : first;
}

/** @param {unknown} e @returns {string} */
function errText(e) {
  return isObject(e) && typeof e.message === "string" ? e.message : String(e);
}

/** @template T @param {T} value @returns {Result<T>} */
function ok(value) {
  return { ok: true, value };
}

/**
 * @param {OdevError["kind"]} kind @param {string} message @param {string} [stderr] @param {number} [code]
 * @returns {{ ok: false, error: OdevError }}
 */
function fail(kind, message, stderr, code) {
  /** @type {OdevError} */
  const error = { kind, message };
  if (stderr) error.stderr = stderr.slice(0, MAX_STDERR);
  if (code !== undefined) error.code = code;
  return { ok: false, error };
}

/** @param {unknown} x @returns {x is Record<string, any>} */
function isObject(x) {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** @param {unknown} x @returns {x is number} */
function isSafeInt(x) {
  return typeof x === "number" && Number.isSafeInteger(x);
}

/** @param {unknown} x @returns {x is number} */
function isPositiveInt(x) {
  return isSafeInt(x) && x > 0;
}
