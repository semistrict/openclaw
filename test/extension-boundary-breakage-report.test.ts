import { describe, expect, it } from "vitest";
import {
  buildBoundaryBreakageReport,
  collectBoundaryBreakageReport,
  formatBoundaryBreakageReportHuman,
  main,
} from "../scripts/report-extension-boundary-breakage.mjs";
import { createCapturedIo } from "./helpers/captured-io.js";

describe("extension boundary breakage report", () => {
  it("builds a stable categorized report from collected inventories", () => {
    const report = buildBoundaryBreakageReport({
      srcOutsidePluginSdk: [
        {
          file: "extensions/xai/index.ts",
          line: 6,
          kind: "import",
          specifier: "../../../src/entry.test.ts",
          resolvedPath: "src/entry.test.ts",
          reason: "imports core src path outside plugin-sdk from an extension",
        },
      ],
      pluginSdkInternal: [
        {
          file: "extensions/slack/index.ts",
          line: 4,
          kind: "import",
          specifier: "../../../src/plugin-sdk-internal/foo.ts",
          resolvedPath: "src/plugin-sdk-internal/foo.ts",
          reason: "imports src/plugin-sdk-internal from an extension",
        },
      ],
      relativeOutsidePackage: [
        {
          file: "extensions/xai/src/runtime.ts",
          line: 12,
          kind: "import",
          specifier: "../../slack/index.ts",
          resolvedPath: "extensions/slack/index.ts",
          reason: "imports another bundled plugin via relative path outside the extension package",
        },
      ],
      corePluginImports: [
        {
          file: "src/plugins/example.ts",
          line: 14,
          kind: "import",
          specifier: "../../extensions/xai/index.ts",
          resolvedPath: "extensions/xai/index.ts",
          reason: "imports extension entrypoint from src/plugins",
        },
      ],
    });

    expect(report.summary.totalViolations).toBe(4);
    expect(report.summary.byRule).toEqual([
      {
        ruleId: "extension-src-outside-plugin-sdk",
        description: "Bundled plugin production code imports core src/** outside src/plugin-sdk/**",
        count: 1,
      },
      {
        ruleId: "extension-plugin-sdk-internal",
        description: "Bundled plugin production code imports src/plugin-sdk-internal/**",
        count: 1,
      },
      {
        ruleId: "extension-relative-outside-package",
        description:
          "Bundled plugin production code uses a relative import that escapes its own package root",
        count: 1,
      },
      {
        ruleId: "core-plugin-import",
        description: "Core plugin registry code imports bundled plugin-owned files",
        count: 1,
      },
    ]);
    expect(report.summary.bySourcePackage).toEqual([
      { key: "extensions/xai", count: 2 },
      { key: "extensions/slack", count: 1 },
      { key: "src/plugins", count: 1 },
    ]);
    expect(report.summary.byTargetPackage).toEqual([
      { key: "extensions/slack", count: 1 },
      { key: "extensions/xai", count: 1 },
      { key: "src", count: 1 },
      { key: "src/plugin-sdk-internal", count: 1 },
    ]);
    expect(report.violations.map((entry) => entry.ruleId)).toEqual([
      "core-plugin-import",
      "extension-plugin-sdk-internal",
      "extension-relative-outside-package",
      "extension-src-outside-plugin-sdk",
    ]);

    const human = formatBoundaryBreakageReportHuman(report);
    expect(human).toContain("Boundary breakage report");
    expect(human).toContain("Violations:");
  });

  it("reports the current repo state through json output", async () => {
    const report = await collectBoundaryBreakageReport();
    const captured = createCapturedIo();
    const exitCode = await main(["--json"], captured.io);

    expect(exitCode).toBe(0);
    expect(JSON.parse(captured.readStdout())).toEqual(report);
    expect(report.summary.totalViolations).toBe(0);
    expect(report.summary.byRule).toEqual([
      {
        ruleId: "extension-src-outside-plugin-sdk",
        description: "Bundled plugin production code imports core src/** outside src/plugin-sdk/**",
        count: 0,
      },
      {
        ruleId: "extension-plugin-sdk-internal",
        description: "Bundled plugin production code imports src/plugin-sdk-internal/**",
        count: 0,
      },
      {
        ruleId: "extension-relative-outside-package",
        description:
          "Bundled plugin production code uses a relative import that escapes its own package root",
        count: 0,
      },
      {
        ruleId: "core-plugin-import",
        description: "Core plugin registry code imports bundled plugin-owned files",
        count: 0,
      },
    ]);
    expect(report.violations).toEqual([]);
  });
});
