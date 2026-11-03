import * as fs from "fs/promises";
import { appHome } from "herdr";

const SVG = (/** @type {string} */ paths) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

const ICONS = {
  issue: SVG(`<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="1"/>`),
  refresh: SVG(`<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>`),
  back: SVG(`<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>`),
  pull: SVG(`<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" x2="6" y1="9" y2="21"/>`),
  copy: SVG(`<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>`),
  close: SVG(`<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`),
  link: SVG(`<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>`),
  external: SVG(`<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>`),
  pencil: SVG(`<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>`),
  tag: SVG(`<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>`),
};

/** @type {Promise<void> | null} */
let written = null;

/** Herdr draws images only from real folders, and this mod's folder may be a symlink to its checkout. */
export function icons() {
  written ??= (async () => {
    const dir = `${appHome()}/data/onedev-issues/icons`;
    await fs.mkdir(dir, { recursive: true });
    for (const [name, text] of Object.entries(ICONS)) await fs.writeFile(`${dir}/${name}.svg`, text);
  })().catch((e) => {
    written = null;
    throw e;
  });
  return written;
}

export const icon = (/** @type {string} */ name) => `data/onedev-issues/icons/${name}.svg`;

const ICON_RETRY_MS = 30_000;

/** A copy draws its icons once they are written, and retries a failed write at most every 30 s. @param {{ icons: boolean, iconsTried: number }} copy @param {import("gpui-kit").AsyncContext} cx */
export function ensureIcons(copy, cx) {
  const at = Date.now();
  if (copy.icons || at - copy.iconsTried < ICON_RETRY_MS) return;
  copy.iconsTried = at;
  cx.spawn(async (cx) => {
    try {
      await icons();
    } catch {
      return;
    }
    copy.icons = true;
    cx.notify();
  });
}
