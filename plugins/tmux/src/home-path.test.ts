import { describe, expect, it } from "vitest";
import { absolutePathOf, isFullPath } from "./home-path";

const IS_WINDOWS = process.platform === "win32";

describe("isFullPath", () => {
  it.each(["~", "~/", "~/dotfiles/tmux.conf"])(
    "takes %s, which starts in the home directory",
    (path) => {
      expect(isFullPath(path)).toBe(true);
    },
  );

  it.skipIf(IS_WINDOWS)("takes a path that starts at the top", () => {
    expect(isFullPath("/etc/tmux.conf")).toBe(true);
    expect(isFullPath("/")).toBe(true);
  });

  it.each([
    "tmux.conf",
    "./tmux.conf",
    "../tmux.conf",
    "dotfiles/tmux.conf",
    "~other/tmux.conf",
    "~tmux.conf",
    "$HOME/tmux.conf",
    " ~/tmux.conf",
    "",
  ])("does not take %j, which starts in no place that is known", (path) => {
    expect(isFullPath(path)).toBe(false);
  });
});

describe("absolutePathOf", () => {
  it.skipIf(IS_WINDOWS)("puts the home directory in the place of ~", () => {
    expect(absolutePathOf("~", "/home/me")).toBe("/home/me");
    expect(absolutePathOf("~/", "/home/me")).toBe("/home/me/");
    expect(absolutePathOf("~/dotfiles/tmux.conf", "/home/me")).toBe(
      "/home/me/dotfiles/tmux.conf",
    );
  });

  it.skipIf(IS_WINDOWS)("leaves a path that starts at the top as it is", () => {
    expect(absolutePathOf("/etc/tmux.conf", "/home/me")).toBe("/etc/tmux.conf");
    expect(absolutePathOf("/etc/tmux.conf", null)).toBe("/etc/tmux.conf");
  });

  it.each(["~", "~/dotfiles/tmux.conf"])(
    "has no path for %s while the home directory is not known",
    (path) => {
      expect(absolutePathOf(path, null)).toBeNull();
    },
  );

  it.each(["tmux.conf", "./tmux.conf", "~other/tmux.conf", "$HOME/tmux.conf", ""])(
    "has no path for %j, which is not absolute",
    (path) => {
      expect(absolutePathOf(path, "/home/me")).toBeNull();
    },
  );

  it("has no path for ~ in a home directory that is not absolute itself", () => {
    expect(absolutePathOf("~/tmux.conf", "relative/home")).toBeNull();
  });
});
