import { describe, expect, it } from "vitest";
import { extractUserQueryText } from "../common/user-query-extractor.js";
import { extractLatestUserMessage } from "../tdai/recorder.js";

// Claude Code sends two harness texts as user messages that are not what the user typed: the session-title
// side-query and "Tool loaded." after a ToolSearch result. They must not reach L0.
const TITLE =
  "<session>\nTeam convention: the staging database is called citus-stg-7.\n</session>\n\n" +
  "Write the title in the predominant language of the session — a stray word or code token in another " +
  "language doesn't change it, and neither does the English of these instructions.";

describe("harness user texts", () => {
  it("drop the session-title side-query", () => {
    expect(extractUserQueryText(TITLE)).toBe("");
    expect(extractLatestUserMessage([{ role: "user", content: [{ type: "text", text: TITLE }] }])).toBeNull();
  });

  it("drop 'Tool loaded.' and keep the real prompt in front of it", () => {
    expect(extractUserQueryText("Tool loaded.")).toBe("");
    const msgs = [
      { role: "user", content: [{ type: "text", text: "Remember: our team's staging DB is citus-stg-7." }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "ToolSearch", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "" }, { type: "text", text: "Tool loaded." }] },
    ];
    expect(extractLatestUserMessage(msgs)?.content).toBe("Remember: our team's staging DB is citus-stg-7.");
  });

  it("leave real prompts alone", () => {
    expect(extractUserQueryText("Tool loaded. Now run the tests.")).toBe("Tool loaded. Now run the tests.");
    expect(extractUserQueryText("Write the title of my talk about caching.")).toBe("Write the title of my talk about caching.");
    expect(extractUserQueryText("Team convention: we deploy on Tuesdays.")).toBe("Team convention: we deploy on Tuesdays.");
  });
});
