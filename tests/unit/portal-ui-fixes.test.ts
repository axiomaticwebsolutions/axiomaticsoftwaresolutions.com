import { describe, expect, it } from "vitest";
import { pageControlState } from "@/components/data-table/model";
import { pageTitleForPath } from "@/components/account/page-title";
import { locationIdFromSelect, locationSelectValue, UNASSIGNED_SELECT_VALUE } from "@/components/account/devices/model";
import { isClosedTypeaheadKey } from "@/components/account/row-select-keys";

describe("pagination keeps its controls' element type (focus is not dropped at the ends)", () => {
  it("makes every control a link when pages have URLs, whatever the page", () => {
    // Next on the last page: an unavailable link to the current page (was a <button>, which replaced the focused <a>).
    expect(pageControlState(3, 2, 2, true)).toEqual({ kind: "link", page: 2, disabled: true });
    expect(pageControlState(2, 1, 2, true)).toEqual({ kind: "link", page: 2, disabled: false });
    // Previous on the first page.
    expect(pageControlState(0, 1, 2, true)).toEqual({ kind: "link", page: 1, disabled: true });
    expect(pageControlState(1, 2, 2, true)).toEqual({ kind: "link", page: 1, disabled: false });
  });

  it("makes every control a button without URLs", () => {
    expect(pageControlState(4, 3, 3, false).kind).toBe("button");
    expect(pageControlState(2, 1, 3, false).kind).toBe("button");
  });

  it("keeps the numbered current page available as the current page", () => {
    expect(pageControlState(2, 2, 5, true, true)).toEqual({ kind: "link", page: 2, disabled: false });
  });
});

describe("portal loading title", () => {
  it("uses the page's own H1 for section pages", () => {
    expect(pageTitleForPath("/account")).toBe("Overview");
    expect(pageTitleForPath("/account/devices")).toBe("Devices");
    expect(pageTitleForPath("/account/orders")).toBe("Orders & invoices");
    expect(pageTitleForPath("/account/tickets")).toBe("Support tickets");
    expect(pageTitleForPath("/account/tickets/new")).toBe("New support ticket");
  });

  it("has no title for pages titled by their data or unknown paths", () => {
    expect(pageTitleForPath("/account/licenses/LIC-24017")).toBeNull();
    expect(pageTitleForPath("/account/tickets/T-1042")).toBeNull();
    expect(pageTitleForPath("/account/nope")).toBeNull();
    expect(pageTitleForPath("/admin")).toBeNull();
  });
});

describe("row selects", () => {
  it("maps Unassigned to a non-empty listbox value and back", () => {
    expect(locationSelectValue(null)).toBe(UNASSIGNED_SELECT_VALUE);
    expect(locationSelectValue("loc_1")).toBe("loc_1");
    expect(locationIdFromSelect(UNASSIGNED_SELECT_VALUE)).toBeNull();
    expect(locationIdFromSelect("")).toBeNull();
    expect(locationIdFromSelect("loc_1")).toBe("loc_1");
  });

  it("turns off typeahead on the closed trigger but keeps Space, arrows and shortcuts", () => {
    const key = (k: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey", boolean>> = {}) => ({
      key: k,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      ...mods,
    });
    expect(isClosedTypeaheadKey(key("v"))).toBe(true);
    expect(isClosedTypeaheadKey(key("K"))).toBe(true);
    expect(isClosedTypeaheadKey(key(" "))).toBe(false);
    expect(isClosedTypeaheadKey(key("ArrowDown"))).toBe(false);
    expect(isClosedTypeaheadKey(key("Enter"))).toBe(false);
    expect(isClosedTypeaheadKey(key("k", { ctrlKey: true }))).toBe(false);
  });
});
