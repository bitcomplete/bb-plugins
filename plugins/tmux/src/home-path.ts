import { isAbsolute, join, sep } from "node:path";

const HOME_MARK = "~";

function isInHome(path: string): boolean {
  return (
    path === HOME_MARK ||
    path.startsWith(`${HOME_MARK}/`) ||
    path.startsWith(HOME_MARK + sep)
  );
}

// A path as a person writes it for the machine of the bb server: a full
// path, or one that starts with ~ for the home directory.
export function isFullPath(path: string): boolean {
  return isInHome(path) || isAbsolute(path);
}

// A ~ at the start stands for the home directory of the user the bb server
// runs as. null for a path that is not absolute after that, and for one in a
// home directory that is not known.
export function absolutePathOf(
  path: string,
  homeDir: string | null,
): string | null {
  if (!isInHome(path)) return isAbsolute(path) ? path : null;
  if (homeDir === null) return null;
  const expanded = join(homeDir, path.slice(HOME_MARK.length));
  return isAbsolute(expanded) ? expanded : null;
}
