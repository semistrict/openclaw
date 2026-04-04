#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectExtensionPluginSdkBoundaryInventory } from "./check-extension-plugin-sdk-boundary.mjs";
import { collectPluginExtensionImportBoundaryInventory } from "./check-plugin-extension-import-boundary.mjs";
import { writeLine } from "./lib/guard-inventory-utils.mjs";

const RULES = [
  {
    ruleId: "extension-src-outside-plugin-sdk",
    mode: "src-outside-plugin-sdk",
    scope: "extension",
    description: "Bundled plugin production code imports core src/** outside src/plugin-sdk/**",
  },
  {
    ruleId: "extension-plugin-sdk-internal",
    mode: "plugin-sdk-internal",
    scope: "extension",
    description: "Bundled plugin production code imports src/plugin-sdk-internal/**",
  },
  {
    ruleId: "extension-relative-outside-package",
    mode: "relative-outside-package",
    scope: "extension",
    description:
      "Bundled plugin production code uses a relative import that escapes its own package root",
  },
  {
    ruleId: "core-plugin-import",
    scope: "core",
    description: "Core plugin registry code imports bundled plugin-owned files",
  },
];

function compareCounts(left, right) {
  return right.count - left.count || left.key.localeCompare(right.key);
}

function compareViolations(left, right) {
  return (
    left.ruleId.localeCompare(right.ruleId) ||
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.kind.localeCompare(right.kind) ||
    left.specifier.localeCompare(right.specifier) ||
    left.resolvedPath.localeCompare(right.resolvedPath) ||
    left.reason.localeCompare(right.reason)
  );
}

function classifyPackageRoot(repoPath) {
  if (typeof repoPath !== "string" || repoPath.length === 0) {
    return null;
  }
  const segments = repoPath.split("/");
  if (segments[0] === "extensions" && segments[1]) {
    return `${segments[0]}/${segments[1]}`;
  }
  if (segments[0] === "src" && segments[1]) {
    if (segments.length === 2 || !segments[2]) {
      return "src";
    }
    return `${segments[0]}/${segments[1]}`;
  }
  return segments[0] ?? null;
}

function classifyPackageName(packageRoot) {
  if (!packageRoot) {
    return null;
  }
  const segments = packageRoot.split("/");
  return segments.at(-1) ?? null;
}

function toCountEntries(counts) {
  return [...counts.entries()].map(([key, count]) => ({ key, count })).toSorted(compareCounts);
}

function summarizeViolations(violations) {
  const byRule = new Map();
  const bySourcePackage = new Map();
  const byTargetPackage = new Map();

  for (const violation of violations) {
    byRule.set(violation.ruleId, (byRule.get(violation.ruleId) ?? 0) + 1);
    if (violation.sourcePackageRoot) {
      bySourcePackage.set(
        violation.sourcePackageRoot,
        (bySourcePackage.get(violation.sourcePackageRoot) ?? 0) + 1,
      );
    }
    if (violation.targetPackageRoot) {
      byTargetPackage.set(
        violation.targetPackageRoot,
        (byTargetPackage.get(violation.targetPackageRoot) ?? 0) + 1,
      );
    }
  }

  return {
    totalViolations: violations.length,
    byRule: RULES.map(({ ruleId, description }) => ({
      ruleId,
      description,
      count: byRule.get(ruleId) ?? 0,
    })),
    bySourcePackage: toCountEntries(bySourcePackage),
    byTargetPackage: toCountEntries(byTargetPackage),
  };
}

function normalizeViolation(rule, entry) {
  const sourcePackageRoot = classifyPackageRoot(entry.file);
  const targetPackageRoot = classifyPackageRoot(entry.resolvedPath);
  return {
    ruleId: rule.ruleId,
    scope: rule.scope,
    description: rule.description,
    sourcePackageRoot,
    sourcePackageName: classifyPackageName(sourcePackageRoot),
    targetPackageRoot,
    targetPackageName: classifyPackageName(targetPackageRoot),
    file: entry.file,
    line: entry.line,
    kind: entry.kind,
    specifier: entry.specifier,
    resolvedPath: entry.resolvedPath,
    reason: entry.reason,
  };
}

export function buildBoundaryBreakageReport({
  srcOutsidePluginSdk,
  pluginSdkInternal,
  relativeOutsidePackage,
  corePluginImports,
}) {
  const violations = [
    ...srcOutsidePluginSdk.map((entry) => normalizeViolation(RULES[0], entry)),
    ...pluginSdkInternal.map((entry) => normalizeViolation(RULES[1], entry)),
    ...relativeOutsidePackage.map((entry) => normalizeViolation(RULES[2], entry)),
    ...corePluginImports.map((entry) => normalizeViolation(RULES[3], entry)),
  ].toSorted(compareViolations);

  return {
    summary: summarizeViolations(violations),
    violations,
  };
}

export function formatBoundaryBreakageReportHuman(report) {
  const lines = ["Boundary breakage report", "Rule counts:"];
  for (const entry of report.summary.byRule) {
    lines.push(`- ${entry.ruleId}: ${entry.count}`);
  }

  if (report.violations.length === 0) {
    lines.push("No boundary violations found.");
    return lines.join("\n");
  }

  if (report.summary.bySourcePackage.length > 0) {
    lines.push("Source packages:");
    for (const entry of report.summary.bySourcePackage) {
      lines.push(`- ${entry.key}: ${entry.count}`);
    }
  }

  lines.push("Violations:");
  let activeRuleId = "";
  for (const violation of report.violations) {
    if (violation.ruleId !== activeRuleId) {
      activeRuleId = violation.ruleId;
      lines.push(activeRuleId);
    }
    lines.push(`  - ${violation.file}:${violation.line} [${violation.kind}] ${violation.reason}`);
    lines.push(`    specifier: ${violation.specifier}`);
    lines.push(`    resolved: ${violation.resolvedPath}`);
  }
  return lines.join("\n");
}

export async function collectBoundaryBreakageReport() {
  const [srcOutsidePluginSdk, pluginSdkInternal, relativeOutsidePackage, corePluginImports] =
    await Promise.all([
      collectExtensionPluginSdkBoundaryInventory("src-outside-plugin-sdk"),
      collectExtensionPluginSdkBoundaryInventory("plugin-sdk-internal"),
      collectExtensionPluginSdkBoundaryInventory("relative-outside-package"),
      collectPluginExtensionImportBoundaryInventory(),
    ]);

  return buildBoundaryBreakageReport({
    srcOutsidePluginSdk,
    pluginSdkInternal,
    relativeOutsidePackage,
    corePluginImports,
  });
}

export async function main(argv = process.argv.slice(2), io) {
  const json = argv.includes("--json");
  const report = await collectBoundaryBreakageReport();
  const streams = io ?? { stdout: process.stdout };

  if (json) {
    writeLine(streams.stdout, JSON.stringify(report, null, 2));
    return 0;
  }

  writeLine(streams.stdout, formatBoundaryBreakageReportHuman(report));
  return 0;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main();
}
