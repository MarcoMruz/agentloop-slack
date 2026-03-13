import { describe, it, expect } from "vitest";
import { buildHITLPrompt } from "../src/slack/blocks.js";
import type { HITLRequestEventParams } from "../src/agentloop/types.js";

/** Extract the main display text from the first section block. */
function mainText(blocks: ReturnType<typeof buildHITLPrompt>): string {
  const first = blocks[0];
  if (first.type === "section" && "text" in first && first.text) {
    return (first.text as { text: string }).text;
  }
  return "";
}

/** Minimal legacy params (no enriched fields). */
function legacyParams(overrides?: Partial<HITLRequestEventParams>): HITLRequestEventParams {
  return {
    sessionId: "sess-abc",
    requestId: "req-123",
    toolName: "📂 File Read — Outside Whitelisted Paths",
    details: "📂 File Read — Outside Whitelisted Paths",
    options: ["approve", "deny", "abort"],
    command: "📂 File Read — Outside Whitelisted Paths",
    workDir: "~/dev/project",
    rule: "confirm",
    method: "confirm",
    ...overrides,
  };
}

/** Fully enriched params. */
function enrichedParams(overrides?: Partial<HITLRequestEventParams>): HITLRequestEventParams {
  return {
    sessionId: "sess-abc",
    requestId: "req-456",
    toolName: "📂 File Read — Outside Whitelisted Paths",
    details: "Reading a file outside allowed directories",
    options: ["approve", "deny", "abort"],
    command: "/etc/passwd",
    workDir: "~/development/agentloop",
    rule: "confirm",
    method: "confirm",
    toolCategory: "file",
    filePath: "/etc/passwd",
    whitelistedPaths: [
      "~/development/agentloop",
      "~/development/agentloop-slack",
      "~/.config/agentloop",
    ],
    structuredInput: { path: "/etc/passwd", encoding: "utf-8" },
    riskLevel: "high",
    reason: "The requested path is outside all configured safe directories.",
    ...overrides,
  };
}

describe("buildHITLPrompt", () => {
  // Test 1: All new fields present
  it("renders all enriched sections in correct order when all new fields present", () => {
    const blocks = buildHITLPrompt(enrichedParams());
    const text = mainText(blocks);

    // Risk badge
    expect(text).toContain("🔴 HIGH");
    // Tool category icon + tool name
    expect(text).toContain("📂");
    expect(text).toContain("File Read");
    // Why blocked uses reason
    expect(text).toContain("The requested path is outside all configured safe directories.");
    // Requested path
    expect(text).toContain("/etc/passwd");
    // Whitelisted paths
    expect(text).toContain("Whitelisted paths (allowed):");
    expect(text).toContain("~/development/agentloop");
    // Structured input
    expect(text).toContain("path");
    expect(text).toContain("utf-8");
    // Working directory
    expect(text).toContain("~/development/agentloop");

    // Buttons still present
    expect(blocks).toHaveLength(4);
    const actions = blocks[3];
    expect(actions.type).toBe("actions");
  });

  // Test 2: toolCategory = "file" with whitelistedPaths
  it("shows whitelisted paths as bullet list for file tools", () => {
    const text = mainText(buildHITLPrompt(enrichedParams()));

    expect(text).toContain("• ~/development/agentloop");
    expect(text).toContain("• ~/development/agentloop-slack");
    expect(text).toContain("• ~/.config/agentloop");
  });

  // Test 3: toolCategory = "file" with empty whitelistedPaths
  it('shows "none configured" fallback when whitelistedPaths is empty', () => {
    const text = mainText(
      buildHITLPrompt(enrichedParams({ whitelistedPaths: [] })),
    );

    expect(text).toContain("none configured");
    expect(text).toContain("all paths require approval");
  });

  // Test 4: structuredInput with > 8 keys
  it("truncates structuredInput to 8 keys with count notice", () => {
    const input: Record<string, unknown> = {};
    for (let i = 0; i < 12; i++) {
      input[`key${i}`] = `value${i}`;
    }

    const text = mainText(
      buildHITLPrompt(enrichedParams({ structuredInput: input })),
    );

    // First 8 keys shown
    expect(text).toContain("key0");
    expect(text).toContain("key7");
    // Remaining 4 noted
    expect(text).toContain("…(4 more)");
    // key8+ not shown
    expect(text).not.toContain("key8");
  });

  // Test 5: No new fields at all (legacy event)
  it("renders legacy view when no enriched fields present", () => {
    const text = mainText(buildHITLPrompt(legacyParams()));

    // Legacy format markers
    expect(text).toContain("🔒 *Security Approval Required*");
    expect(text).toContain("🔧 *Tool:*");
    expect(text).toContain("🛡️ *Security Rule:* confirm");
    expect(text).toContain("📋 *Method:* confirm");
    expect(text).toContain("📁 *Working Directory:*");
    expect(text).toContain("Please review the above information");

    // Enriched markers absent
    expect(text).not.toContain("🔴");
    expect(text).not.toContain("Why blocked");
    expect(text).not.toContain("Whitelisted paths");
  });

  // Test 6: reason present — shown instead of rule
  it("shows reason instead of rule in Why blocked section", () => {
    const text = mainText(
      buildHITLPrompt(
        enrichedParams({ reason: "Custom block reason", rule: "some_rule" }),
      ),
    );

    expect(text).toContain("*Why blocked:* Custom block reason");
    expect(text).not.toContain("*Why blocked:* some_rule");
  });

  // Test 7: Long filePath (> 200 chars) — truncated, no crash
  it("truncates long filePath without crashing", () => {
    const longPath = "/very/long/" + "x".repeat(250) + "/file.txt";

    const blocks = buildHITLPrompt(enrichedParams({ filePath: longPath }));
    const text = mainText(blocks);

    // Should contain truncated marker
    expect(text).toContain("...[truncated]");
    // Should not contain the full path
    expect(text).not.toContain(longPath);
    // Should still render without error
    expect(blocks).toHaveLength(4);
  });

  // Test 8: whitelistedPaths with > 10 entries
  it("truncates whitelistedPaths to 10 entries with count notice", () => {
    const paths = Array.from({ length: 15 }, (_, i) => `/allowed/path${i}`);

    const text = mainText(
      buildHITLPrompt(enrichedParams({ whitelistedPaths: paths })),
    );

    // First 10 shown
    expect(text).toContain("• /allowed/path0");
    expect(text).toContain("• /allowed/path9");
    // Remaining 5 noted
    expect(text).toContain("…(5 more)");
    // path10+ not shown as bullet
    expect(text).not.toContain("• /allowed/path10");
  });
});
