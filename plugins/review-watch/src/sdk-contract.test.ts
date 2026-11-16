import { fileURLToPath } from "node:url";
import { experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";

it("uses the published SDK and declared public UI packages without reading another plugin's files", () => {
  const scan = experimental_scanPublicSdkOnly(fileURLToPath(new URL("../", import.meta.url)), { allow: [
    /^@\//,
    /^(react|react-dom)(\/|$)/,
    /^@radix-ui\/react-(hover-card|dialog|slot)$/,
    /^@hugeicons\/(react|core-free-icons)$/,
    /^@testing-library\/react$/,
    /^(class-variance-authority|clsx|tailwind-merge|vitest\/config)$/,
  ] });
  expect(scan.violations).toEqual([]);
  expect(scan.privateDependencies).toEqual([]);
});
