// @ts-check

/** @typedef {import("./odev.js").Odev} Odev */
/** @typedef {import("./odev.js").OnedevProject} Project */

/**
 * @typedef {{ kind: "comment", body: string }
 *   | { kind: "transition", state: string, comment: string }
 *   | { kind: "field", name: string, values: string[] }
 *   | { kind: "assign", current: string[] }
 *   | { kind: "unassign", current: string[] }
 * } Write
 */

/** @typedef {{ ok: true } | { ok: false, message: string }} Outcome */

export const CHANGED = "onedev-issues.changed";

/** @param {string} project @param {number} number @param {number} at @returns {{ project: string, number: number, at: number }} */
export function changeRecord(project, number, at) {
  return { project, number, at };
}

/** @param {unknown} x @returns {{ project: string, number: number, at: number } | null} */
export function parseChange(x) {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return null;
  const { project, number, at } = /** @type {Record<string, unknown>} */ (x);
  if (typeof project !== "string" || project === "") return null;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) return null;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  return { project, number, at };
}

/** The text area types a newline before it reports Ctrl+Enter; that one newline is not part of the comment. @param {string} text @returns {string} */
export function shortcutBody(text) {
  return text.endsWith("\r\n") ? text.slice(0, -2) : text.endsWith("\n") ? text.slice(0, -1) : text;
}

/** The comment box posts on Ctrl+Enter only (the event's `secondary` flag); Enter and Shift+Enter type a newline. @param {{ secondary?: boolean }} e */
export function postsOnSubmit(e) {
  return e.secondary === true;
}

/**
 * One comment draft per issue, keyed by `project#number`. `saved` holds the drafts of the issues not on screen;
 * the box holds the open issue's draft.
 */
export function createDrafts() {
  /** @type {Map<string, string>} */
  const saved = new Map();
  return {
    /** Leaves issue `from` with `text` in the box; returns the text the box shows for issue `to`. @param {string} from @param {string} text @param {string} to */
    move(from, text, to) {
      if (text === "") saved.delete(from);
      else saved.set(from, text);
      const next = saved.get(to) ?? "";
      saved.delete(to);
      return next;
    },
    /**
     * A write that carried `sent` from issue `key` succeeded while issue `open` shows `text` in the box.
     * Returns the box text for `open`: the posted draft goes, text typed while the write ran stays.
     * @param {string} key @param {string} sent @param {string} open @param {string} text
     */
    posted(key, sent, open, text) {
      if (key === open) return text === sent ? "" : text;
      if (saved.get(key) === sent) saved.delete(key);
      return text;
    },
  };
}

/** Assign adds the login; Unassign removes that login only. @param {string[]} current @param {string} login @param {"assign" | "unassign"} op @returns {string[]} */
export function assigneesAfter(current, login, op) {
  const others = current.filter((l) => l !== login);
  return op === "assign" ? [...others, login] : others;
}

/**
 * One write at a time: a call while one runs returns null and does nothing.
 * @param {{ odev: Odev, publish: (record: { project: string, number: number, at: number }) => void, now: () => number }} deps
 */
export function createWriter({ odev, publish, now }) {
  let busy = false;
  /** @type {string | null} */
  let login = null;

  /** @param {Project} verdict @returns {Promise<{ ok: true, value: string } | { ok: false, message: string }>} */
  async function whoami(verdict) {
    if (login !== null) return { ok: true, value: login };
    const r = await odev.login(verdict);
    if (r.ok === false) return { ok: false, message: r.error.message };
    login = r.value;
    return { ok: true, value: login };
  }

  /** @param {Project} verdict @param {number} number @param {Write} w */
  async function perform(verdict, number, w) {
    if (w.kind === "comment") return odev.comment(verdict, number, w.body);
    if (w.kind === "transition") return odev.transition(verdict, number, w.state, w.comment);
    if (w.kind === "field") return odev.setField(verdict, number, w.name, w.values);
    const me = await whoami(verdict);
    if (me.ok === false) return { ok: /** @type {const} */ (false), error: { kind: /** @type {const} */ ("exit"), message: me.message } };
    return odev.setField(verdict, number, "Assignees", assigneesAfter(w.current, me.value, w.kind));
  }

  return {
    busy: () => busy,
    whoami,
    /** @param {Project} verdict @param {number} number @param {Write} w @returns {Promise<Outcome | null>} */
    async submit(verdict, number, w) {
      if (busy) return null;
      busy = true;
      try {
        const r = await perform(verdict, number, w);
        if (r.ok === false) return { ok: false, message: r.error.message };
        publish(changeRecord(verdict.project, number, now()));
        return { ok: true };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      } finally {
        busy = false;
      }
    },
  };
}
