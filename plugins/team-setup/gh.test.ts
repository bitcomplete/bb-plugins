import { describe, expect, it } from "vitest";
import { parseLoggedInAs, parseLoginPrompt } from "./gh.js";

describe("parseLoginPrompt", () => {
  it("reads the code and URL gh prints before it waits", () => {
    const lines = [
      "! First copy your one-time code: AB12-CD34",
      "Open this URL to continue in your web browser: https://github.com/login/device",
    ];
    expect(parseLoginPrompt(lines)).toEqual({ code: "AB12-CD34", url: "https://github.com/login/device" });
  });

  it("waits for both lines", () => {
    expect(parseLoginPrompt(["! First copy your one-time code: AB12-CD34"])).toBeNull();
    expect(parseLoginPrompt([])).toBeNull();
  });

  it("ignores URLs on other lines", () => {
    expect(parseLoginPrompt(["see https://cli.github.com", "! First copy your one-time code: AB12-CD34"])).toBeNull();
  });
});

describe("parseLoggedInAs", () => {
  it("finds the login gh reports", () => {
    expect(parseLoggedInAs(["✓ Authentication complete.", "✓ Logged in as octocat"])).toBe("octocat");
    expect(parseLoggedInAs(["nothing"])).toBeNull();
  });
});
