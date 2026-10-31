import { afterEach, describe, expect, it, vi } from "vitest";
import { checkApiRequest } from "@/proxy";
import { internalError, redact } from "@/lib/errors";

// Operational safety: cross-site protection, secrets never echoed, generic errors.

const h = (o: Record<string, string>) => new Headers(o);

describe("cross-site request protection", () => {
  it("allows same-origin JSON writes and all reads", () => {
    expect(checkApiRequest("POST", "/api/prices", h({ host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/json" }))).toBeNull();
    expect(checkApiRequest("POST", "/api/prices", h({ host: "localhost:3000", "content-type": "application/json" }))).toBeNull(); // no Origin: non-browser client
    expect(checkApiRequest("GET", "/api/prices", h({ host: "localhost:3000", origin: "https://evil.example" }))).toBeNull();
    expect(checkApiRequest("POST", "/api/monitoring/1/check", h({ host: "localhost:3000", origin: "http://localhost:3000" }))).toBeNull(); // body-less
  });
  it("rejects writes from another site", () => {
    expect(checkApiRequest("POST", "/api/prices", h({ host: "localhost:3000", origin: "https://evil.example", "content-type": "application/json" }))).toMatchObject({ status: 403 });
    expect(checkApiRequest("DELETE", "/api/trips", h({ host: "localhost:3000", origin: "http://localhost:3001" }))).toMatchObject({ status: 403 });
    expect(checkApiRequest("POST", "/api/prices", h({ host: "localhost:3000", origin: "null" }))).toMatchObject({ status: 403 });
  });
  it("rejects form-style content types an HTML form could send", () => {
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
      expect(checkApiRequest("POST", "/api/prices", h({ host: "localhost:3000", "content-type": type }))).toMatchObject({ status: 415 });
    }
  });
  it("the scheduler endpoint relies on its secret, not on browser headers", () => {
    expect(checkApiRequest("POST", "/api/monitoring/run", h({ host: "x", "content-type": "text/plain" }))).toBeNull();
    expect(checkApiRequest("POST", "/api/monitoring/run", h({ host: "x", origin: "https://evil.example" }))).toMatchObject({ status: 403 });
  });
});

describe("scheduler endpoint secret", () => {
  const saved = { secret: process.env.MONITOR_CRON_SECRET, db: process.env.DATABASE_URL };
  afterEach(() => {
    if (saved.secret === undefined) delete process.env.MONITOR_CRON_SECRET;
    else process.env.MONITOR_CRON_SECRET = saved.secret;
    if (saved.db === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved.db;
  });
  const call = async (secret?: string) => {
    const { POST } = await import("@/app/api/monitoring/run/route");
    return POST(new Request("http://x/api/monitoring/run", { method: "POST", headers: secret === undefined ? {} : { "x-monitor-secret": secret } }));
  };
  it("is disabled without a configured secret", async () => {
    delete process.env.MONITOR_CRON_SECRET;
    expect((await call("anything")).status).toBe(403);
  });
  it("rejects missing, wrong and wrong-length secrets, and never echoes the secret", async () => {
    process.env.MONITOR_CRON_SECRET = "correct-horse-battery";
    for (const s of [undefined, "", "correct-horse-batterz", "short"]) {
      const r = await call(s);
      expect(r.status).toBe(403);
      expect(await r.text()).not.toContain("correct-horse");
    }
  });
  it("accepts the right secret (then needs a database)", async () => {
    process.env.MONITOR_CRON_SECRET = "correct-horse-battery";
    delete process.env.DATABASE_URL;
    const r = await call("correct-horse-battery");
    expect(r.status).toBe(503);
    expect((await r.json()).database).toBe("not_configured");
  });
});

describe("secrets in logs and errors", () => {
  it("redacts credentials in URLs, API keys and configured secrets", () => {
    process.env.SMTP_URL = "smtps://mailer:hunter2secret@smtp.example.com:465";
    expect(redact("connect failed postgresql://dvo:s3cretpass@db:5432/dvo")).toBe("connect failed postgresql://dvo:***@db:5432/dvo");
    expect(redact("key sk-ant-abc123XYZ rejected")).toBe("key sk-ant-*** rejected");
    expect(redact(`bad url ${process.env.SMTP_URL}`)).not.toContain("hunter2secret");
    delete process.env.SMTP_URL;
  });
  it("unexpected errors reach the client as a generic message; the log is redacted", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = internalError(new Error("relation x failed for postgresql://u:topsecret@h/db"), "test");
    expect(r.status).toBe(500);
    const body = await r.json();
    expect(body.errors[0]).toMatch(/Something went wrong on the server. Nothing was changed/);
    expect(JSON.stringify(body)).not.toContain("relation");
    expect(spy.mock.calls[0]![0]).not.toContain("topsecret");
    spy.mockRestore();
  });
});
