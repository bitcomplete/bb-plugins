import { afterEach, describe, expect, it, vi } from "vitest";
import { inventoryPrPath, inventoryRoute, deckLinkStep, deckRoute, readLastView, storeLastView, viewFromSubPath, VIEW_STORAGE_KEY } from "./view-preference.js";

afterEach(() => vi.unstubAllGlobals());

describe("Workstreams view preference", () => {
  it("keeps explicit view links independent of the remembered view", () => {
    expect(viewFromSubPath("deck")).toBe("deck");
    expect(viewFromSubPath("inventory")).toBe("inventory");
    expect(viewFromSubPath("map")).toBe("map");
    expect(viewFromSubPath("efforts/details")).toBe("efforts");
    expect(viewFromSubPath("")).toBeNull();
    expect(viewFromSubPath("unknown")).toBeNull();
  });

  it("sends an old link to a removed view to the remembered view, not a blank page", () => {
    expect(["pipeline/details", "work", "board", "board-v2/details", "roster/eff-shelving/7"].map(viewFromSubPath)).toEqual([null, null, null, null, null]);
  });

  it("opens the deck on the card a thread's effort chip links to", () => {
    expect(viewFromSubPath("deck/effort-shelf-order")).toBe("deck");
    expect([deckRoute("deck/effort-shelf-order"), deckRoute(`deck/${encodeURIComponent("effort:a b")}`)]).toEqual(["effort-shelf-order", "effort:a b"]);
    expect([deckRoute("deck"), deckRoute("roster/effort-shelf-order")]).toEqual([null, null]);
  });

  // The chip links with toPluginPanel("board", { subPath: `deck/${encodeURIComponent(card)}` }). BB encodes each "/"-separated part of
  // a sub-path again for the URL, and its router decodes each part once and then turns "%2F" back into "/" for the panel's sub-path. A
  // service card's id has a "/" in it, so it reaches the panel split across two parts.
  it("opens a service card from the chip's link as BB routes it", () => {
    const routed = (subPath: string) => subPath.split("/").filter(Boolean).map(encodeURIComponent)
      .map((part) => decodeURIComponent(part).replace(/\//gu, "%2F")).join("/").replace(/%2F/gu, "/");
    const link = (card: string) => deckRoute(routed(`deck/${encodeURIComponent(card)}`));
    expect(routed(`deck/${encodeURIComponent("service:inkwell/folio")}`)).toBe("deck/service%3Ainkwell/folio");
    expect([link("service:inkwell/folio"), link("effort-shelf-order"), link("effort:a b"), link("loose")])
      .toEqual(["service:inkwell/folio", "effort-shelf-order", "effort:a b", "loose"]);
  });

  it("waits for a deck read after the link before giving up on a card, since a cached deck can predate one just made", () => {
    const deck = { ring: ["effort-shelf-order", "service:inkwell/folio"], held: ["effort-gift-cards"] };
    expect([deckLinkStep("effort-shelf-order", deck, false), deckLinkStep("service:inkwell/folio", deck, false), deckLinkStep("effort-gift-cards", deck, false)])
      .toEqual(["open", "open", "hold"]);
    expect([deckLinkStep("effort-store-pickup", deck, false), deckLinkStep("effort-store-pickup", deck, true)]).toEqual(["read", "drop"]);
  });

  it("opens the effort deck first, even over a view remembered before it existed, then remembers the last explicit view", () => {
    // The deck is the front door (plan amendment A15): the inventory, Map, or Pipeline remembered under an older key doesn't hide it.
    const values = new Map<string, string>([["bb-workstreams:last-view", "pipeline"], ["bb-workstreams:last-view-since-inventory", "inventory"]]);
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });

    expect(readLastView()).toBe("deck");
    storeLastView("map");
    expect(readLastView()).toBe("map");
    storeLastView("inventory");
    expect(readLastView()).toBe("inventory");
    storeLastView("deck");
    expect(readLastView()).toBe("deck");
    storeLastView("efforts");
    expect(values.get(VIEW_STORAGE_KEY)).toBe("efforts");
    expect(readLastView()).toBe("efforts");
    // A view remembered before Pipeline, Work, Board, and Roster were removed opens the deck.
    for (const removed of ["pipeline", "work", "board", "board-v2", "roster"]) {
      values.set(VIEW_STORAGE_KEY, removed);
      expect(readLastView()).toBe("deck");
    }
    values.set(VIEW_STORAGE_KEY, "unexpected");
    expect(readLastView()).toBe("deck");
  });

  it("keeps every view usable when browser storage is unavailable", () => {
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("Storage disabled");
      },
    });
    expect(readLastView()).toBe("deck");
    expect(() => storeLastView("map")).not.toThrow();
  });
});

describe("card to PR workbench links", () => {
  it("roundtrips exact PR keys, including BB-decoded slashes, and rejects unrelated paths", () => {
    const path = inventoryPrPath("https://github.com/inkwell/folio/pull/340");
    expect(inventoryRoute(path)).toBe("inkwell/folio#340");
    expect(inventoryRoute(path.replace(/%2F/gu, "/"))).toBe("inkwell/folio#340");
    expect(inventoryRoute("inventory/inkwell/folio#340")).toBe("inkwell/folio#340");
    expect(inventoryRoute("deck/inkwell/folio#340")).toBeNull();
    expect(inventoryRoute("inventory/%ZZ")).toBeNull();
    expect(inventoryPrPath("https://example.test/inkwell/folio/pull/340")).toBe("inventory");
  });
});
