// The display's page layout as the app edits it: every page, in swipe order, each on or off. Only the enabled
// ones go to the device (LAYOUT). Platform-free.
import { Page } from './proto';

export interface PageSetting {
  page: Page;
  on: boolean;
}

export const ALL_PAGES: Page[] = [Page.NAV, Page.ENGINE, Page.MEDIA, Page.STATUS, Page.SETTINGS];

export const DEFAULT_PAGES: PageSetting[] = ALL_PAGES.map((page) => ({ page, on: true }));

/**
 * Repair a saved list: drop unknown ids and repeats, append pages added since it was saved (enabled), and keep Nav
 * on: the device always shows it, as the home page taps return to.
 */
export function normalizePages(saved: unknown): PageSetting[] {
  const out: PageSetting[] = [];
  if (Array.isArray(saved)) {
    for (const s of saved as Partial<PageSetting>[]) {
      if (s && ALL_PAGES.includes(s.page as Page) && !out.some((o) => o.page === s.page)) {
        out.push({ page: s.page as Page, on: s.on !== false });
      }
    }
  }
  for (const page of ALL_PAGES) if (!out.some((o) => o.page === page)) out.push({ page, on: true });
  return out.map((s) => (s.page === Page.NAV ? { ...s, on: true } : s));
}

/** Swap a page with its neighbour; out of range is a no-op. */
export function movePage(pages: PageSetting[], index: number, dir: -1 | 1): PageSetting[] {
  const to = index + dir;
  if (index < 0 || index >= pages.length || to < 0 || to >= pages.length) return pages;
  const next = pages.slice();
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

/** Switch a page on or off. Nav can't be switched off. */
export function setPageOn(pages: PageSetting[], page: Page, on: boolean): PageSetting[] {
  if (page === Page.NAV) return pages;
  return pages.map((s) => (s.page === page ? { ...s, on } : s));
}

/** What the device shows, left to right. */
export const shownPages = (pages: PageSetting[]): Page[] => pages.filter((s) => s.on).map((s) => s.page);
