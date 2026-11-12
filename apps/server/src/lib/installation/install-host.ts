// SPDX-License-Identifier: MIT
/**
 * Which hosting control panel installed this site, if any.
 *
 * A hosting integration writes `INSTALL_HOST=<id>` in `.env`. Only ids from a
 * fixed list are accepted, so the setup wizard can show translated,
 * host-specific help (for example where the setup key is shown) and never
 * renders text taken from `.env`.
 */

export const INSTALL_HOSTS = ["plesk", "cpanel"] as const;

export type InstallHost = (typeof INSTALL_HOSTS)[number];

export function parseInstallHost(env: ReadonlyMap<string, string>): InstallHost | null {
  const raw = (env.get("INSTALL_HOST") ?? "").trim().replace(/^(["'])(.*)\1$/, "$2").toLowerCase();
  return (INSTALL_HOSTS as readonly string[]).includes(raw) ? (raw as InstallHost) : null;
}
