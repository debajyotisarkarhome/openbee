import { DEFAULT_PAGES, movePage, normalizePages, setPageOn, shownPages } from '../layout';
import { Page } from '../proto';

describe('page layout', () => {
  it('defaults to every page, in the device order', () => {
    expect(shownPages(DEFAULT_PAGES)).toEqual([Page.NAV, Page.ENGINE, Page.MEDIA, Page.STATUS, Page.SETTINGS]);
  });

  it('repairs saved lists: junk, repeats, new pages, Nav forced on', () => {
    const saved = [
      { page: Page.STATUS, on: false },
      { page: 42, on: true },
      { page: Page.NAV, on: false },
      { page: Page.STATUS, on: true },
    ];
    expect(normalizePages(saved)).toEqual([
      { page: Page.STATUS, on: false },
      { page: Page.NAV, on: true },
      { page: Page.ENGINE, on: true },
      { page: Page.MEDIA, on: true },
      { page: Page.SETTINGS, on: true },
    ]);
    expect(normalizePages(undefined)).toEqual(DEFAULT_PAGES);
    expect(normalizePages('garbage')).toEqual(DEFAULT_PAGES);
  });

  it('reorders and toggles, sending only enabled pages in order', () => {
    let p = movePage(DEFAULT_PAGES, 3, -1); // Status before Media
    p = movePage(p, 0, -1); // already first: no-op
    p = setPageOn(p, Page.ENGINE, false);
    p = setPageOn(p, Page.NAV, false); // refused
    expect(shownPages(p)).toEqual([Page.NAV, Page.STATUS, Page.MEDIA, Page.SETTINGS]);
    expect(movePage(p, 4, 1)).toBe(p);
  });
});
