import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { appHome, exec, focused, hc, layout, nextCommand, openOverlay, panes, props, readTextFile, run, setShared, shared, spaces, theme } from "herdr";
import * as fs from "fs/promises";
import { createOdev, loadConfig } from "./odev.js";
import { SORTS, cacheFileName, createCaches, displayText, herdrIO, mentionScanner, stateTabs } from "./cache.js";
import {
  CONTEXT, RECHECK, beginCheck, bodyKind, effectiveState, endCheck, focusContext, isPanelShown, mentionRows, parseChecks,
  parseCommand, parseContext, parsePrefs, parseSpaces, readPanel, rememberProject, routeStep, selectRow, serializeChecks,
  slotShowsIssues, visibleRows, withPanels,
} from "./model.js";
import { ensureIcons, icon } from "./icons.js";
import { CopyMenu, IssueDialog, openCopyMenu } from "./viewer.js";
import { CHANGED, parseChange } from "./writes.js";

/** @typedef {import("gpui-kit").AsyncContext} Cx */
/** @typedef {Record<string, `#${string}`>} Theme */
/** @typedef {import("./cache.js").ProjectStore} Store */
/** @typedef {import("./cache.js").Cache} Cache */
/** @typedef {import("./odev.js").OnedevProject} Project */
/** @typedef {import("./model.js").ViewPrefs} Prefs */
/** @typedef {import("./model.js").PanelContext} PanelContext */
/** @typedef {import("./model.js").RowView} RowView */
/** @typedef {(_e: unknown, cx: Cx) => void} Click */
/** @typedef {"no-project" | "loading" | "no-match"} EmptyKind */

const SPINNER = "mods/workspace-chrome/spinner.svg";
const SYNC_MS = 30_000;
const SCAN_MS = 3_000;
const dataDir = () => `${appHome()}/data/onedev-issues`;

const colors = () => /** @type {Theme} */ (theme());
const sameJson = (/** @type {unknown} */ a, /** @type {unknown} */ b) => JSON.stringify(a) === JSON.stringify(b);

const readConfig = () => loadConfig(readTextFile, `${dataDir()}/config.json`);

export default class OnedevIssues extends View {
  /** Herdr hands a block's props to `props()`, not to init's first argument. @param {unknown} _props @param {Cx} cx */
  init(_props, cx) {
    const p = props() ?? {};
    if (Array.isArray(p.copyMenu)) this.copy = new CopyMenu(cx, p.copyMenu);
    else if (p.issue) this.copy = new IssueDialog(cx, { ...p.issue, overlay: p.overlay, readConfig });
    else this.copy = p.button === true ? new Router(cx) : new Viewer(cx);
  }

  /** @param {import("gpui-kit").Context} cx */
  render(cx) {
    return this.copy.render(cx, props()?.overlay);
  }
}

class Router {
  /** @param {Cx} cx */
  constructor(cx) {
    this.checks = parseChecks(localStorage.getItem("verdicts"));
    this.lastProject = parseSpaces(localStorage.getItem("spaces"));
    this.recheck = shared(RECHECK);
    this.opening = false;
    /** @type {import("./model.js").FocusCtx | null} */
    this.last = null;
    /** @type {string | null} */
    this.lastKey = null;
    /** @type {import("./odev.js").Odev | null} */
    this.odev = null;
    /** @type {string | null} */
    this.configError = null;
    this.icons = false;
    this.iconsTried = -Infinity;

    const current = shared("workspace.panels");
    const panels = withPanels(current, ["onedev-issues", "issues"]);
    if (!sameJson(panels, current)) setShared("workspace.panels", panels);

    cx.spawn(async (cx) => {
      const cfg = await readConfig();
      if (cfg.ok === true) this.odev = createOdev({ exec, path: cfg.value });
      else this.configError = displayText(cfg.error.message, 300);
      cx.notify();
    });
  }

  /** @param {Cx} cx */
  render(cx) {
    ensureIcons(this, cx);
    this.reconcile(cx);
    const slot = readPanel(layout());
    return issuesButton(colors(), { on: slotShowsIssues(slot), checking: this.opening, icons: this.icons }, (cx) => this.click(cx));
  }

