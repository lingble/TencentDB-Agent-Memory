import { describe, expect, it } from "vitest";
import { InjectionPipeline } from "../injection/pipeline.js";
import { HookRegistryImpl } from "../injection/registry.js";
import { AnthropicAdapter } from "../injection/adapters/anthropic.js";
import { ClaudeCodeProfile } from "../injection/agents/claude-code/index.js";
import type { InjectionHook } from "../injection/types.js";

// Claude Code sends `system` as separate blocks: a standalone billing header, an identity line
// and the main prompt with a cache breakpoint. Anthropic ignores the prompt when the billing
// header is merged into one string, so an anchored injection must leave the block layout alone.
const BILLING = "x-anthropic-billing-header: cc_version=2.1.312.19a; cc_entrypoint=sdk-cli;";
const IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const MAIN = "Intro line\n# Memory\nmemory body\n# Other\nother body";

const hook: InjectionHook = {
  id: "test-anchored",
  point: "system.suffix",
  priority: 100,
  anchor: { slot: "memory", relation: "before" },
  description: "test",
  execute: async () => [{ type: "text", content: "<guide>INJECTED</guide>" }],
};

async function run(system: unknown) {
  const registry = new HookRegistryImpl();
  registry.register(hook);
  const pipeline = new InjectionPipeline(
    registry,
    new Map([["anthropic", new AnthropicAdapter()]]),
    { agentProfiles: new Map([["claude-code", new ClaudeCodeProfile()]]) },
  );
  return pipeline.process(
    { model: "m", system, messages: [{ role: "user", content: "hi" }] },
    { protocol: "anthropic", traceId: "t", keyId: "k", modelId: "m", stream: false, agentSource: "claude-code" },
  );
}

describe("anchored injection into a multi-block system", () => {
  it("keeps the block layout and cache_control, and injects into the main block", async () => {
    const out = await run([
      { type: "text", text: BILLING },
      { type: "text", text: IDENTITY, cache_control: { type: "ephemeral" } },
      { type: "text", text: MAIN, cache_control: { type: "ephemeral" } },
    ]);
    const system = out.system as { type: string; text: string; cache_control?: unknown }[];
    expect(Array.isArray(system)).toBe(true);
    expect(system).toHaveLength(3);
    expect(system[0].text).toBe(BILLING);
    expect(system[1].text).toBe(IDENTITY);
    expect(system[1].cache_control).toEqual({ type: "ephemeral" });
    expect(system[2].cache_control).toEqual({ type: "ephemeral" });
    expect(system[2].text).toContain("<guide>INJECTED</guide>");
    expect(system[2].text.indexOf("<guide>")).toBeLessThan(system[2].text.indexOf("# Memory"));
  });

  it("still injects into a plain string system", async () => {
    const out = await run(MAIN);
    expect(typeof out.system).toBe("string");
    expect(out.system as string).toContain("<guide>INJECTED</guide>");
  });
});
