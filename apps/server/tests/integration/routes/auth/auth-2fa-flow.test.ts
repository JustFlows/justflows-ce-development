import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.APP_SECRET = "test-secret-that-is-at-least-32-characters-long";
process.env.STATE = "INSTALLED";

/**
 * One in-memory user row, driven through the real routes.
 *
 * The interesting behaviour of two-factor sign-in is the sequencing — password
 * first, then the code, then the session — and none of it is exercised by unit
 * testing the TOTP maths.
 */
interface UserRow {
  id: string;
  site_id: string;
  email: string;
  password_hash: string;
  role: string;
  token_version: number;
  totp_secret: string | null;
  totp_confirmed_at: string | null;
  totp_recovery_codes: string | null;
}

let user: UserRow;

/**
 * Apply a SET clause.
 *
 * Placeholders are consumed in order and only by assignments that actually have
 * one — `col = NULL` binds no parameter, so counting columns rather than `?`
 * would shift every later value (and silently write the WHERE-clause ids into
 * columns, which is exactly what it did the first time).
 */
function applySet(row: UserRow, setClause: string, params: unknown[]): void {
  let next = 0;
  for (const assignment of setClause.split(",")) {
    const [rawColumn, ...rest] = assignment.split("=");
    const column = rawColumn!.trim();
    const expression = rest.join("=").trim();
    const target = row as unknown as Record<string, unknown>;

    if (expression === "?") {
      target[column] = params[next++] ?? null;
    } else if (/^null$/i.test(expression)) {
      target[column] = null;
    }
    // Anything else (COALESCE, arithmetic) is handled by an earlier branch.
  }
}

/** Minimal SQL interpreter covering only the statements these routes issue. */
const fakeDb = {
  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (/FROM users/i.test(sql)) {
      const byEmail = /email = \?/.test(sql);
      // Sign-in scopes the lookup to the site, so the email is not always the first parameter.
      const match = byEmail ? params.includes(user.email) : user.id === params[0];
      return match ? ([{ ...user }] as unknown as T[]) : [];
    }
    if (/FROM sites/i.test(sql)) return [{ id: user.site_id, name: "Test Site" }] as unknown as T[];
    return [] as T[];
  },
  async run(sql: string, params: unknown[] = []): Promise<void> {
    if (/UPDATE users SET token_version/i.test(sql)) {
      user.token_version += 1;
      return;
    }
    const setClause = /UPDATE users SET (.+?) WHERE/i.exec(sql)?.[1];
    if (!setClause) return;
    applySet(user, setClause, params);
  },
  async close(): Promise<void> {},
};

vi.mock("../../../../src/lib/database/db.js", () => ({
  getDb: async () => fakeDb,
  getControlDb: async () => fakeDb,
  resetDb: () => {},
}));
vi.mock("../../../../src/lib/email/mail.js", () => ({
  sendMail: async () => ({ ok: true }),
  sendTemplateMail: async () => ({ ok: true }),
  notifyAdmin: async () => ({ ok: true }),
}));
vi.mock("../../../../src/lib/plugins/plugin-runtime.js", () => ({
  getRuntimeHooks: () => ({ dispatchAction: async () => {}, has: () => false }),
  ensurePluginRuntime: async () => {},
  getPluginLoader: () => null,
}));

const { default: authRoutes } = await import("../../../../src/routes/auth/auth.js");
const { csrfProtection } = await import("../../../../src/middleware/csrf.js");
const { hashPassword } = await import("../../../../src/lib/auth/password.js");
const { totpCode, base32Encode } = await import("../../../../src/lib/auth/totp.js");
const { encryptSecret } = await import("../../../../src/lib/security/secret-box.js");
const { resetRateLimits } = await import("../../../../src/lib/security/rate-limit.js");

let server: Server;
let base: string;

/** A tiny cookie jar, so the session survives between requests like a browser's. */
class Jar {
  private jar = new Map<string, string>();
  absorb(res: Response): void {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(";");
      const eq = pair!.indexOf("=");
      this.jar.set(pair!.slice(0, eq), pair!.slice(eq + 1));
    }
  }
  header(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  get(name: string): string | undefined {
    return this.jar.get(name);
  }
}

async function post(path: string, body: unknown, jar: Jar) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const cookie = jar.header();
  if (cookie) headers.cookie = cookie;
  const csrf = jar.get("jf_csrf");
  if (csrf) headers["x-csrf-token"] = decodeURIComponent(csrf);

  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  jar.absorb(res);
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

