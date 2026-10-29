import { describe, expect, it } from "vitest";
import {
  EXTRACT_MEMORIES_SYSTEM_PROMPT,
  EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT,
  formatExtractionPrompt,
} from "./l1-extraction.js";
import {
  CONFLICT_DETECTION_SYSTEM_PROMPT,
  WORK_CONFLICT_DETECTION_SYSTEM_PROMPT,
  formatBatchConflictPrompt,
} from "./l1-dedup.js";
import { composeMemorySystemPrompt } from "../memory-prompt/composer.js";

// The L1 prompts used to be Chinese. The models followed their Chinese examples and wrote English
// conversations up as Chinese memories, despite the "same language as the input" instruction.
const CJK = /[　-〿一-鿿＀-￯]/;

describe("L1 prompts are English", () => {
  it("contain no Chinese in the system prompts", () => {
    for (const p of [
      EXTRACT_MEMORIES_SYSTEM_PROMPT,
      EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT,
      CONFLICT_DETECTION_SYSTEM_PROMPT,
      WORK_CONFLICT_DETECTION_SYSTEM_PROMPT,
    ]) {
      expect(p).not.toMatch(CJK);
    }
  });

  it("keep the output contract the parsers rely on", () => {
    for (const p of [EXTRACT_MEMORIES_SYSTEM_PROMPT, EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT]) {
      for (const field of ["scene_name", "message_ids", "memories", "source_message_ids", "metadata", "priority"]) {
        expect(p).toContain(`"${field}"`);
      }
    }
    expect(EXTRACT_MEMORIES_SYSTEM_PROMPT).toContain("persona|episodic|instruction");
    expect(EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT).toContain("work_fact|work_task|work_method|work_artifact");
    for (const p of [CONFLICT_DETECTION_SYSTEM_PROMPT, WORK_CONFLICT_DETECTION_SYSTEM_PROMPT]) {
      for (const field of ["record_id", "action", "target_ids", "merged_content", "merged_type", "merged_priority", "merged_timestamps"]) {
        expect(p).toContain(`"${field}"`);
      }
      expect(p).toContain("store|update|skip|merge");
    }
  });

  it("build English user prompts", () => {
    const extraction = formatExtractionPrompt({
      newMessages: [{ id: "m1", role: "user", content: "Deploys happen on Tuesdays", timestamp: 0 } as never],
    });
    expect(extraction).not.toMatch(CJK);
    expect(extraction).toContain("[Previous scene]: None");

    const dedup = formatBatchConflictPrompt([]);
    expect(dedup).not.toMatch(CJK);
  });

  it("append an English guard to a custom strategy", () => {
    for (const layer of ["l1", "l2", "l3"] as const) {
      const out = composeMemorySystemPrompt("base", {
        source: "agent",
        prompt: "focus on deploys",
        memory_prompt_id: "p",
        version: 1,
        layer,
      } as never);
      expect(out).not.toMatch(CJK);
      expect(out).toContain("system constraints win");
    }
  });
});
