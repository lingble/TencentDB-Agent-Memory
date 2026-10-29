import { afterEach, describe, expect, it, vi } from "vitest";
import { initAuth, verifyUserKey } from "../auth.js";

const base = { enabled: true, url: "http://core:8420", timeoutMs: 1000 };

function mockVerify() {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ code: 0, data: { valid: true, user: { id: "usr-1" } } })),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sentHeaders(fetchMock: ReturnType<typeof mockVerify>): Record<string, string> {
  const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
  return calls[0][1].headers as Record<string, string>;
}

describe("verifyUserKey gateway Bearer", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends Authorization: Bearer when auth.apiKey is set", async () => {
    const fetchMock = mockVerify();
    initAuth({ ...base, apiKey: "gw-key" });
    await verifyUserKey("sk-mem-x", "mem-1");
    expect(sentHeaders(fetchMock)["authorization"]).toBe("Bearer gw-key");
  });

  it("sends no Authorization header when auth.apiKey is empty", async () => {
    const fetchMock = mockVerify();
    initAuth({ ...base, apiKey: "" });
    await verifyUserKey("sk-mem-x", "mem-1");
    expect(sentHeaders(fetchMock)["authorization"]).toBeUndefined();
  });
});
