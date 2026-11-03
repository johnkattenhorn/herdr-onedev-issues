// @ts-check
import { issueUrl } from "./markdown.js";

/** @typedef {import("./odev.js").TimelineItem} TimelineItem */
/** @typedef {import("./odev.js").Actor} Actor */

/**
 * @typedef {{ name: string, from: string, to: string }} FieldChange
 * @typedef {{ kind: "comment", id: number, date: string | null, actor: Actor | null, body: string }
 *   | { kind: "state", id: number, date: string | null, actor: Actor | null, from: string | null, to: string | null }
 *   | { kind: "fields", id: number, date: string | null, actor: Actor | null, changes: FieldChange[] }
 *   | { kind: "title", id: number, date: string | null, actor: Actor | null, from: string | null, to: string | null }
 *   | { kind: "note", id: number, date: string | null, actor: Actor | null, text: string }
 *   | { kind: "link", id: number, ref: string | null, direction: string | null, title: string | null, state: string | null, number: number | null, project: string | null }
 * } Entry
 */

const JOIN_MS = 60_000;
const KIND_ORDER = { change: 0, other: 0, comment: 1, link: 2 };
const STATE_COLORS = ["ansi2", "ansi5", "ansi3", "ansi4", "ansi6", "ansi1"];

/** @param {string | null | undefined} date @returns {number | null} */
export function time(date) {
  if (typeof date !== "string") return null;
  const ms = Date.parse(date);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * @param {string | null | undefined} date @param {number} now
 * @returns {string}
 */
export function ago(date, now) {
  const at = time(date);
  if (at === null) return "at an unknown time";
  const s = (now - at) / 1000;
  if (s < 0) return new Date(at).toISOString().slice(0, 10);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86_400 * 30) return `${Math.round(s / 86_400)}d ago`;
  return new Date(at).toISOString().slice(0, 10);
}

/** @param {Actor | null | undefined} actor @returns {string} */
export function actorName(actor) {
  return actor?.login ?? actor?.fullName ?? "unknown";
}

/** @param {string} name @returns {string} */
export function initials(name) {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean);
  const first = [...(words[0] ?? "?")][0] ?? "?";
  const second = words.length > 1 ? ([...words[1]][0] ?? "") : "";
  return (first + second).toUpperCase();
}

/** The theme key for a state pill: the state's ordinal picks it. @param {number | null} ordinal @param {string} state @returns {string} */
export function stateColorKey(ordinal, state) {
  const n = ordinal ?? (/^(closed|done|resolved|released|fixed)/i.test(state) ? 1 : 0);
  return STATE_COLORS[((n % STATE_COLORS.length) + STATE_COLORS.length) % STATE_COLORS.length];
}

/**
 * @param {{ host: string, project: string, number: number, title: string }} issue
 * @returns {{ id: string, label: string, text: string }[]}
 */
export function copyTexts({ host, project, number, title }) {
  const oneLine = title.replace(/\s+/g, " ").trim();
  return [
    { id: "link", label: "Copy link", text: issueUrl(host, project, number) },
    { id: "reference", label: "Copy reference", text: `${project}#${number}` },
    { id: "number", label: "Copy number", text: `#${number}` },
    { id: "number-title", label: "Copy number and title", text: oneLine ? `#${number} ${oneLine}` : `#${number}` },
  ];
}

/** @param {unknown} v @returns {string} */
function fieldText(v) {
  const values = v && typeof v === "object" && Array.isArray(/** @type {any} */ (v).values) ? /** @type {any} */ (v).values : null;
  if (values === null) return "";
  return values.filter((/** @type {unknown} */ x) => typeof x === "string").join(", ");
}

/** @param {unknown} data @returns {FieldChange[]} */
function fieldChanges(data) {
  const d = /** @type {any} */ (data);
  const before = d && typeof d.oldFields === "object" && d.oldFields ? d.oldFields : {};
  const after = d && typeof d.newFields === "object" && d.newFields ? d.newFields : {};
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return names.map((name) => ({ name, from: fieldText(before[name]), to: fieldText(after[name]) })).filter((c) => c.from !== c.to);
}

/** @param {string | null} type @returns {string} */
function humanType(type) {
  const bare = (type ?? "").replace(/^Issue/, "").replace(/Data$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return bare === "" ? "made a change" : `made a change: ${bare}`;
}

/** @param {unknown} v @returns {string | null} */
const str = (v) => (typeof v === "string" ? v : null);

/**
 * @param {TimelineItem} item @returns {Entry}
 */
function entryOf(item) {
  const base = { id: item.id, date: item.date, actor: /** @type {Actor | null} */ (item.kind === "link" ? null : item.actor) };
  if (item.kind === "comment") return { ...base, kind: "comment", body: item.body };
  if (item.kind === "link") {
    return { kind: "link", id: item.id, ref: item.ref, direction: item.direction, title: item.title, state: item.state, number: item.number, project: item.project };
  }
  if (item.kind === "other") return { ...base, kind: "note", text: `added an item this version does not know (${item.rawKind})` };
  const data = /** @type {any} */ (item.data);
  switch (item.type) {
    case "IssueStateChangeData":
      return { ...base, kind: "state", from: str(data?.oldState), to: str(data?.newState) };
    case "IssueFieldChangeData":
      return { ...base, kind: "fields", changes: fieldChanges(data) };
    case "IssueTitleChangeData":
      return { ...base, kind: "title", from: str(data?.oldTitle), to: str(data?.newTitle) };
    case "IssueDescriptionChangeData":
      return { ...base, kind: "note", text: "changed the description" };
    case "IssueReferencedFromPullRequestData":
      return { ...base, kind: "note", text: "referenced this from a pull request" };
    case "IssueReferencedFromIssueData":
      return { ...base, kind: "note", text: "referenced this from another issue" };
    case "IssueCommittedData":
      return { ...base, kind: "note", text: "committed a change that fixes this issue" };
    default:
      return { ...base, kind: "note", text: humanType(item.type) };
  }
}

/** @param {Actor | null} a @param {Actor | null} b @returns {boolean} */
const sameActor = (a, b) => (a?.id ?? null) === (b?.id ?? null) && actorName(a) === actorName(b);

/**
 * Sorts oldest first and joins field changes of one actor within a minute of
 * the one before into one line.
 * @param {TimelineItem[]} items @returns {Entry[]}
 */
export function groupTimeline(items) {
  const ranked = items
    .map((item, i) => ({ item, i, at: time(item.date) }))
    .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity) || KIND_ORDER[a.item.kind] - KIND_ORDER[b.item.kind] || a.item.id - b.item.id || a.i - b.i);
  /** @type {Entry[]} */
  const out = [];
  let lastAt = 0;
  for (const { item, at } of ranked) {
    const entry = entryOf(item);
    const prev = out.at(-1);
    if (entry.kind === "fields" && prev?.kind === "fields" && at !== null && at - lastAt <= JOIN_MS && sameActor(entry.actor, prev.actor)) {
      for (const c of entry.changes) {
        const earlier = prev.changes.find((p) => p.name === c.name);
        if (earlier) earlier.to = c.to;
        else prev.changes.push(c);
      }
      prev.changes = prev.changes.filter((c) => c.from !== c.to);
      lastAt = at;
      continue;
    }
    out.push(entry);
    lastAt = at ?? lastAt;
  }
  return out.filter((e) => e.kind !== "fields" || e.changes.length > 0);
}
