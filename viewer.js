import { div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView, Textarea, TextareaState } from "gpui-base";
import { closeOverlay, exec, notify, openOverlay, setShared, theme } from "herdr";
import { createOdev } from "./odev.js";
import { displayText } from "./cache.js";
import { ensureIcons, icon } from "./icons.js";
import { issueFromUrl, issueUrl, toBlocks, webUrl } from "./markdown.js";
import { CHANGED, createDrafts, createWriter, postsOnSubmit, shortcutBody } from "./writes.js";
import { actorName, ago, copyTexts, groupTimeline, initials, stateColorKey } from "./issue-model.js";

/** @typedef {import("gpui-kit").AsyncContext} Cx */
/** @typedef {Record<string, `#${string}`>} Theme */
/** @typedef {import("./odev.js").OnedevProject} Project */
/** @typedef {import("./odev.js").IssueView} IssueView */
/** @typedef {import("./odev.js").TimelineItem} TimelineItem */
/** @typedef {import("./issue-model.js").Entry} Entry */
/** @typedef {{ number: number, title: string, state: string, stateOrdinal?: number | null }} Row */
/** @typedef {{ project: string, number: number }} Ref */
/** @typedef {import("./writes.js").Write} Write */
/** @typedef {{ kind: "state" } | { kind: "field", name: string }} Menu */

const MOD = "onedev-issues";
const BODY_CAP = 100_000;
const SPINNER = "mods/workspace-chrome/spinner.svg";
const colors = () => /** @type {Theme} */ (theme());
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const INVISIBLE = new RegExp("[\\s\\u200b-\\u200f\\u2028\\u2029\\u2060\\ufeff]", "g");

/** @param {string} url */
export function openUrl(url) {
  const safe = webUrl(url);
  if (safe !== null) exec("xdg-open", [safe]).catch(() => null);
}

/** @param {{ host: string, project: string, number: number, title: string }} issue @param {"pointer"} [at] */
export function openCopyMenu(issue, at = "pointer") {
  openOverlay({ mod: MOD, kind: "popup", width: 280, height: 172, at, props: { copyMenu: copyTexts(issue) } });
}

/** @param {string} text @returns {string} */
const cleanBody = (text) => {
  const clean = text.replace(CONTROL, "");
  return clean.length > BODY_CAP ? `${clean.slice(0, BODY_CAP)}\n\n(The text is cut at ${BODY_CAP.toLocaleString("en")} characters.)` : clean;
};

/** @param {boolean} ready @param {string} name @param {number} size @param {string} color */
const glyph = (ready, name, size, color) => div().size(size).flex_none().when(ready, (e) => e.child(svg(icon(name)).size(size).text_color(color)));

export class CopyMenu {
  /** @param {unknown} _cx @param {{ id: string, label: string, text: string }[]} entries */
  constructor(_cx, entries) {
    this.entries = entries;
    this.icons = false;
    this.iconsTried = -Infinity;
  }

  /** @param {{ text: string }} entry @param {string} overlay @param {import("gpui-kit").Context} cx */
  pick(entry, overlay, cx) {
    cx.write_to_clipboard(entry.text);
    notify({ title: "Copied", body: displayText(entry.text, 120), level: "success", timeout: 2000 });
    closeOverlay(overlay);
  }

  /** @param {import("gpui-kit").Context} cx @param {string} overlay */
  render(cx, overlay) {
    ensureIcons(this, /** @type {Cx} */ (/** @type {unknown} */ (cx)));
    const t = colors();
    return v_flex().id("onedev-copy-menu").size_full().p(6).gap(2).bg(t.background).text_color(t.foreground).text_size(13)
      .children(this.entries.map((e) => h_flex().id(`copy-${e.id}`).h(34).px(10).gap(8).items_center().rounded(6).cursor_pointer()
        .hover((s) => s.bg(t.hover)).on_click((_ev, cx) => this.pick(e, overlay, cx))
        .child(glyph(this.icons, "copy", 14, t.muted))
        .child(div().child(e.label))));
  }
}