  /** @param {Cx} cx */
  reconcile(cx) {
    this.last = focusContext(focused(), panes(), spaces(), this.last);
    const ctx = this.last;
    if (ctx && ctx.key !== this.lastKey) {
      this.lastKey = ctx.key;
      if (this.checks[ctx.key]?.kind === "failed") delete this.checks[ctx.key];
    }
    const recheck = shared(RECHECK);
    if (recheck !== this.recheck) {
      this.recheck = recheck;
      if (ctx && this.odev && this.checks[ctx.key]?.kind !== "asking") this.lookup(ctx, cx);
    }
    const slot = readPanel(layout());
    const step = routeStep({
      ctx, slot, checks: this.checks, lastProject: this.lastProject,
      opening: this.opening, configError: this.configError, now: Date.now(),
    });

    if (this.odev) for (const need of step.lookups) this.lookup(need, cx);
    if (step.remember && ctx) this.remember(ctx.space, step.remember);
    if (step.select) run("layout.select", { stack: "panel-body", child: step.select });
    if (step.show) run("layout.show", { id: "panel" });
    if (step.opened) this.opening = false;
    if (!sameJson(step.publish, shared(CONTEXT))) setShared(CONTEXT, step.publish);
  }

  /** @param {import("./model.js").FocusCtx} need @param {Cx} cx */
  lookup(need, cx) {
    this.checks = beginCheck(this.checks, need.key);
    cx.spawn(async (cx) => {
      const r = await this.odev.which(need.cwd, need.on);
      this.checks = endCheck(this.checks, need.key, r, Date.now());
      localStorage.setItem("verdicts", serializeChecks(this.checks));
      cx.notify();
    });
  }

  /** @param {string} space @param {Project} project */
  remember(space, project) {
    if (sameJson(this.lastProject[space], project)) return;
    this.lastProject = rememberProject(this.lastProject, space, project);
    localStorage.setItem("spaces", JSON.stringify(this.lastProject));
  }

  /** @param {Cx} cx */
  click(cx) {
    if (slotShowsIssues(readPanel(layout()))) {
      this.opening = false;
      run("layout.hide", { id: "panel" });
    } else {
      this.opening = !this.opening;
    }
    this.reconcile(cx);
    cx.notify();
  }
}

/** @param {Theme} t @param {{ on: boolean, checking: boolean, icons: boolean }} s @param {(cx: Cx) => void} onClick */
function issuesButton(t, { on, checking, icons: ready }, onClick) {
  return h_flex().size_full().pr(10).items_center().justify_end().bg(t.chrome).border_b(1).border_color(t.border)
    .child(h_flex().id("onedev-issues-toggle").h(26).px(7).gap(4).flex_none().items_center().rounded(6)
      .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover)).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => onClick(cx))
      .child(checking
        ? svg(SPINNER).size(14).text_color(t.working).spin(900)
        : div().size(14).when(ready, (e) => e.child(svg(icon("issue")).size(14))))
      .child("Issues"));
}

class Viewer {
  /** @param {Cx} cx */
  constructor(cx) {
    /** @type {{ kind: "starting" } | { kind: "config-error", message: string } | { kind: "ready", odev: import("./odev.js").Odev, caches: import("./cache.js").Caches }} */
    this.body = { kind: "starting" };
    /** @type {Prefs} */
    this.prefs = parsePrefs(localStorage.getItem("prefs"));
    /** @type {string | null} */
    this.key = null;
    /** @type {{ key: string, scan: (screen: string) => number[] } | null} */
    this.scanner = null;
    /** @type {{ key: string, numbers: number[] } | null} */
    this.mentions = null;
    this.scanning = false;
    this.wasShown = false;
    this.seenChange = parseChange(shared(CHANGED));
    /** @type {string | null} */
    this.terminal = null;
    this.icons = false;
    this.iconsTried = -Infinity;

    cx.spawn(async (/** @type {Cx} */ cx) => {
      const cfg = await readConfig();
      if (cfg.ok === true) {
        const odev = createOdev({ exec, path: cfg.value });
        const caches = createCaches({ io: herdrIO({ exec, fs }), odev, dir: dataDir(), now: Date.now });
        this.body = { kind: "ready", odev, caches };
      } else {
        this.body = { kind: "config-error", message: displayText(cfg.error.message, 300) };
      }
      cx.notify();
    });
    cx.timer.every(SYNC_MS, (cx) => this.tick(cx));
    cx.timer.every(SCAN_MS, (cx) => this.scan(cx));
    cx.spawn((cx) => this.commands(cx));
  }

