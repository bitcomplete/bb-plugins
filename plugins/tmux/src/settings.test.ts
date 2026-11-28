import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, NUMBER_RANGES, parseSettings } from "./settings";

describe("parseSettings", () => {
  it("returns the defaults while bb is still loading the values", () => {
    expect(parseSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it("has exactly the six settings, with these defaults", () => {
    expect(DEFAULT_SETTINGS).toEqual({
      enabled: false,
      tmuxConfigText: "",
      threadOrder: "sidebar",
      scrollStepPx: 80,
      copyOnSelect: "auto",
      resizeCellPx: 10,
    });
  });

  it("is switched off until bb reports that it was switched on", () => {
    expect(DEFAULT_SETTINGS.enabled).toBe(false);
    expect(parseSettings(undefined).enabled).toBe(false);
    expect(parseSettings({}).enabled).toBe(false);
    expect(parseSettings({ enabled: true }).enabled).toBe(true);
  });

  it.each(["true", "on", 1, 0])(
    "takes an enabled of %j, which is no switch, for off",
    (enabled) => {
      expect(parseSettings({ enabled }).enabled).toBe(false);
    },
  );

  it("keeps valid values and falls back for invalid ones", () => {
    const settings = parseSettings({
      enabled: true,
      threadOrder: "nonsense",
      scrollStepPx: 999999,
      copyOnSelect: "no",
    });
    expect(settings.enabled).toBe(true);
    expect(settings.threadOrder).toBe(DEFAULT_SETTINGS.threadOrder);
    expect(settings.scrollStepPx).toBe(2000);
    expect(settings.copyOnSelect).toBe(DEFAULT_SETTINGS.copyOnSelect);
  });

  it("reads every setting that is left", () => {
    const values = {
      enabled: true,
      tmuxConfigText: "bind -r H resize-pane -L 5\nbind -r L resize-pane -R 5\n",
      threadOrder: "recent",
      scrollStepPx: 120,
      copyOnSelect: "off",
      resizeCellPx: 8,
    };
    expect(parseSettings(values)).toEqual(values);
  });

  it("drops the values of settings it does not define", () => {
    const settings = parseSettings({
      unknownText: ",",
      unknownChoice: "everywhere",
      unknownNumber: 400,
      unknownFlag: true,
    });
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  it("has no setting for how long the prefix waits, which the prefix-timeout of the tmux config says", () => {
    expect(parseSettings({ prefixTimeoutMs: 500 })).toEqual(DEFAULT_SETTINGS);
  });

  it.each(["ctrl+x", "C-x", "f12", "auto", "nonsense"])(
    "has no setting for the prefix, which the tmux config says, so a prefixKey of %j that bb still has stored changes nothing",
    (prefixKey) => {
      const settings = parseSettings({ prefixKey });

      expect(settings).toEqual(DEFAULT_SETTINGS);
      expect(settings).not.toHaveProperty("prefixKey");
    },
  );

  it("names the range of each number setting, which holds its default", () => {
    expect(NUMBER_RANGES).toEqual({
      scrollStepPx: { min: 10, max: 2000 },
      resizeCellPx: { min: 1, max: 100 },
    });
  });

  it.each([
    [10, 10],
    [80, 80],
    [2000, 2000],
    [9, 10],
    [0, 10],
    [2001, 2000],
  ])("reads a scrollStepPx of %d as %d", (value, expected) => {
    expect(parseSettings({ scrollStepPx: value }).scrollStepPx).toBe(expected);
  });

  it("holds no config text by default", () => {
    expect(parseSettings({}).tmuxConfigText).toBe("");
  });

  it.each(["~/dotfiles/tmux.conf", "/made/up/tmux.conf", "", 5])(
    "has no setting for the config file, which is chosen in the settings section and kept by the server part, so a tmuxConfigPath of %j that bb still has stored changes nothing",
    (tmuxConfigPath) => {
      const settings = parseSettings({ tmuxConfigPath });

      expect(settings).toEqual(DEFAULT_SETTINGS);
      expect(settings).not.toHaveProperty("tmuxConfigPath");
    },
  );

  it("keeps the config text as it was written, with its blanks and line breaks", () => {
    const text = "\n  bind g kill-pane  \n\n";

    expect(parseSettings({ tmuxConfigText: text }).tmuxConfigText).toBe(text);
  });

  it.each([5, true])("reads a config text of %j as empty", (value) => {
    expect(parseSettings({ tmuxConfigText: value }).tmuxConfigText).toBe("");
  });

  it("follows tmux's mouse option for copy on select by default", () => {
    expect(DEFAULT_SETTINGS.copyOnSelect).toBe("auto");
    expect(parseSettings({}).copyOnSelect).toBe("auto");
  });

  it.each(["auto", "on", "off"] as const)(
    "keeps the copyOnSelect choice %s",
    (copyOnSelect) => {
      expect(parseSettings({ copyOnSelect }).copyOnSelect).toBe(copyOnSelect);
    },
  );

  it.each(["yes", "ON", "", 1])("reads a copyOnSelect of %j as auto", (copyOnSelect) => {
    expect(parseSettings({ copyOnSelect }).copyOnSelect).toBe("auto");
  });

  it.each([true, false])(
    "reads a copyOnSelect of %j as auto, like any value that is not one of the choices",
    (copyOnSelect) => {
      expect(parseSettings({ copyOnSelect }).copyOnSelect).toBe("auto");
    },
  );

  it("takes one cell of tmux's resize-pane for 10 pixels by default", () => {
    expect(DEFAULT_SETTINGS.resizeCellPx).toBe(10);
    expect(parseSettings({}).resizeCellPx).toBe(10);
  });

  it.each([
    [1, 1],
    [10, 10],
    [100, 100],
    [0, 1],
    [-48, 1],
    [101, 100],
    [999999, 100],
  ])("reads a resizeCellPx of %d as %d", (value, expected) => {
    expect(parseSettings({ resizeCellPx: value }).resizeCellPx).toBe(expected);
  });

  it.each(["64", true, Number.NaN, Number.POSITIVE_INFINITY])(
    "falls back to the default when resizeCellPx is %j",
    (value) => {
      expect(parseSettings({ resizeCellPx: value }).resizeCellPx).toBe(
        DEFAULT_SETTINGS.resizeCellPx,
      );
    },
  );
});
