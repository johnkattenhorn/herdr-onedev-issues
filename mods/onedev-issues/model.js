// @ts-check

import { SORTS, chooseView, displayText, stateTabs } from "./cache.js";

/** @typedef {import("./odev.js").OnedevProject} OnedevProject */
/** @typedef {import("./odev.js").Verdict} Verdict */
/** @typedef {import("./odev.js").Known} Known */
/** @typedef {import("./cache.js").Cache} Cache */
/** @typedef {import("./cache.js").StoreStatus} StoreStatus */

/** @typedef {string} CtxKey */

/** @typedef {{ space: string, cwd: string, on: string | null, key: CtxKey }} FocusCtx */

/**
 * @typedef {{ mode: "hidden" | "onedev-issues" | "issues", columnShown: boolean, active: string | null, childIds: string[], shared: boolean }} PanelSlot
 */

/**
 * @typedef {{ kind: "known", verdict: Verdict, at: number }
 *   | { kind: "asking", prior: Verdict | null }
 *   | { kind: "failed", message: string }} Check
 */

/** @typedef {{ space: string | null, project: OnedevProject | null, error: string | null, checking: boolean }} PanelContext */

/** @typedef {{ lookups: FocusCtx[], select: "onedev-issues" | "issues" | null, show: boolean, opened: boolean, remember: OnedevProject | null, publish: PanelContext }} Step */

/**
 * @typedef {{
 *   ctx: FocusCtx | null,
 *   slot: PanelSlot,
 *   checks: Record<CtxKey, Check>,
 *   lastProject: Record<string, OnedevProject>,
 *   opening: boolean,
 *   configError: string | null,
 *   now: number,
 * }} RouteInput
 */

/** @typedef {{ state: string | null, mine: boolean, sort: string, selected: number | null, menu: boolean }} ViewPrefs */

/** @typedef {{ kind: "refresh" } | { kind: "open", number: number } | { kind: "focus" } | { kind: "unknown", name: string }} Command */

/** @typedef {{ number: number, title: string, state: string, fields?: Record<string, unknown> | null }} RowView */

export const CONTEXT = "onedev-issues.context";
export const RECHECK = "onedev-issues.recheck";
export const VERDICT_CAP = 200;
const VERDICT_MAX_AGE = 10 * 60_000;
const SPACES_CAP = 200;
const DEFAULT_PANELS = ["files", "changes"];
const REASONS = ["no-git", "no-origin", "unknown-host", "no-project"];