  shown() {
    return isPanelShown(readPanel(layout()));
  }

  /** @returns {Store | null} */
  store() {
    const ctx = parseContext(shared(CONTEXT));
    return this.body.kind === "ready" && ctx.project ? this.body.caches.get(ctx.project) : null;
  }

  /** Render may call this, and a notify before the first await would land in the render phase. @param {Cx} cx @param {Store} store @param {boolean} user */
  syncNow(cx, store, user) {
    const done = store.sync({ user });
    cx.spawn(async (cx) => {
      const r = await done;
      if (user || r.changed) cx.notify();
    });
  }

  /** @param {Cx} cx */
  tick(cx) {
    const store = this.store();
    if (store && this.shown()) this.syncNow(cx, store, false);
  }

  /** A write in a dialog sets `onedev-issues.changed`; the panel then re-reads the project, which carries the changed issue. @param {Cx} cx @param {PanelContext} ctx */
  refetchOnChange(cx, ctx) {
    const change = parseChange(shared(CHANGED));
    if (change === null || sameJson(change, this.seenChange)) return;
    this.seenChange = change;
    const store = this.store();
    if (store && ctx.project?.project === change.project) this.syncNow(cx, store, true);
  }

  /** @param {Cx} cx @param {boolean} shown @param {PanelContext} ctx */
  startOnChange(cx, shown, ctx) {
    if (this.body.kind !== "ready") return;
    const key = ctx.project ? cacheFileName(ctx.project) : null;
    if (key !== this.key) {
      this.key = key;
      if (ctx.project) this.switchProject(cx, ctx.project, key);
    }
    if (shown && !this.wasShown) {
      const store = this.store();
      if (store) this.syncNow(cx, store, false);
      this.scan(cx);
    }
    this.wasShown = shown;
  }

  /** @param {Cx} cx @param {Project} project @param {string} key */
  switchProject(cx, project, key) {
    if (this.body.kind !== "ready") return;
    const { odev, caches } = this.body;
    const store = caches.get(project);
    cx.spawn(async (cx) => {
      await store.load();
      cx.notify();
      if (this.key === key && this.shown()) this.syncNow(cx, store, false);
    });
    cx.spawn(async () => {
      const r = await odev.spellings(project);
      if (this.key === key) this.scanner = { key, scan: mentionScanner(project, r.ok === true ? r.value : []) };
    });
  }