export class IssueDialog {
  /**
   * @param {Cx} cx
   * @param {{ overlay: string, verdict: Project, number: number, row: Row | null, readConfig: () => Promise<import("./odev.js").Result<string>> }} p
   */
  constructor(cx, p) {
    this.overlay = p.overlay;
    this.verdict = p.verdict;
    /** @type {import("./odev.js").Odev | null} */
    this.odev = null;
    /** @type {Ref} */
    this.cur = { project: p.verdict.project, number: p.number };
    /** @type {Ref[]} */
    this.history = [];
    /** @type {Map<string, Row>} */
    this.rows = new Map();
    if (p.row) this.rows.set(this.key(this.cur), p.row);
    /** @type {Map<string, { view?: IssueView, entries?: Entry[], links?: Entry[], error?: string | null }>} */
    this.data = new Map();
    /** @type {Map<string, import("./markdown.js").Block[]>} */
    this.blocks = new Map();
    this.pending = 0;
    this.icons = false;
    this.iconsTried = -Infinity;
    this.box = TextareaState.new({ placeholder: "Leave a comment", rows: 4 });
    this.box.set_auto_grow(4, 14);
    this.box.on("submit", (e, cx) => { if (postsOnSubmit(e)) this.post(cx, true); });
    this.drafts = createDrafts();
    /** @type {"write" | "preview"} */
    this.tab = "write";
    /** @type {Menu | null} */
    this.menu = null;
    /** @type {import("./odev.js").StateInfo[] | null} */
    this.states = null;
    /** @type {import("./odev.js").FieldInfo[] | null} */
    this.fieldInfos = null;
    /** @type {string | null} */
    this.me = null;
    /** @type {string | null} */
    this.writeError = null;
    this.writing = false;
    /** @type {ReturnType<typeof createWriter> | null} */
    this.writer = null;
    cx.spawn(async (cx) => {
      const cfg = await p.readConfig();
      if (cfg.ok === true) {
        this.odev = createOdev({ exec, path: cfg.value });
        this.writer = createWriter({ odev: this.odev, publish: (r) => setShared(CHANGED, r), now: Date.now });
        this.load(cx);
        this.loadChoices(cx);
      } else {
        this.data.set(this.key(this.cur), { error: displayText(cfg.error.message, 300) });
        cx.notify();
      }
    });
  }

  /** @param {Ref} r */
  key(r) {
    return `${r.project}#${r.number}`;
  }

  /** Shows the cached row at once, then fills in the issue and its timeline as each arrives. @param {Cx} cx */
  load(cx) {
    const odev = this.odev;
    if (!odev) return;
    const ref = this.cur;
    const key = this.key(ref);
    const verdict = { ...this.verdict, project: ref.project };
    const slot = this.data.get(key) ?? {};
    this.data.set(key, { ...slot, error: null });
    this.pending += 2;
    cx.spawn(async (cx) => {
      const r = await odev.issue(verdict, ref.number);
      this.pending--;
      const d = this.data.get(key) ?? {};
      if (r.ok === true) {
        d.view = r.value;
        this.rows.set(key, { number: r.value.issue.number, title: r.value.issue.title, state: r.value.issue.state, stateOrdinal: this.rows.get(key)?.stateOrdinal ?? null });
      } else d.error = displayText(r.error.message, 300);
      this.data.set(key, d);
      this.blocks.clear();
      cx.notify();
    });
    cx.spawn(async (cx) => {
      const r = await odev.timeline(verdict, ref.number);
      this.pending--;
      const d = this.data.get(key) ?? {};
      if (r.ok === true) {
        const all = groupTimeline(r.value);
        d.entries = all.filter((e) => e.kind !== "link");
        d.links = all.filter((e) => e.kind === "link");
      } else d.error = d.error ?? displayText(r.error.message, 300);
      this.data.set(key, d);
      this.blocks.clear();
      cx.notify();
    });
  }

