// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from "vitest";

const runs: Array<{ sql: string; params: unknown[] }> = [];
const users: Record<string, { id: string; email: string; display_name: string; role: string; username: string }> = {
  "user-1": { id: "user-1", email: "sam@example.com", display_name: "Sam", role: "bookings-staff", username: "sam" },
};
const sendTemplateMail = vi.fn(async (_input: { to: string; key: string; values: Record<string, string> }) => ({ ok: true as const }));
const auditLog = vi.fn();

vi.mock("../../../src/lib/database/db.js", () => ({
  getDb: async () => ({
    query: async (_sql: string, params: unknown[]) => (users[String(params[0])] ? [users[String(params[0])]] : []),
    run: async (sql: string, params: unknown[] = []) => void runs.push({ sql, params }),
  }),
}));
const domain = vi.hoisted(() => ({ origin: null as string | null }));
vi.mock("../../../src/lib/email/email-asset-url.js", () => ({ primarySiteOrigin: async () => domain.origin }));
vi.mock("../../../src/lib/email/mail.js", () => ({ sendTemplateMail }));
vi.mock("../../../src/lib/security/audit-log.js", () => ({ auditLog }));
vi.mock("../../../src/lib/auth/auth-surface.js", () => ({
  accountSurface: async () => "admin",
  authPagePath: async (surface: string, page: string) => (surface === "admin" ? `/studio-admin/${page}` : `/${page}`),
}));

const { sendPasswordSetup, PASSWORD_SETUP_TTL_MINUTES } = await import("../../../src/lib/auth/password-reset.js");

beforeEach(() => {
  runs.length = 0;
  domain.origin = null;
  sendTemplateMail.mockClear();
  auditLog.mockClear();
});

describe("sendPasswordSetup", () => {
  it("mails a three-day link on the account's own sign-in surface and audits it", async () => {
    const before = Date.now();
    const result = await sendPasswordSetup("site-1", "user-1", { userId: "admin", role: "administrator" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expires = Date.parse(result.expiresAt) - before;
    expect(expires).toBeGreaterThanOrEqual(PASSWORD_SETUP_TTL_MINUTES * 60_000 - 1000);
    expect(expires).toBeLessThanOrEqual(PASSWORD_SETUP_TTL_MINUTES * 60_000 + 5000);
    const mail = sendTemplateMail.mock.calls[0]![0];
    expect(mail).toMatchObject({ to: "sam@example.com", key: "core.account-invite", values: { username: "sam", expiration: "3 days" } });
    expect(mail.values["action_url"]).toMatch(/\/studio-admin\/reset-password\?token=[A-Za-z0-9_-]+$/);
    /** The earlier link is replaced, and only the token's hash is stored. */
    expect(runs[0]!.sql).toMatch(/^DELETE FROM password_resets/);
    const token = new URL(mail.values["action_url"]!, "https://x").searchParams.get("token")!;
    expect(JSON.stringify(runs)).not.toContain(token);
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "auth.password_setup_sent", outcome: "success", target: "user-1", actorId: "admin" }));
  });

  it("opens the link on the site's own domain", async () => {
    domain.origin = "https://studio.example.com";
    await sendPasswordSetup("site-1", "user-1", { userId: "admin", role: "administrator" });
    expect(sendTemplateMail.mock.calls[0]![0].values["action_url"]).toMatch(/^https:\/\/studio\.example\.com\/studio-admin\/reset-password\?token=/);
  });

  it("refuses an unknown user and reports a failed send", async () => {
    expect(await sendPasswordSetup("site-1", "nobody", { userId: "admin", role: "administrator" })).toMatchObject({ ok: false, status: 404 });
    sendTemplateMail.mockResolvedValueOnce({ ok: false, error: "smtp down" } as never);
    expect(await sendPasswordSetup("site-1", "user-1", { userId: "admin", role: "administrator" })).toMatchObject({ ok: false, status: 502 });
    expect(auditLog).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: "failure" }));
  });
});
