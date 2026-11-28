export const THREAD_ORDER_MODES = ["sidebar", "recent"] as const;
export type ThreadOrderMode = (typeof THREAD_ORDER_MODES)[number];

// auto follows the mouse option of tmux.
export const COPY_ON_SELECT_MODES = ["auto", "on", "off"] as const;
export type CopyOnSelectMode = (typeof COPY_ON_SELECT_MODES)[number];

// The labels of the settings that a notice or the key help names, and the
// title of the settings section in which the config file is chosen.
export const ENABLED_LABEL = "Enable tmux keys";
export const CONFIG_FILE_LABEL = "Config file";
export const CONFIG_TEXT_LABEL = "Config text";

// What the lines of the Config text setting are reported under, where a file
// is reported under its path.
export const CONFIG_TEXT_NAME = `the ${CONFIG_TEXT_LABEL} setting`;

// The realtime channel on which the server part tells every bb window that
// another config file was chosen. The signal carries nothing: a window asks
// the server for what it needs.
export const CONFIG_FILE_CHANGED = "config-file-changed";

// tmuxConfigText is read by the server part. The page only looks at it to
// ask the server again when it changes. The chosen config file is no setting:
// the server part keeps it in the plugin's storage.
export interface Settings {
  enabled: boolean;
  tmuxConfigText: string;
  threadOrder: ThreadOrderMode;
  scrollStepPx: number;
  copyOnSelect: CopyOnSelectMode;
  resizeCellPx: number;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: false,
  tmuxConfigText: "",
  threadOrder: "sidebar",
  scrollStepPx: 80,
  copyOnSelect: "auto",
  resizeCellPx: 10,
};

// The smallest and the largest value of each number setting. A value outside
// them counts as the nearest one.
export const NUMBER_RANGES = {
  scrollStepPx: { min: 10, max: 2000 },
  resizeCellPx: { min: 1, max: 100 },
} as const;

type NumberSetting = keyof typeof NUMBER_RANGES;

type SettingValues = Record<string, string | number | boolean> | undefined;

function readBoolean(values: SettingValues, key: keyof Settings): boolean {
  const value = values?.[key];
  return typeof value === "boolean" ? value : (DEFAULT_SETTINGS[key] as boolean);
}

// The text is kept as it was written, because it can be long and nothing here
// reads it.
function readText(values: SettingValues, key: keyof Settings): string {
  const value = values?.[key];
  return typeof value === "string" ? value : (DEFAULT_SETTINGS[key] as string);
}

function readNumber(values: SettingValues, key: NumberSetting): number {
  const value = values?.[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_SETTINGS[key];
  }
  const { min, max } = NUMBER_RANGES[key];
  return Math.min(max, Math.max(min, value));
}

function readOption<T extends string>(
  values: SettingValues,
  key: keyof Settings,
  options: readonly T[],
): T {
  const value = values?.[key];
  const match = options.find((option) => option === value);
  return match ?? (DEFAULT_SETTINGS[key] as T);
}

export function parseSettings(values: SettingValues): Settings {
  return {
    enabled: readBoolean(values, "enabled"),
    tmuxConfigText: readText(values, "tmuxConfigText"),
    threadOrder: readOption(values, "threadOrder", THREAD_ORDER_MODES),
    scrollStepPx: readNumber(values, "scrollStepPx"),
    copyOnSelect: readOption(values, "copyOnSelect", COPY_ON_SELECT_MODES),
    resizeCellPx: readNumber(values, "resizeCellPx"),
  };
}