  /** @param {Cx} cx */
  scan(cx) {
    const store = this.store();
    this.terminal = focused()?.terminal ?? this.terminal;
    const terminal = this.terminal;
    const key = this.key;
    if (!store || !terminal || this.scanning || !this.shown() || this.scanner?.key !== key) return;
    const scanner = this.scanner;
    this.scanning = true;
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["read", terminal, "--lines", "300"]).catch(() => null);
        if (r === null || r.code !== 0 || this.key !== key) return;
        const numbers = scanner.scan(r.stdout);
        if (this.mentions?.key !== key || !sameJson(this.mentions.numbers, numbers)) {
          this.mentions = { key, numbers };
          cx.notify();
        }
        if ((await store.resolve(numbers)).changed) cx.notify();
      } finally {
        this.scanning = false;
      }
    });
  }

  /** @param {Cx} cx */
  async commands(cx) {
    for (;;) {
      const c = parseCommand(await nextCommand());
      const store = this.store();
      if (c.kind === "refresh") this.refresh(cx, store);
      if (c.kind === "open" && store) this.setPrefs(selectRow(this.prefs, store.cache(), c.number));
      if (c.kind === "open") this.openIssue(c.number);
      cx.notify();
    }
  }

  /** @param {number} number */
  openIssue(number) {
    const ctx = parseContext(shared(CONTEXT));
    if (!ctx.project) return;
    const cache = this.store()?.cache();
    const hit = cache ? (cache.issues[String(number)] ?? cache.known[String(number)]) : null;
    const row = hit ? { number: hit.number, title: hit.title, state: hit.state, stateOrdinal: "stateOrdinal" in hit ? hit.stateOrdinal : null } : null;
    openOverlay({ mod: "onedev-issues", kind: "dialog", width: 0.86, height: 0.9, props: { issue: { verdict: ctx.project, number, row } } });
  }

  /** @param {Cx} cx @param {Store | null} store */
  refresh(cx, store) {
    setShared(RECHECK, (Number(shared(RECHECK)) || 0) + 1);
    if (store) this.syncNow(cx, store, true);
  }

  /** @param {Prefs} prefs */
  setPrefs(prefs) {
    this.prefs = prefs;
    localStorage.setItem("prefs", JSON.stringify({ state: prefs.state, mine: prefs.mine, sort: prefs.sort }));
  }

  /** @param {Cx} cx */
  render(cx) {
    ensureIcons(this, cx);
    const t = colors();
    const ctx = parseContext(shared(CONTEXT));
    this.startOnChange(cx, this.shown(), ctx);
    this.refetchOnChange(cx, ctx);

    const frame = v_flex().id("onedev-issues").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background)
      .border_1().border_color(t.border).text_color(t.foreground).text_size(13);
    if (this.body.kind === "starting") return frame.child(emptyState(t, "loading"));

    const configError = this.body.kind === "config-error" ? this.body.message : null;
    const store = this.store();
    const cache = store ? store.cache() : null;
    const status = store ? store.status() : { userSyncing: false, error: null, note: null };
    const rows = cache ? visibleRows(cache, this.prefs) : [];
    const kind = configError ? (ctx.project ? "no-match" : "no-project") : bodyKind(ctx.project, cache, status, rows);
    const error = ctx.error ?? status.error ?? configError;

    const onSync = (/** @type {Cx} */ cx) => { this.refresh(cx, store); cx.notify(); };
    const set = (/** @type {Prefs} */ prefs, /** @type {Cx} */ cx) => { this.setPrefs(prefs); cx.notify(); };
    const pick = (/** @type {number} */ n) => (/** @type {unknown} */ _e, /** @type {Cx} */ cx) => { this.prefs = { ...this.prefs, selected: n }; this.openIssue(n); cx.notify(); };
    const mentionList = cache && this.mentions?.key === this.key ? mentionRows(cache, this.mentions.numbers) : [];

    return frame
      .child(header(t, ctx.project, status.userSyncing, this.icons, store ? onSync : null))
      .when(cache !== null && kind !== "no-project", (e) => e.child(controls(t, cache, this.prefs, set)))
      .child(v_flex().id("onedev-issues-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(1)
        .when(Boolean(error), (e) => e.child(div().px(10).py(4).text_size(11).text_color(t.ansi1).child(displayText(error, 300))))
        .when(mentionList.length > 0, (e) => e.child(heading(t, "In this terminal"))
          .children(mentionList.map((r) => issueRow(t, r, `mention-${r.number}`, this.prefs.selected === r.number,
            (_e, cx) => { set(selectRow(this.prefs, cache, r.number), cx); this.openIssue(r.number); })))
          .child(heading(t, effectiveState(cache, this.prefs) ?? "Issues")))
        .when(kind === "list", (e) => e.children(rows.map((r) => issueRow(t, r, `row-${r.number}`, this.prefs.selected === r.number, pick(r.number),
          () => ctx.project && openCopyMenu({ host: ctx.project.host, project: ctx.project.project, number: r.number, title: r.title })))))
        .when(kind !== "list", (e) => e.child(emptyState(t, kind))));
  }
}

/** @param {Theme} t @param {Project | null} project @param {boolean} userSyncing @param {boolean} ready @param {((cx: Cx) => void) | null} onRefresh */
function header(t, project, userSyncing, ready, onRefresh) {
  return h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
    .child(div().size(14).flex_none().when(ready, (e) => e.child(svg(icon("issue")).size(14).text_color(t.ansi2))))
    .child(div().font_semibold().child("Issues"))
    .child(div().flex_1().min_w(0).text_size(11).text_color(t.dim).text_right().truncate().child(project ? displayText(project.project, 60) : ""))
    .when(onRefresh !== null, (e) => e.child(h_flex().id("onedev-issues-refresh").h(26).px(8).gap(5).flex_none().items_center().rounded(7)
      .border_1().border_color(t.border).text_size(12).text_color(t.muted).cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => onRefresh(cx))
      .child(userSyncing
        ? svg(SPINNER).size(12).text_color(t.working).spin(900)
        : div().size(12).when(ready, (x) => x.child(svg(icon("refresh")).size(12))))
      .child(userSyncing ? "Syncing" : "Refresh")));
}

