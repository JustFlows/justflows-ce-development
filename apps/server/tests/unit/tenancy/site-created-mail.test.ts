// SPDX-License-Identifier: MIT
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  send: vi.fn(async () => ({ ok: true })),
  audit: vi.fn(async () => undefined),
  adminUrl: vi.fn(async (_siteId: string, origin: string): Promise<string | null> => `${origin}/admin/login`),
}));
vi.mock("../../../src/lib/email/mail.js", () => ({ sendTemplateMail: mocks.send }));
vi.mock("../../../src/lib/security/audit-log.js", () => ({ auditLog: mocks.audit }));
vi.mock("../../../src/lib/settings/site-settings.js", () => ({ getSiteId: async () => "root" }));
vi.mock("../../../src/lib/tenancy/find-sites.js", () => ({ adminSignInUrl: mocks.adminUrl }));
const { sendSiteCreatedMail } = await import("../../../src/lib/tenancy/site-created-mail.js");
const input = { siteId: "s1", siteName: "Dirks\nTest", siteUrl: "https://dirkstest.justflows.com/", email: " Owner@Example.com ", displayName: "Owner" };
beforeEach(() => {
  mocks.send.mockClear();
  mocks.audit.mockClear();
  mocks.adminUrl.mockClear();
});
it("mails the owner the site, admin sign-in address and sign-in email, never a password", async () => {
  await sendSiteCreatedMail(input);
  expect(mocks.send).toHaveBeenCalledWith({
    to: "owner@example.com",
    key: "core.site-created",
    values: {
      display_name: "Owner",
      new_site_name: "Dirks Test",
      site_url: "https://dirkstest.justflows.com",
      admin_url: "https://dirkstest.justflows.com/admin/login",
      login_email: "owner@example.com",
    },
  });
  expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ siteId: "root", action: "workspace.created_mail", outcome: "success" }));
});
it("falls back to the default admin path when the site's path cannot be read", async () => {
  mocks.adminUrl.mockResolvedValueOnce(null);
  await sendSiteCreatedMail(input);
  expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ values: expect.objectContaining({ admin_url: "https://dirkstest.justflows.com/admin/login" }) }));
});
it("audits a failed send and does not throw", async () => {
  mocks.send.mockResolvedValueOnce({ ok: false, error: "No mail transport" } as never);
  await expect(sendSiteCreatedMail(input)).resolves.toBeUndefined();
  expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failure" }));
});
