import { describe, expect, it } from "vitest";
import { createApp } from "../server.js";
import { DEFAULT_CONFIG } from "../config.js";
import type { ProxyConfig } from "../types.js";

const KEY = "admin-key-for-tests-0123456789abcdef";
const withAdminKey = (apiKey: string): ProxyConfig => ({ ...DEFAULT_CONFIG, admin: { ...DEFAULT_CONFIG.admin, apiKey } });

const routes: [string, string][] = [
  ["GET", "/v3/admin/rate-limits"],
  ["PUT", "/v3/admin/rate-limits"],
  ["DELETE", "/v3/admin/rate-limits"],
  ["POST", "/v3/session/refresh-cache"],
  ["POST", "/v3/session/force-archive-skill"],
];

describe("admin and session routes", () => {
  it("answer 401 without a Bearer token or with a wrong one", async () => {
    const app = createApp(withAdminKey(KEY));
    for (const [method, path] of routes) {
      expect((await app.request(path, { method })).status, `${method} ${path} no token`).toBe(401);
      const wrong = await app.request(path, { method, headers: { authorization: "Bearer not-the-key-xxxxxxxxxxxxxxxxxxxxxxxx" } });
      expect(wrong.status, `${method} ${path} wrong token`).toBe(401);
    }
  });

  it("let the admin Bearer through to the handler", async () => {
    const app = createApp(withAdminKey(KEY));
    for (const [method, path] of routes) {
      const res = await app.request(path, { method, headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: method === "GET" ? undefined : "{}" });
      expect(res.status, `${method} ${path}`).not.toBe(401);
    }
  });

  it("stay open while admin.apiKey is empty", async () => {
    const res = await createApp(withAdminKey("")).request("/v3/session/refresh-cache", { method: "POST", body: "{}" });
    expect(res.status).not.toBe(401);
  });
});