/** @param {Theme} t @param {string} id @param {string} label @param {boolean} on @param {Click} onClick */
function segment(t, id, label, on, onClick) {
  return div().id(id).h(24).px(9).flex().items_center().rounded(6).text_size(12).cursor_pointer()
    .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted).when(on, (e) => e.font_semibold())
    .hover((s) => s.bg(on ? t.selected : t.hover)).on_click(onClick).child(label);
}

/** @param {Theme} t @param {Cache} cache @param {Prefs} prefs @param {(prefs: Prefs, cx: Cx) => void} set */
function controls(t, cache, prefs, set) {
  const current = effectiveState(cache, prefs);
  const sort = SORTS.find((s) => s.id === prefs.sort) ?? SORTS[0];
  return v_flex().flex_none().p(8).gap(6).border_b(1).border_color(t.border)
    .child(h_flex().gap(6).items_center()
      .child(h_flex().flex_none().p(2).gap(2).rounded(8).border_1().border_color(t.border)
        .children(stateTabs(cache).map((tab) => segment(t, `state-${tab.name}`, `${displayText(tab.name, 20)} ${tab.count}`, tab.name === current,
          (_e, cx) => set({ ...prefs, state: tab.name }, cx)))))
      .child(div().flex_1())
      .child(h_flex().flex_none().p(2).gap(2).rounded(8).border_1().border_color(t.border)
        .child(segment(t, "filter-all", "All", !prefs.mine, (_e, cx) => set({ ...prefs, mine: false }, cx)))
        .child(segment(t, "filter-mine", "Mine", prefs.mine, (_e, cx) => set({ ...prefs, mine: true }, cx)))))
    .child(h_flex().gap(6).items_center()
      .child(div().flex_1())
      .child(h_flex().id("onedev-issues-sort").h(26).px(9).gap(4).flex_none().items_center().rounded(7).border_1().border_color(t.border)
        .text_size(12).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => set({ ...prefs, menu: !prefs.menu }, cx))
        .child(sort.label).child(div().text_size(9).child("▼"))))
    .when(prefs.menu, (e) => e.child(h_flex().gap(4).flex_wrap()
      .children(SORTS.map((s) => segment(t, `sort-${s.id}`, s.label, s.id === prefs.sort,
        (_e, cx) => set({ ...prefs, sort: s.id, menu: false }, cx))))));
}

/** @param {Theme} t @param {string} label */
function heading(t, label) {
  return div().flex_none().px(10).pt(8).pb(4).text_size(11).font_semibold().text_color(t.dim).child(displayText(label, 40));
}

/** @param {Theme} t @param {RowView} r @param {string} id @param {boolean} selected @param {Click} onClick @param {(() => unknown) | null} [onMenu] */
function issueRow(t, r, id, selected, onClick, onMenu = null) {
  return h_flex().id(id).flex_none().px(10).py(6).gap(8).items_start().rounded(7).cursor_pointer()
    .when(onMenu !== null, (e) => e.on_mouse_down("right", () => onMenu?.()))
    .when(selected, (e) => e.bg(t.selected)).hover((s) => s.bg(selected ? t.selected : t.hover)).on_click(onClick)
    .child(div().flex_none().w(40).text_color(t.dim).child(`#${r.number}`))
    .child(div().flex_1().min_w(0).line_height("20px").max_h(40).overflow_hidden().child(displayText(r.title, 200)))
    .child(div().flex_none().text_size(11).text_color(t.dim).child(displayText(r.state, 16)));
}

/** @param {Theme} t @param {EmptyKind | "list"} kind */
function emptyState(t, kind) {
  /** @type {Record<EmptyKind, [string, string | null]>} */
  const texts = {
    "no-project": ["No project yet", "Focus a terminal inside a OneDev repository and its issues show up here."],
    loading: ["Loading issues…", null],
    "no-match": ["No issues here", null],
  };
  const [title, help] = texts[kind === "list" ? "no-match" : kind];
  return v_flex().flex_1().items_center().justify_center().gap(10).px(36).py(28)
    .child(div().font_semibold().text_color(t.muted).child(title))
    .when(help !== null, (e) => e.child(div().text_size(12).text_color(t.dim).text_center().child(help)));
}
