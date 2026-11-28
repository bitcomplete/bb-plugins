// The look of bb's own buttons and text fields, in the classes of bb's theme,
// so that they follow the light and the dark theme and a custom palette.
const BUTTON =
  "inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 aria-disabled:cursor-default aria-disabled:opacity-50";

export const OUTLINE_BUTTON = `${BUTTON} border border-input bg-transparent hover:bg-state-hover hover:text-foreground`;

export const PRIMARY_BUTTON = `${BUTTON} bg-foreground text-background hover:bg-foreground/90`;

// On a phone the text is larger, as in bb's own fields: a smaller one makes
// the browser zoom in when the field takes the cursor.
export const TEXT_FIELD =
  "h-8 w-full min-w-0 rounded-md border border-input bg-transparent px-3 font-mono text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring max-md:pointer-coarse:text-base";