  /** The state list, the field choices and John's login change rarely: read once. @param {Cx} cx */
  loadChoices(cx) {
    const odev = this.odev;
    const writer = this.writer;
    if (!odev || !writer) return;
    const verdict = this.verdict;
    cx.spawn(async (cx) => {
      const [states, fields, me] = await Promise.all([odev.states(verdict), odev.fields(verdict), writer.whoami(verdict)]);
      if (states.ok === true) this.states = states.value;
      if (fields.ok === true) this.fieldInfos = fields.value;
      if (me.ok === true) this.me = me.value;
      cx.notify();
    });
  }

  /** Runs one write. `sent` is the box text the write carried: on success that draft goes, and text typed while it ran stays; a failure keeps the text and shows odev's message. @param {Write} w @param {string | null} sent @param {Cx} cx */
  write(w, sent, cx) {
    const writer = this.writer;
    if (!writer || this.writing) return;
    this.writing = true;
    this.writeError = null;
    const ref = this.cur;
    const verdict = { ...this.verdict, project: ref.project };
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await writer.submit(verdict, ref.number, w);
      this.writing = false;
      if (r === null) return;
      if (r.ok === true) {
        if (sent !== null) {
          const open = this.key(this.cur);
          const text = this.box.value();
          const next = this.drafts.posted(this.key(ref), sent, open, text);
          if (next !== text) {
            this.box.set_value(next);
            this.tab = "write";
          }
        }
        this.menu = null;
        if (this.key(this.cur) === this.key(ref)) this.load(cx);
      } else this.writeError = displayText(r.message, 300);
      cx.notify();
    });
  }

  /** @param {Cx} cx @param {boolean} [shortcut] */
  post(cx, shortcut = false) {
    const text = this.box.value();
    this.write({ kind: "comment", body: shortcut ? shortcutBody(text) : text }, text, cx);
  }

  /** Swaps the open issue, and the box to that issue's draft. @param {Ref} ref */
  show(ref) {
    const next = this.drafts.move(this.key(this.cur), this.box.value(), this.key(ref));
    if (next !== this.box.value()) this.box.set_value(next);
    this.cur = ref;
    this.tab = "write";
    this.menu = null;
  }

  /** @param {Ref} ref @param {Cx} cx */
  go(ref, cx) {
    if (this.key(ref) === this.key(this.cur)) return;
    this.history.push(this.cur);
    this.show(ref);
    this.writeError = null;
    this.load(cx);
    cx.notify();
  }

  /** @param {Cx} cx */
  back(cx) {
    const prev = this.history.pop();
    if (!prev) return;
    this.show(prev);
    this.writeError = null;
    this.load(cx);
    cx.notify();
  }

  /** Issue links open here; web links open in the browser; every other scheme is dropped. @param {string} url @param {Cx} cx */
  link(url, cx) {
    const ref = issueFromUrl(url, this.verdict.host);
    if (ref) this.go(ref, cx);
    else openUrl(url);
  }

  /** @param {string} id @param {string} text @param {Theme} t */
  body(id, text, t) {
    if (text.replace(INVISIBLE, "") === "") return div().text_color(t.muted).italic().child("No description provided.");
    let blocks = this.blocks.get(id);
    if (!blocks) {
      blocks = toBlocks(cleanBody(text), { host: this.verdict.host, project: this.cur.project });
      this.blocks.set(id, blocks);
    }
    return v_flex().gap(10).children(blocks.map((b, n) => "image" in b
      ? this.imageLine(`${id}-img-${n}`, b, t)
      : TextView.markdown(`${id}-${n}`, b.text).selectable(true).on_link_click((url, cx) => this.link(url, cx))));
  }

  /** @param {string} id @param {{ image: string | null, alt: string }} b @param {Theme} t */
  imageLine(id, b, t) {
    const label = `Image: ${displayText(b.alt, 80) || "no description"}`;
    const url = b.image;
    return h_flex().id(id).gap(6).items_center().text_size(13).text_color(t.muted)
      .when(url !== null, (e) => e.cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click(() => openUrl(/** @type {string} */ (url))))
      .child(glyph(this.icons, "link", 14, t.muted)).child(div().underline().child(label));
  }

  /** @param {string} name @param {number} size @param {Theme} t */
  avatar(name, size, t) {
    const palette = [t.ansi1, t.ansi2, t.ansi3, t.ansi4, t.ansi5, t.ansi6];
    const color = palette[[...name].reduce((h, c) => (h * 31 + (c.codePointAt(0) ?? 0)) >>> 0, 7) % palette.length];
    return div().size(size).flex_none().rounded(size / 2).flex().items_center().justify_center().bg(`${color}33`)
      .text_size(Math.round(size * 0.45)).font_semibold().text_color(color).child(initials(name));
  }

  /** @param {string} id @param {{ actor: import("./odev.js").Actor | null, date: string | null, body: string }} c @param {Theme} t @param {string} [note] */
  card(id, c, t, note) {
    const name = displayText(actorName(c.actor), 60);
    return v_flex().flex_none().rounded(6).border_1().border_color(t.border).overflow_hidden().bg(t.background)
      .child(h_flex().h(38).px(12).gap(8).items_center().bg(t.raised).border_b(1).border_color(t.border).text_size(13)
        .child(this.avatar(name, 20, t)).child(div().font_semibold().text_color(t.foreground).child(name))
        .child(div().text_color(t.muted).child(note ?? ago(c.date, Date.now()))))
      .child(div().px(16).py(14).text_size(14).child(this.body(id, c.body, t)));
  }

  /** @param {string} id @param {Entry} e @param {Theme} t */
  event(id, e, t) {
    const strong = (/** @type {string} */ s) => div().font_semibold().text_color(t.foreground).child(displayText(s, 80));
    const muted = (/** @type {string} */ s) => div().child(displayText(s, 160));
    /** @type {import("gpui-kit").Element[]} */
    const parts = [];
    let name = "pencil";
    if (e.kind === "state") {
      name = "issue";
      parts.push(muted("changed the state"), ...(e.from ? [div().line_through().child(displayText(e.from, 40))] : []), strong(e.to ?? "unknown"));
    } else if (e.kind === "fields") {
      name = "tag";
      parts.push(muted("changed"), ...e.changes.flatMap((c) => [strong(c.name), div().line_through().child(displayText(c.from || "none", 40)), strong(c.to || "none")]));
    } else if (e.kind === "title") {
      parts.push(muted("changed the title"), div().line_through().child(displayText(e.from ?? "", 80)), strong(e.to ?? ""));
    } else if (e.kind === "note") {
      name = "link";
      parts.push(muted(e.text));
    }
    const who = "actor" in e ? displayText(actorName(e.actor), 60) : "";
    return h_flex().id(id).flex_none().pl(6).gap(10).items_center()
      .child(div().size(28).flex_none().rounded(14).flex().items_center().justify_center().bg(t.raised).border_1().border_color(t.border)
        .child(glyph(this.icons, name, 14, t.muted)))
      .child(h_flex().flex_1().min_w(0).gap(5).items_center().flex_wrap().text_size(13).text_color(t.muted)
        .child(strong(who)).children(parts)
        .child(div().underline().child("date" in e ? ago(e.date, Date.now()) : "")));
  }

  /** @param {Theme} t */
  joint(t) {
    return div().flex_none().ml(19).w(2).h(16).bg(t.border);
  }

  /** @param {string} id @param {string} label @param {Theme} t @param {(cx: Cx) => void} onClick @param {string} [name] */
  button(id, label, t, onClick, name) {
    return h_flex().id(id).h(30).px(10).gap(6).flex_none().items_center().justify_center().rounded(6).text_size(13)
      .bg(t.raised).border_1().border_color(t.border).text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { if (!this.writing) onClick(cx); })
      .when(this.writing && id.startsWith("onedev-w-"), (e) => e.opacity(0.45).cursor_not_allowed())
      .when(Boolean(name), (e) => e.child(glyph(this.icons, /** @type {string} */ (name), 14, t.muted)))
      .when(label !== "", (e) => e.child(label));
  }

  /** @param {Theme} t @param {string} title @param {import("gpui-kit").Element} body */
  section(t, title, body) {
    return v_flex().flex_none().gap(8).py(14).border_b(1).border_color(t.border)
      .child(div().text_size(12).font_semibold().text_color(t.muted).child(title)).child(body);
  }

  /** One field with Edit when it is a single-choice field whose choices odev listed; Assignees has its own buttons. @param {Theme} t @param {string} name @param {string | string[] | null} v */
  fieldRow(t, name, v) {
    const current = Array.isArray(v) ? v.join(", ") : (v ?? "");
    const info = this.fieldInfos?.find((f) => f.name === name);
    const editable = name !== "Assignees" && info?.type === "Enumeration" && info.multiple !== true && info.choices.length > 0;
    const open = this.menu?.kind === "field" && this.menu.name === name;
    return v_flex().gap(4)
      .child(h_flex().gap(6).items_center().text_size(11).text_color(t.dim).child(div().flex_1().child(displayText(name, 40)))
        .when(editable, (e) => e.child(div().id(`onedev-w-edit-${name}`).px(4).rounded(4).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, c) => { if (!this.writing) { this.menu = open ? null : { kind: "field", name }; c.notify(); } }).child("Edit"))))
      .child(div().text_size(13).child(displayText(current, 120) || "none"))
      .when(open && info !== undefined, (e) => e.child(this.choiceList(`onedev-w-field-${name}`, t, /** @type {string[]} */ (info?.choices ?? []), current === "" ? null : current,
        (value, c) => this.write({ kind: "field", name, values: [value] }, null, c))));
  }

  /** Assign yourself and Unassign act on John's login only; the other assignees stay. @param {Theme} t @param {string | string[] | null | undefined} v */
  assignees(t, v) {
    const current = Array.isArray(v) ? v : typeof v === "string" && v !== "" ? [v] : [];
    const mine = this.me !== null && current.includes(this.me);
    return v_flex().gap(8)
      .child(div().text_size(13).child(current.length === 0 ? "No one" : displayText(current.join(", "), 120)))
      .child(h_flex().gap(8).flex_wrap()
        .when(!mine, (e) => e.child(this.button("onedev-w-assign", "Assign yourself", t, (c) => this.write({ kind: "assign", current }, null, c))))
        .when(mine, (e) => e.child(this.button("onedev-w-unassign", "Unassign", t, (c) => this.write({ kind: "unassign", current }, null, c)))));
  }

  /** @param {Theme} t @param {{ view?: IssueView, links?: Entry[] }} d @param {Cx} cx */
  sidebar(t, d, cx) {
    const none = (/** @type {string} */ s) => div().text_size(12).text_color(t.muted).child(s);
    const fields = d.view?.fields ? Object.entries(d.view.fields).filter(([name]) => name !== "Assignees") : [];
    const links = (d.links ?? []).flatMap((e) => (e.kind === "link" ? [e] : []));
    const pulls = d.view?.pulls ?? [];
    return v_flex().id("onedev-issue-sidebar").w(264).flex_none().min_h(0).overflow_y_scrollbar().pl(8).pr(24).pt(6)
      .child(this.section(t, "Fields", fields.length === 0 ? none(d.view ? "No fields" : d.error ? "Unknown" : "Loading…") : v_flex().gap(8).children(fields.map(([name, v]) => this.fieldRow(t, name, v)))))
      .child(this.section(t, "Assignees", this.assignees(t, d.view?.fields?.Assignees)))
      .child(this.section(t, "Links", links.length === 0 ? none("No links") : v_flex().gap(8).children(links.map((l, n) => {
        const ref = l.number !== null ? { project: l.project ?? this.cur.project, number: l.number } : null;
        return h_flex().id(`onedev-link-${n}`).gap(8).items_start().text_size(13).when(ref !== null, (e) => e.cursor_pointer().on_click((_ev, c) => this.go(/** @type {Ref} */ (ref), c)))
          .child(div().pt(1).child(glyph(this.icons, "link", 14, t.muted)))
          .child(v_flex().child(div().font_semibold().child(`${displayText(l.direction ?? "link", 12)} ${displayText(l.ref ?? "an issue you cannot see", 80)}`))
            .child(div().text_size(12).text_color(t.muted).child(displayText(l.title ?? "", 100))));
      }))))
      .child(this.section(t, "Pull requests", pulls.length === 0 ? none(d.view?.pulls === null ? "Unknown" : "No pull requests") : v_flex().gap(8).children(pulls.map((p) =>
        h_flex().id(`onedev-pull-${p.number}`).gap(8).items_start().text_size(13).cursor_pointer()
          .on_click(() => openUrl(`${this.verdict.host.replace(/\/+$/, "")}/${p.project ?? this.cur.project}/~pulls/${p.number}`))
          .child(div().pt(1).child(glyph(this.icons, "pull", 14, t.ansi5)))
          .child(v_flex().child(div().font_semibold().child(`#${p.number} ${displayText(p.state, 20)}`))
            .child(div().text_size(12).text_color(t.muted).child(displayText(p.title, 100))))))));
  }

  /** A list of choices under a button: the current one has a check, a pick runs `pick`. @param {string} id @param {Theme} t @param {string[]} names @param {string | null} current @param {(name: string, cx: Cx) => void} pick */
  choiceList(id, t, names, current, pick) {
    return v_flex().id(id).flex_none().p(4).gap(2).rounded(6).border_1().border_color(t.border).bg(t.raised)
      .children(names.map((name, n) => h_flex().id(`${id}-${n}`).h(28).px(8).gap(6).items_center().rounded(4).text_size(13).cursor_pointer()
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { if (!this.writing) pick(name, /** @type {Cx} */ (cx)); })
        .child(div().w(14).flex_none().text_color(t.muted).child(name === current ? "✓" : ""))
        .child(div().child(displayText(name, 60)))));
  }

  /** The comment box: Write and Preview tabs, the text area, and Comment. @param {Theme} t */
  composer(t) {
    const tab = (/** @type {"write" | "preview"} */ id, /** @type {string} */ label) => h_flex().id(`onedev-tab-${id}`).h(30).px(12).items_center().text_size(13)
      .cursor_pointer().border_b(2).border_color(this.tab === id ? t.accent : t.raised)
      .text_color(this.tab === id ? t.foreground : t.muted).font_semibold()
      .on_click((_e, cx) => { this.tab = id; this.blocks.delete("onedev-preview"); cx.notify(); })
      .child(label);
    const text = this.box.value();
    return v_flex().id("onedev-composer").flex_none().mt(16).rounded(6).border_1().border_color(t.border).bg(t.background)
      .child(h_flex().h(38).px(12).gap(4).items_center().bg(t.raised).border_b(1).border_color(t.border)
        .child(div().mr(10).text_size(13).font_semibold().text_color(t.foreground).child("Add a comment"))
        .child(tab("write", "Write")).child(tab("preview", "Preview")))
      .child(v_flex().p(12).gap(10)
        .child(this.tab === "write"
          ? div().id("onedev-box").child(Textarea.new(this.box).min_h(96))
          : div().min_h(96).text_size(14).child(this.body("onedev-preview", text, t)))
        .child(h_flex().gap(8).items_center().justify_end()
          .child(div().text_size(12).text_color(t.dim).child("Ctrl+Enter to comment"))
          .child(this.button("onedev-w-comment", "Comment", t, (c) => this.post(c)))));
  }

  /** @param {import("gpui-kit").Context} cx */
  render(cx) {
    ensureIcons(this, /** @type {Cx} */ (/** @type {unknown} */ (cx)));
    const t = colors();
    const key = this.key(this.cur);
    const d = this.data.get(key) ?? {};
    const row = this.rows.get(key) ?? null;
    const view = d.view?.issue ?? null;
    const title = view?.title ?? row?.title ?? "";
    const state = view?.state ?? row?.state ?? "";
    const loading = this.pending > 0;
    const url = issueUrl(this.verdict.host, this.cur.project, this.cur.number);
    const bar = h_flex().h(32).gap(8).items_center()
      .when(this.history.length > 0, (e) => e.child(this.button("onedev-back", "Back", t, (c) => this.back(c), "back")))
      .child(div().text_size(13).text_color(t.muted).child(displayText(this.cur.project, 80)))
      .child(div().flex_1().min_w(0).text_size(12).text_color(t.ansi1).truncate().child(this.writeError ?? d.error ?? ""))
      .when(loading, (e) => e.child(h_flex().gap(6).items_center().text_size(12).text_color(t.muted)
        .child(svg(SPINNER).size(12).text_color(t.working).spin(900)).child("Loading")))
      .when(!loading, (e) => e.child(this.button("onedev-refresh", "Refresh", t, (c) => { this.load(c); c.notify(); }, "refresh")))
      .child(this.button("onedev-copy", "Copy", t, () => openCopyMenu({ host: this.verdict.host, project: this.cur.project, number: this.cur.number, title }), "copy"))
      .child(this.button("onedev-browser", "Open in browser", t, () => openUrl(url), "external"))
      .child(this.button("onedev-close", "", t, () => closeOverlay(this.overlay), "close"));

    const tint = t[stateColorKey(row?.stateOrdinal ?? null, state)];
    const pill = state === "" ? null : h_flex().h(30).px(12).items_center().rounded(15).bg(`${tint}33`).border_1().border_color(tint)
      .text_color(t.foreground).text_size(13).font_semibold().child(displayText(state, 30));
    const pulls = d.view?.pulls ?? [];
    const stateNames = (this.states ?? []).map((x) => x.name);
    const stateMenu = this.menu?.kind === "state" && stateNames.length > 0
      ? this.choiceList("onedev-w-states", t, stateNames, state, (name, c) => { const text = this.box.value(); this.write({ kind: "transition", state: name, comment: text }, text, c); })
      : null;
    const thread = d.view ? [this.card(`onedev-body-${key}`, { actor: d.view.submitter, date: d.view.issue.updated, body: d.view.issue.description }, t, "opened this issue")] : [];
    const entries = d.entries ?? [];
    for (const [n, e] of entries.entries()) {
      thread.push(this.joint(t));
      thread.push(e.kind === "comment" ? this.card(`onedev-comment-${key}-${e.id}-${n}`, e, t) : this.event(`onedev-event-${key}-${e.id}-${n}`, e, t));
    }
    const placeholder = view || d.error ? null : div().text_color(t.muted).child(`Loading #${this.cur.number}…`);

    return v_flex().id("onedev-issue").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(14)
      .child(v_flex().flex_none().px(32).pt(14).pb(18).gap(14).border_b(1).border_color(t.border)
        .child(bar)
        .child(h_flex().flex_wrap().gap_x(8).text_size(30).line_height("38px")
          .children(displayText(title, 300).split(/\s+/).filter(Boolean).map((w) => div().child(w)))
          .child(div().text_color(t.muted).child(`#${this.cur.number}`)))
        .child(h_flex().gap(8).items_center().flex_wrap().when(pill !== null, (e) => e.child(pill))
          .children(pulls.map((p) => h_flex().h(30).px(12).gap(6).items_center().rounded(15).border_1().border_color(t.border).text_size(13).text_color(t.muted)
            .child(glyph(this.icons, "pull", 14, t.ansi5)).child(`#${p.number} ${displayText(p.state, 20)}`)))
          .when(stateNames.length > 0, (e) => e.child(this.button("onedev-w-state", "Change state", t,
            (c) => { this.menu = this.menu?.kind === "state" ? null : { kind: "state" }; c.notify(); }))))
        .when(stateMenu !== null, (e) => e.child(h_flex().child(/** @type {import("gpui-kit").Element} */ (stateMenu)))))
      .child(h_flex().flex_1().min_h(0).items_start()
        .child(v_flex().id(`onedev-thread-${key}`).flex_1().min_w(0).h_full().overflow_y_scrollbar().pl(32).pr(24).py(20)
          .when(placeholder !== null, (e) => e.child(placeholder))
          .children(thread)
          .when(view !== null, (e) => e.child(this.composer(t)))
          .child(div().flex_none().h(24)))
        .child(this.sidebar(t, d, /** @type {Cx} */ (/** @type {unknown} */ cx))));
  }
}
