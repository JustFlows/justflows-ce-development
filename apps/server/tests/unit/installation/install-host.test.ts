// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { parseInstallHost } from "../../../src/lib/installation/install-host.js";

describe("parseInstallHost", () => {
  it("accepts the known hosting panels", () => {
    expect(parseInstallHost(new Map([["INSTALL_HOST", "plesk"]]))).toBe("plesk");
    expect(parseInstallHost(new Map([["INSTALL_HOST", '"cPanel"']]))).toBe("cpanel");
  });

  it("ignores anything else", () => {
    expect(parseInstallHost(new Map())).toBeNull();
    expect(parseInstallHost(new Map([["INSTALL_HOST", "<b>evil</b>"]]))).toBeNull();
    expect(parseInstallHost(new Map([["INSTALL_HOST", "directadmin"]]))).toBeNull();
  });
});