/** @param {unknown} x @returns {x is Record<string, unknown>} */
function isObject(x) {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** @param {unknown} x @returns {x is number} */
function isPositiveInt(x) {
  return typeof x === "number" && Number.isSafeInteger(x) && x > 0;
}

/**
 * @param {string} cwd @param {string | null} on
 * @returns {CtxKey}
 */
export function contextKey(cwd, on) {
  return JSON.stringify([cwd, on]);
}

/**
 * @param {{ space: string, pane: string | null, terminal: string | null, cwd: string | null } | null} focused
 * @param {{ pane: string, terminal: string | null, cwd: string | null }[]} panes
 * @param {{ id: string, folder: string, machine: string | null }[]} spaces
 * @param {FocusCtx | null} last
 * @returns {FocusCtx | null}
 */
export function focusContext(focused, panes, spaces, last) {
  if (!focused) return last;
  const pane = focused.pane ? panes.find((p) => p.pane === focused.pane) : undefined;
  if (pane && !pane.terminal && last) return last;
  const space = spaces.find((s) => s.id === focused.space);
  const terminalMachine = focused.terminal?.includes("/") ? focused.terminal.split("/")[0] : null;
  const on = focused.pane === null ? terminalMachine : (space?.machine ?? null);
  const cwd = pane?.cwd || focused.cwd || space?.folder;
  if (typeof cwd !== "string" || cwd === "") return last;
  return { space: focused.space, cwd, on, key: contextKey(cwd, on) };
}

/**
 * @param {unknown} node @param {string} id
 * @returns {Record<string, unknown> | null}
 */
function findNode(node, id) {
  if (!isObject(node)) return null;
  if (node.id === id) return node;
  if (!Array.isArray(node.children)) return null;
  for (const child of node.children) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return null;
}

/** @param {unknown} node @returns {boolean} */
function hasPanelBlock(node) {
  if (!isObject(node)) return false;
  const content = node.content;
  if (isObject(content) && content.mod === "onedev-issues" && !(isObject(content.props) && content.props.button === true)) return true;
  return Array.isArray(node.children) && node.children.some(hasPanelBlock);
}

/**
 * Whether our button holds the GitHub button's slot: it keeps the block it took over at
 * `content.props.replaced`. `--remove` and `readPanel` both use this rule, and a malformed marker is no marker.
 * @param {unknown} button
 * @returns {boolean}
 */
export function holdsGithubSlot(button) {
  if (!isObject(button) || !isObject(button.content) || !isObject(button.content.props)) return false;
  const replaced = button.content.props.replaced;
  return isObject(replaced) && replaced.id === "issues-button";
}

/**
 * @param {unknown} layoutRoot
 * @returns {PanelSlot}
 */
export function readPanel(layoutRoot) {
  /** @type {PanelSlot} */
  const hidden = { mode: "hidden", columnShown: false, active: null, childIds: [], shared: false };
  if (!isObject(layoutRoot)) return hidden;
  const body = findNode(layoutRoot, "panel-body");
  if (!body) {
    return hasPanelBlock(layoutRoot) ? { mode: "onedev-issues", columnShown: true, active: null, childIds: [], shared: false } : hidden;
  }
  const column = findNode(layoutRoot, "panel");
  const columnShown = column?.hidden !== true;
  const kids = Array.isArray(body.children) ? body.children : [];
  /** @type {string[]} */
  const childIds = kids.map((c) => (isObject(c) ? c.id : null)).filter((id) => typeof id === "string");
  const active = typeof body.active === "string" ? body.active : (childIds[0] ?? null);
  const mode = !columnShown ? "hidden" : active === "onedev-issues" || active === "issues" ? active : "hidden";
  const shared = childIds.includes("issues") && holdsGithubSlot(findNode(findNode(layoutRoot, "tab-bar"), "onedev-issues-button"));
  return { mode, columnShown, active, childIds, shared };
}

/** @param {PanelSlot} slot @returns {boolean} */
export function isPanelShown(slot) {
  return slot.mode === "onedev-issues";
}

/**
 * Whether this mod's button counts as pressed. Shared, the button stands for both panels. With
 * separate buttons the GitHub panel belongs to the GitHub mod's button, so it is not ours.
 * @param {PanelSlot} slot @returns {boolean}
 */
export function slotShowsIssues(slot) {
  return slot.shared ? slot.mode !== "hidden" : slot.mode === "onedev-issues";
}

/**
 * @param {RouteInput} input
 * @returns {Step}
 */
export function routeStep({ ctx, slot, checks, lastProject, opening, configError, now }) {
  const space = ctx?.space ?? null;
  const check = ctx ? checks[ctx.key] : undefined;
  const verdict = check?.kind === "known" ? check.verdict : check?.kind === "asking" ? check.prior : null;
  const last = (space !== null ? lastProject[space] : null) ?? null;
  const failed = check?.kind === "failed";
  const view = chooseView(verdict ?? (failed ? { kind: "failed" } : null), slot.shared, last);
  const project = view.action === "show" ? view.project : last;
  const child = view.action === "show" ? view.child : "onedev-issues";

  const active = slot.mode !== "hidden" || opening;
  const stale = check === undefined || (check.kind === "known" && now - check.at > VERDICT_MAX_AGE);
  const wantLookup = ctx !== null && configError === null && stale && active;
  const settled = verdict !== null || failed || ctx === null || configError !== null;

  const canSelect = slot.childIds.includes(child) && child !== slot.active;
  const switching = slot.shared && slot.columnShown && slot.mode !== "hidden" && view.action === "show";
  const opens = opening && settled;
  const select = canSelect && (switching || opens) ? child : null;

  return {
    lookups: wantLookup ? [ctx] : [],
    select,
    show: opens && !slot.columnShown,
    opened: opens,
    remember: verdict?.kind === "onedev" ? verdict : null,
    publish: {
      space,
      project,
      error: configError ?? (check?.kind === "failed" ? check.message : null),
      checking: ctx !== null && verdict === null && configError === null && check?.kind !== "failed",
    },
  };
}

/**
 * @param {unknown} panels @param {string[]} ids
 * @returns {string[]}
 */
export function withPanels(panels, ids) {
  const base = Array.isArray(panels) && panels.every((p) => typeof p === "string") ? panels : DEFAULT_PANELS;
  const missing = ids.filter((id) => !base.includes(id));
  return missing.length === 0 ? base : [...base, ...missing];
}

/**
 * @param {unknown} name
 * @returns {Command}
 */
export function parseCommand(name) {
  if (typeof name !== "string") return { kind: "unknown", name: "" };
  const bare = name.startsWith("onedev-issues.") ? name.slice("onedev-issues.".length) : name;
  if (bare === "refresh") return { kind: "refresh" };
  if (bare === "focus") return { kind: "focus" };
  const m = /^open-(\d{1,9})$/.exec(bare);
  if (m) {
    const number = Number(m[1]);
    if (number > 0) return { kind: "open", number };
  }
  return { kind: "unknown", name };
}

/**
 * @param {Cache} cache @param {ViewPrefs} prefs
 * @returns {string | null}
 */
export function effectiveState(cache, prefs) {
  const tabs = stateTabs(cache);
  return tabs.find((t) => t.name === prefs.state)?.name ?? tabs[0]?.name ?? null;
}

/**
 * @param {Cache} cache @param {ViewPrefs} prefs
 * @returns {import("./odev.js").IssueRow[]}
 */
export function visibleRows(cache, prefs) {
  const state = effectiveState(cache, prefs);
  const mine = new Set(cache.mine);
  const sort = SORTS.find((s) => s.id === prefs.sort) ?? SORTS[0];
  return Object.values(cache.issues)
    .filter((r) => r.state === state && (!prefs.mine || mine.has(r.number)))
    .sort(sort.compare);
}

/**
 * One last-result slot for `visibleRows`. The cache object is replaced on every change, so its identity stands for its content.
 * `selected` and `menu` change no order, so they are not part of the key.
 * @returns {(cache: Cache, prefs: ViewPrefs) => import("./odev.js").IssueRow[]}
 */
export function memoVisibleRows() {
  /** @type {{ cache: Cache, state: string | null, mine: boolean, sort: string, rows: import("./odev.js").IssueRow[] } | null} */
  let last = null;
  return (cache, prefs) => {
    if (last && last.cache === cache && last.state === prefs.state && last.mine === prefs.mine && last.sort === prefs.sort) return last.rows;
    const rows = visibleRows(cache, prefs);
    last = { cache, state: prefs.state, mine: prefs.mine, sort: prefs.sort, rows };
    return rows;
  };
}

/**
 * @param {ViewPrefs} prefs @param {Cache} cache @param {number} number
 * @returns {ViewPrefs}
 */
export function selectRow(prefs, cache, number) {
  const row = cache.issues[String(number)];
  if (row) return { ...prefs, selected: number, state: row.state, mine: false };
  if (cache.known[String(number)]) return { ...prefs, selected: number };
  return prefs;
}

/**
 * What a click on an item does to the view. A list row only selects: its tab and Mine stay, because the row is already in view.
 * A mention row may be in another tab or outside Mine, so it goes through `selectRow`.
 * @param {ViewPrefs} prefs @param {Cache} cache @param {{ kind: "mention" | "row", number: number }} item
 * @returns {ViewPrefs}
 */
export function clickedPrefs(prefs, cache, item) {
  return item.kind === "row" ? { ...prefs, selected: item.number } : selectRow(prefs, cache, item.number);
}

/**
 * @typedef {{ key: string, kind: "heading", label: string }
 *   | { key: string, kind: "mention" | "row", row: RowView }} ListItem
 */

/**
 * Everything that scrolls in the panel, in order, each with a key that the list reports on a click.
 * @param {{ mentions: RowView[], stateLabel: string, rows: RowView[] }} parts
 * @returns {ListItem[]}
 */
export function listItems({ mentions, stateLabel, rows }) {
  /** @type {ListItem[]} */
  const items = [];
  if (mentions.length > 0) {
    items.push({ key: "heading-mentions", kind: "heading", label: "In this terminal" });
    for (const row of mentions) items.push({ key: `mention-${row.number}`, kind: "mention", row });
    items.push({ key: "heading-state", kind: "heading", label: stateLabel });
  }
  for (const row of rows) items.push({ key: `row-${row.number}`, kind: "row", row });
  return items;
}

/** @typedef {{ fill: string | null, ink: string }} PillStyle  Theme colour names: the pill's fill (null for none) and the number's ink. */

/** @type {Record<string, PillStyle>} */
const PILLS = {
  Critical: { fill: "ansi1", ink: "background" },
  Major: { fill: "ansi3", ink: "background" },
  Normal: { fill: "border", ink: "foreground" },
  Minor: { fill: null, ink: "dim" },
};

/**
 * The pill behind an issue number, from the row's Priority field. A missing field, a non-string value or an unknown name gives the Normal pill.
 * @param {{ fields?: unknown }} row
 * @returns {PillStyle}
 */
export function pillStyle(row) {
  const fields = isObject(row.fields) ? row.fields : null;
  const name = fields?.Priority;
  return typeof name === "string" && Object.hasOwn(PILLS, name) ? PILLS[name] : PILLS.Normal;
}

/** The stated heights of the list, in px at zoom 1. A row always has room for a two-line title. */
export const ROW_HEIGHT = 52;
export const HEADING_HEIGHT = 30;
export const ITEM_GAP = 1;
export const LIST_PADDING = 6;

/**
 * The height of each item, with the gap below it and the list's padding at both ends. A virtual list places items by these.
 * @param {ListItem[]} items
 * @returns {number[]}
 */
export function itemSizes(items) {
  return items.map((it, i) => (it.kind === "heading" ? HEADING_HEIGHT : ROW_HEIGHT)
    + (i === 0 ? LIST_PADDING : 0)
    + (i === items.length - 1 ? LIST_PADDING : ITEM_GAP));
}

/**
 * What the panel's body shows. The cache is null with no project, or when the config did not load.
 * @param {{ project: OnedevProject | null, cache: Cache | null, prefs: ViewPrefs, status: StoreStatus, configError: string | null, contextError: string | null, rows: RowView[], mentions: RowView[] }} parts
 * @returns {{ kind: "no-project" | "loading" | "no-match" | "list", error: string | null, items: ListItem[] }}
 */
export function panelBody({ project, cache, prefs, status, configError, contextError, rows, mentions }) {
  return {
    kind: configError ? (project ? "no-match" : "no-project") : bodyKind(project, cache, status, rows),
    error: contextError ?? status.error ?? configError,
    items: listItems({ mentions, stateLabel: (cache && effectiveState(cache, prefs)) ?? "Issues", rows }),
  };
}

/**
 * The one decode of an item key. A heading or a malformed key gives null.
 * @param {unknown} key
 * @returns {{ kind: "mention" | "row", number: number } | null}
 */
export function decodeItemKey(key) {
  const m = typeof key === "string" ? /^(mention|row)-([1-9][0-9]{0,14})$/.exec(key) : null;
  return m ? { kind: /** @type {"mention" | "row"} */ (m[1]), number: Number(m[2]) } : null;
}

/**
 * @param {Cache} cache @param {number[]} numbers
 * @returns {RowView[]}
 */
export function mentionRows(cache, numbers) {
  /** @type {RowView[]} */
  const rows = [];
  for (const n of numbers) {
    const hit = cache.issues[String(n)] ?? cache.known[String(n)];
    if (hit) rows.push({ number: hit.number, title: hit.title, state: hit.state, fields: "fields" in hit ? hit.fields : null });
    if (rows.length >= 8) break;
  }
  return rows;
}

/**
 * @param {OnedevProject | null} project @param {Cache | null} cache @param {StoreStatus} status @param {unknown[]} rows
 * @returns {"no-project" | "loading" | "no-match" | "list"}
 */
export function bodyKind(project, cache, status, rows) {
  if (!project) return "no-project";
  if (cache === null || (cache.synced === 0 && status.error === null)) return "loading";
  return rows.length === 0 ? "no-match" : "list";
}

/**
 * @param {unknown} text
 * @returns {unknown}
 */
function parseJson(text) {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** @param {unknown} x @returns {Verdict | null} */
function asVerdict(x) {
  if (!isObject(x)) return null;
  if (x.kind === "onedev") return asProject(x);
  if (x.kind === "not-onedev" && typeof x.reason === "string" && REASONS.includes(x.reason)) {
    return /** @type {Verdict} */ ({ kind: "not-onedev", reason: x.reason });
  }
  return null;
}

/** @param {unknown} x @returns {OnedevProject | null} */
function asProject(x) {
  if (!isObject(x) || x.kind !== "onedev") return null;
  const { host, project, projectId } = x;
  if (typeof host !== "string" || host === "" || typeof project !== "string" || project === "") return null;
  if (!isPositiveInt(projectId)) return null;
  return { kind: "onedev", host, project, projectId };
}

/**
 * @param {unknown} text
 * @returns {Record<CtxKey, Check>}
 */
export function parseChecks(text) {
  const json = parseJson(text);
  if (!isObject(json)) return {};
  /** @type {[CtxKey, Check][]} */
  const entries = [];
  for (const [k, v] of Object.entries(json)) {
    const entry = asStoredCheck(v) ?? asBareVerdict(v);
    if (entry !== null) entries.push([k, { kind: "known", ...entry }]);
  }
  return Object.fromEntries(entries.slice(-VERDICT_CAP));
}

/** @param {unknown} v @returns {{ verdict: Verdict, at: number } | null} */
function asStoredCheck(v) {
  if (!isObject(v) || !("verdict" in v)) return null;
  const verdict = asVerdict(v.verdict);
  if (verdict === null) return null;
  return { verdict, at: typeof v.at === "number" && Number.isFinite(v.at) && v.at >= 0 ? v.at : 0 };
}

/** The format before checks had a time: a bare verdict, re-checked at once. @param {unknown} v @returns {{ verdict: Verdict, at: number } | null} */
function asBareVerdict(v) {
  const verdict = isObject(v) && !("verdict" in v) ? asVerdict(v) : null;
  return verdict === null ? null : { verdict, at: 0 };
}

/** @param {Record<CtxKey, Check>} checks @returns {string} */
export function serializeChecks(checks) {
  /** @type {Record<CtxKey, { verdict: Verdict, at: number }>} */
  const out = {};
  for (const [k, c] of Object.entries(checks)) if (c.kind === "known") out[k] = { verdict: c.verdict, at: c.at };
  return JSON.stringify(out);
}

/**
 * @param {Record<CtxKey, Check>} checks @param {CtxKey} key
 * @returns {Record<CtxKey, Check>}
 */
export function beginCheck(checks, key) {
  const c = checks[key];
  return { ...checks, [key]: { kind: "asking", prior: c?.kind === "known" ? c.verdict : null } };
}

/**
 * @param {Record<CtxKey, Check>} checks @param {CtxKey} key
 * @param {import("./odev.js").Result<Verdict>} result @param {number} now @param {number} [cap]
 * @returns {Record<CtxKey, Check>}
 */
export function endCheck(checks, key, result, now, cap = VERDICT_CAP) {
  /** @type {Check} */
  const check = result.ok === true
    ? { kind: "known", verdict: result.value, at: now }
    : { kind: "failed", message: displayText(result.error.message, 300) };
  return putNewest(checks, key, check, cap);
}

/**
 * @param {Record<string, OnedevProject>} lastProject @param {string} space @param {OnedevProject} project @param {number} [cap]
 * @returns {Record<string, OnedevProject>}
 */
export function rememberProject(lastProject, space, project, cap = SPACES_CAP) {
  return putNewest(lastProject, space, project, cap);
}

/**
 * @template T
 * @param {Record<string, T>} map @param {string} key @param {T} value @param {number} cap
 * @returns {Record<string, T>}
 */
function putNewest(map, key, value, cap) {
  const rest = Object.entries(map).filter(([k]) => k !== key);
  return Object.fromEntries([...rest, [key, value]].slice(-cap));
}

/**
 * @param {unknown} text
 * @returns {Record<string, OnedevProject>}
 */
export function parseSpaces(text) {
  const json = parseJson(text);
  if (!isObject(json)) return {};
  return Object.fromEntries(
    Object.entries(json)
      .map(([k, v]) => [k, asProject(v)])
      .filter(([, v]) => v !== null)
      .slice(-SPACES_CAP),
  );
}

/**
 * @param {unknown} value
 * @returns {PanelContext}
 */
export function parseContext(value) {
  if (!isObject(value)) return { space: null, project: null, error: null, checking: false };
  return {
    space: typeof value.space === "string" ? value.space : null,
    project: asProject(value.project),
    error: typeof value.error === "string" ? value.error : null,
    checking: value.checking === true,
  };
}

/**
 * @param {unknown} text
 * @returns {ViewPrefs}
 */
export function parsePrefs(text) {
  const json = parseJson(text);
  const o = isObject(json) ? json : {};
  return {
    state: typeof o.state === "string" ? o.state : null,
    mine: o.mine === true,
    sort: typeof o.sort === "string" && SORTS.some((s) => s.id === o.sort) ? o.sort : SORTS[0].id,
    selected: null,
    menu: false,
  };
}
