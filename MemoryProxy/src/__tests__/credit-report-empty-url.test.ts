import { afterEach, describe, expect, it, vi } from "vitest";
import { tryReportCreditFromPath } from "../credit-reporter.js";

describe("credit report with an empty url", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does nothing instead of failing every request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = await tryReportCreditFromPath(
      { url: "", timeoutMs: 1000 },
      "/claude-code/default/v1/messages",
      { input_tokens: 5, output_tokens: 5 },
      null,
    );
    expect(out).toEqual({ attempted: false, ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
