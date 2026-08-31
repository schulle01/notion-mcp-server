import { describe, it, expect } from "vitest";
import { checkAuth } from "../src/server/auth.js";

describe("checkAuth", () => {
  it("allows any request when no token is configured", () => {
    expect(checkAuth({}, undefined)).toEqual({ ok: true });
    expect(checkAuth({ authorization: "Bearer whatever" }, undefined)).toEqual({
      ok: true,
    });
  });

  it("401s when a token is required but missing", () => {
    const r = checkAuth({}, "secret");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  it("403s on a wrong token", () => {
    const r = checkAuth({ authorization: "Bearer wrong" }, "secret");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  it("accepts a correct bearer token", () => {
    expect(checkAuth({ authorization: "Bearer secret" }, "secret")).toEqual({
      ok: true,
    });
  });

  it("treats the Bearer scheme case-insensitively", () => {
    expect(checkAuth({ authorization: "bearer secret" }, "secret").ok).toBe(true);
  });

  it("401s on a malformed Authorization header (no scheme/token)", () => {
    const r = checkAuth({ authorization: "secret" }, "secret");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });
});
