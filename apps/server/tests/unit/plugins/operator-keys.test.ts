import { describe, expect, it } from "vitest";
import {
  canonicalOperatorKey,
  ensureOperatorKey,
  operatorKeyAllowed,
  operatorKeyPrefix,
  type OperatorKeyStore,
} from "../../../src/lib/plugins/operator-keys.js";

function store(initial: Record<string, string> = {}): OperatorKeyStore & { file: Map<string, string>; writes: number } {
  const file = new Map(Object.entries(initial));
  const env: NodeJS.ProcessEnv = {};
  let writes = 0;
  return {
    env,
    file,
    get writes() {
      return writes;
    },
    async read(name) {
      return file.get(name);
    },
    async write(name, value) {
      writes += 1;
      file.set(name, value);
      env[name] = value;
    },
  };
}

describe("operator key names", () => {
  it("allows a key under the calling plugin and rejects another plugin's name", () => {
    expect(operatorKeyAllowed("justflows.desk", "JUSTFLOWS_DESK_KEK")).toBe(true);
    expect(operatorKeyAllowed("justflows.example-shop", "JUSTFLOWS_EXAMPLE_SHOP_KEK")).toBe(true);
    expect(operatorKeyAllowed("justflows.desk", "JUSTFLOWS_STORE_KEK")).toBe(false);
    expect(operatorKeyAllowed("justflows.desk", "APP_SECRET")).toBe(false);
  });

  it("gives third-party plugins a prefix no other publisher can reach", () => {
    expect(operatorKeyPrefix("acme.forms")).toBe("JUSTFLOWS_EXT_ACME__FORMS_");
    expect(operatorKeyPrefix("acme-labs.forms-pro")).toBe("JUSTFLOWS_EXT_ACME_LABS__FORMS_PRO_");
    expect(operatorKeyAllowed("acme.forms", "JUSTFLOWS_EXT_ACME__FORMS_KEK")).toBe(true);
    expect(operatorKeyAllowed("acme.forms", "JUSTFLOWS_FORMS_KEK")).toBe(false);
    expect(operatorKeyAllowed("acme-forms.x", "JUSTFLOWS_EXT_ACME__FORMS_KEK")).toBe(false);
    expect(operatorKeyAllowed("justflows.ext-acme", "JUSTFLOWS_EXT_ACME__FORMS_KEK")).toBe(false);
    expect(operatorKeyPrefix("acme.forms.extra")).toBeNull();
  });
});

describe("canonicalOperatorKey", () => {
  it("accepts 64 hex characters and 32-byte base64", () => {
    expect(canonicalOperatorKey("ab".repeat(32))).toBe("ab".repeat(32));
    const hex = "aa".repeat(32);
    expect(canonicalOperatorKey(Buffer.from(hex, "hex").toString("base64"))).toBe(hex);
  });

  it("rejects a missing or short value", () => {
    expect(canonicalOperatorKey(undefined)).toBeNull();
    expect(canonicalOperatorKey("")).toBeNull();
    expect(canonicalOperatorKey("abcd")).toBeNull();
  });
});

describe("ensureOperatorKey", () => {
  it("writes a new key and keeps it on the next call", async () => {
    const saved = store();
    await ensureOperatorKey("justflows.desk", "JUSTFLOWS_DESK_KEK", saved);
    const key = saved.file.get("JUSTFLOWS_DESK_KEK");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(saved.env["JUSTFLOWS_DESK_KEK"]).toBe(key);
    expect(saved.writes).toBe(1);

    const again = store({ JUSTFLOWS_DESK_KEK: key! });
    await ensureOperatorKey("justflows.desk", "JUSTFLOWS_DESK_KEK", again);
    expect(again.writes).toBe(0);
    expect(again.env["JUSTFLOWS_DESK_KEK"]).toBe(key);
  });

  it("refuses a name that belongs to another plugin", async () => {
    const saved = store();
    await expect(ensureOperatorKey("justflows.desk", "APP_SECRET", saved)).rejects.toThrow(/outside this plugin/);
    expect(saved.writes).toBe(0);
  });
});