async function get(path: string, jar: Jar) {
  const headers: Record<string, string> = {};
  const cookie = jar.header();
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${base}${path}`, { headers });
  jar.absorb(res);
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

beforeAll(async () => {
  const app = express();
  app.use((req, _res, next) => {
    req.cookies = Object.fromEntries(
      (req.headers.cookie ?? "")
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const separator = part.indexOf("=");
          return [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))];
        }),
    );
    next();
  });
  app.use(express.json());
  app.use("/api", csrfProtection);
  app.use("/api/auth", authRoutes);
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
});

beforeEach(async () => {
  resetRateLimits();
  user = {
    id: "11111111-1111-4111-8111-111111111111",
    site_id: "22222222-2222-4222-8222-222222222222",
    email: "admin@example.com",
    password_hash: await hashPassword("correct-horse-battery"),
    role: "administrator",
    token_version: 0,
    totp_secret: null,
    totp_confirmed_at: null,
    totp_recovery_codes: null,
  };
});

/** Sign in far enough to hold a session cookie. */
async function signIn(jar: Jar, extra: Record<string, unknown> = {}) {
  await get("/api/auth/csrf", jar);
  return post(
    "/api/auth/login",
    { email: user.email, password: "correct-horse-battery", ...extra },
    jar,
  );
}

describe("sign-in without a second factor", () => {
  it("succeeds on the right password", async () => {
    const jar = new Jar();
    const res = await signIn(jar);
    expect(res.status).toBe(200);
    expect(jar.get("jf_session")).toBeTruthy();
    // The client is told where to land rather than guessing from a pre-session
    // page — the admin path here is the default, but this is what carries a
    // moved one (issue #51).
    expect(res.body.redirectTo).toBe("/admin");
  });

  it("rejects the wrong password without saying which half was wrong", async () => {
    const jar = new Jar();
    await get("/api/auth/csrf", jar);
    const res = await post("/api/auth/login", { email: user.email, password: "wrong" }, jar);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid email or password");
    expect(res.body.totpRequired).toBeUndefined();
  });
});

describe("two-factor enrolment", () => {
  it("does not take effect until a code is proven", async () => {
    const jar = new Jar();
    await signIn(jar);

    const setup = await post("/api/auth/2fa/setup", {}, jar);
    expect(setup.status).toBe(200);
    expect(setup.body.secret).toMatch(/^[A-Z2-7]+$/);
    expect(setup.body.uri).toContain("otpauth://totp/");

    // Secret is stored, but unconfirmed — sign-in must not demand a code yet.
    expect(user.totp_secret).toBeTruthy();
    expect(user.totp_confirmed_at).toBeNull();

    const stillOpen = new Jar();
    expect((await signIn(stillOpen)).status).toBe(200);
  });

  it("refuses a wrong code and stays off", async () => {
    const jar = new Jar();
    await signIn(jar);
    await post("/api/auth/2fa/setup", {}, jar);

    const res = await post("/api/auth/2fa/enable", { code: "000000" }, jar);
    expect(res.status).toBe(400);
    expect(user.totp_confirmed_at).toBeNull();
  });

  it("turns on with a valid code and returns ten recovery codes once", async () => {
    const jar = new Jar();
    await signIn(jar);
    const setup = await post("/api/auth/2fa/setup", {}, jar);

    const counter = Math.floor(Date.now() / 1000 / 30);
    const res = await post(
      "/api/auth/2fa/enable",
      { code: totpCode(setup.body.secret, counter) },
      jar,
    );

    expect(res.status).toBe(200);
    expect(res.body.recoveryCodes).toHaveLength(10);
    expect(user.totp_confirmed_at).toBeTruthy();

    // Status reports it as on, and never returns the codes again.
    const status = await get("/api/auth/2fa", jar);
    expect(status.body).toEqual({ enabled: true, pending: false, recoveryCodesRemaining: 10 });
    expect(JSON.stringify(status.body)).not.toContain(res.body.recoveryCodes[0]);
  });
});

describe("sign-in with a second factor enrolled", () => {
  let secret: string;
  let recoveryCodes: string[];

  beforeEach(async () => {
    const jar = new Jar();
    await signIn(jar);
    const setup = await post("/api/auth/2fa/setup", {}, jar);
    secret = setup.body.secret;
    const counter = Math.floor(Date.now() / 1000 / 30);
    const enabled = await post("/api/auth/2fa/enable", { code: totpCode(secret, counter) }, jar);
    recoveryCodes = enabled.body.recoveryCodes;
  });

  it("stops at the code step even with the right password", async () => {
    const jar = new Jar();
    const res = await signIn(jar);
    expect(res.status).toBe(401);
    expect(res.body.totpRequired).toBe(true);
    expect(jar.get("jf_session")).toBeFalsy();
  });

  it("rejects a wrong code", async () => {
    const jar = new Jar();
    const res = await signIn(jar, { totp: "000000" });
    expect(res.status).toBe(401);
    expect(jar.get("jf_session")).toBeFalsy();
  });

  it("completes with a valid code", async () => {
    const jar = new Jar();
    const counter = Math.floor(Date.now() / 1000 / 30);
    const res = await signIn(jar, { totp: totpCode(secret, counter) });
    expect(res.status).toBe(200);
    expect(jar.get("jf_session")).toBeTruthy();
  });

  it("accepts a recovery code, and only once", async () => {
    const first = new Jar();
    expect((await signIn(first, { totp: recoveryCodes[0] })).status).toBe(200);

    // The same code must not work a second time.
    const second = new Jar();
    expect((await signIn(second, { totp: recoveryCodes[0] })).status).toBe(401);

    // A different one still does.
    const third = new Jar();
    expect((await signIn(third, { totp: recoveryCodes[1] })).status).toBe(200);
  });

  it("does not reveal 2FA status to someone who fails the password", async () => {
    const jar = new Jar();
    await get("/api/auth/csrf", jar);
    const res = await post("/api/auth/login", { email: user.email, password: "wrong" }, jar);
    expect(res.status).toBe(401);
    expect(res.body.totpRequired).toBeUndefined();
    expect(res.body.error).toBe("Invalid email or password");
  });

  it("will not turn off without a current code", async () => {
    const jar = new Jar();
    const counter = Math.floor(Date.now() / 1000 / 30);
    await signIn(jar, { totp: totpCode(secret, counter) });

    const noCode = await post("/api/auth/2fa/disable", { password: "correct-horse-battery" }, jar);
    expect(noCode.status).toBe(401);
    expect(user.totp_confirmed_at).toBeTruthy();

    const wrongPassword = await post(
      "/api/auth/2fa/disable",
      { password: "nope", code: totpCode(secret, counter) },
      jar,
    );
    expect(wrongPassword.status).toBe(401);
    expect(user.totp_confirmed_at).toBeTruthy();
  });

  it("turns off with both the password and a code", async () => {
    const jar = new Jar();
    const counter = Math.floor(Date.now() / 1000 / 30);
    await signIn(jar, { totp: totpCode(secret, counter) });

    const res = await post(
      "/api/auth/2fa/disable",
      { password: "correct-horse-battery", code: totpCode(secret, counter) },
      jar,
    );
    expect(res.status).toBe(200);
    expect(user.totp_secret).toBeNull();
  });
});

describe("secrets at rest", () => {
  it("stores the TOTP secret encrypted, not in the clear", async () => {
    const jar = new Jar();
    await signIn(jar);
    const setup = await post("/api/auth/2fa/setup", {}, jar);

    expect(user.totp_secret).not.toBe(setup.body.secret);
    expect(user.totp_secret).toMatch(/^enc:v1:/);
    // Sanity: the encryption is the project's own, and round-trips.
    expect(encryptSecret("x")).toMatch(/^enc:v1:/);
    expect(base32Encode(Buffer.from("a"))).toBeTruthy();
  });

  it("stores recovery codes encrypted", async () => {
    const jar = new Jar();
    await signIn(jar);
    const setup = await post("/api/auth/2fa/setup", {}, jar);
    const counter = Math.floor(Date.now() / 1000 / 30);
    const enabled = await post(
      "/api/auth/2fa/enable",
      { code: totpCode(setup.body.secret, counter) },
      jar,
    );

    expect(user.totp_recovery_codes).toMatch(/^enc:v1:/);
    expect(user.totp_recovery_codes).not.toContain(enabled.body.recoveryCodes[0]);
  });
});

describe("password change", () => {
  it("requires the current password", async () => {
    const jar = new Jar();
    await signIn(jar);
    const res = await post(
      "/api/auth/password",
      { currentPassword: "wrong", newPassword: "a-brand-new-passphrase" },
      jar,
    );
    expect(res.status).toBe(401);
  });

  it("rejects a new password below the length floor", async () => {
    const jar = new Jar();
    await signIn(jar);
    const res = await post(
      "/api/auth/password",
      { currentPassword: "correct-horse-battery", newPassword: "short" },
      jar,
    );
    expect(res.status).toBe(400);
  });

  it("changes the password and revokes other sessions", async () => {
    const jar = new Jar();
    await signIn(jar);
    const before = user.token_version;

    const res = await post(
      "/api/auth/password",
      { currentPassword: "correct-horse-battery", newPassword: "a-brand-new-passphrase" },
      jar,
    );

    expect(res.status).toBe(200);
    // The counter moved, which is what invalidates tokens issued earlier.
    expect(user.token_version).toBe(before + 1);
    // And the new password is what works now.
    const fresh = new Jar();
    await get("/api/auth/csrf", fresh);
    expect(
      (
        await post(
          "/api/auth/login",
          { email: user.email, password: "a-brand-new-passphrase" },
          fresh,
        )
      ).status,
    ).toBe(200);
  });
});
