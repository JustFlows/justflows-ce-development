import { describe, expect, it } from "vitest";
import {
  THEME_CUSTOMIZE_SCHEMA,
  assembleThemeCss,
  buildThemeStylesheet,
  isSafeCssColor,
  isSafeCssFontStack,
  isSafeCssVariableName,
  mergeMods,
  modsToCssVariables,
  modsToDarkCssVariables,
} from "../theme-customize.js";

describe("isSafeCssColor", () => {
  it("accepts the formats the colour picker produces", () => {
    for (const value of ["#fff", "#3b82f6", "#3b82f6ff", "rgb(59, 130, 246)", "rgba(0,0,0,.5)", "hsl(217 91% 60%)", "transparent", "rebeccapurple"]) {
      expect(isSafeCssColor(value), value).toBe(true);
    }
  });

  it("rejects anything that can end the declaration or open a rule", () => {
    for (const value of [
      "red } body { background: url(//attacker.example/x) } x {",
      "red; background: url(//attacker.example/x)",
      "url(//attacker.example/x)",
      "red /* } */",
      "@import url(//attacker.example/x)",
      "expression(alert(1))",
      "red\\3b background:red",
    ]) {
      expect(isSafeCssColor(value), value).toBe(false);
    }
  });
});

describe("isSafeCssFontStack", () => {
  it("accepts the shipped presets", () => {
    for (const value of [
      "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
      '"Inter", system-ui, sans-serif',
      'ui-monospace, "Cascadia Code", Consolas, monospace',
    ]) {
      expect(isSafeCssFontStack(value), value).toBe(true);
    }
  });

  it("rejects rule injection", () => {
    expect(isSafeCssFontStack("sans-serif } html { display:none } x {")).toBe(false);
    expect(isSafeCssFontStack("sans-serif; background: red")).toBe(false);
  });
});

describe("isSafeCssVariableName", () => {
  it("accepts custom properties only", () => {
    expect(isSafeCssVariableName("--color-primary")).toBe(true);
    expect(isSafeCssVariableName("color-primary")).toBe(false);
    expect(isSafeCssVariableName("--x; } body {")).toBe(false);
    expect(isSafeCssVariableName("}\nbody{background:red")).toBe(false);
  });
});

describe("modsToCssVariables", () => {
  it("keeps valid overrides", () => {
    const vars = modsToCssVariables({}, { colors: { "--color-primary": "#ff0000" } });
    expect(vars["--color-primary"]).toBe("#ff0000");
  });

  it("falls back to the default when a colour is malicious", () => {
    const vars = modsToCssVariables(
      {},
      { colors: { "--color-primary": "red } body { background: url(//evil.example/x) } x {" } },
    );
    expect(vars["--color-primary"]).toBe("#3b82f6");
  });

  it("ignores an injected declaration smuggled through the key", () => {
    const vars = modsToCssVariables({}, { colors: { "--x; } body { display:none": "#fff" } });
    expect(Object.keys(vars).some((k) => k.includes("}"))).toBe(false);
  });

  it("clamps range controls instead of interpolating a string", () => {
    const vars = modsToCssVariables({}, { layout: { contentWidth: "1; } html { display:none } x {" } });
    expect(vars["--max-width"]).toBe("720px");

    expect(modsToCssVariables({}, { layout: { contentWidth: 99999 } })["--max-width"]).toBe("1200px");
    expect(modsToCssVariables({}, { typography: { baseFontSize: -5 } })["--base-font-size"]).toBe("14px");
  });
});

describe("buildThemeStylesheet", () => {
  it("never emits a declaration that closes the :root block", () => {
    const css = buildThemeStylesheet(
      modsToCssVariables(
        // A malicious theme package supplying css_variables directly.
        { "--ok": "1rem", "--evil": "red } body { display:none } x {", "}body{color:red": "x" },
        { colors: { "--color-bg": "#000 } * { display:none } x {" } },
      ),
    );
    expect(css).not.toContain("display:none");
    expect(css.match(/\{/g)).toHaveLength(2); // :root { and html {
    expect(css).toContain("--ok: 1rem;");
  });
});

describe("modsToDarkCssVariables", () => {
  it("keeps valid overrides and leaves the light palette alone", () => {
    const mods = { colors: { "--color-bg": "#ffffff" }, colorsDark: { "--color-bg": "#101418" } };
    expect(modsToDarkCssVariables({}, mods)["--color-bg"]).toBe("#101418");
    expect(modsToCssVariables({}, mods)["--color-bg"]).toBe("#ffffff");
  });

  it("falls back to the default when a dark colour is malicious", () => {
    const vars = modsToDarkCssVariables(
      {},
      { colorsDark: { "--color-bg": "#000 } html { display:none } x {" } },
    );
    expect(vars["--color-bg"]).toBe("#0f172a");
  });

  it("survives a round trip through mergeMods", () => {
    const merged = mergeMods(
      { colorsDark: { "--color-bg": "#000000", "--color-text": "#ffffff" } },
      { colorsDark: { "--color-bg": "#101418" } },
    );
    expect(merged.colorsDark).toEqual({ "--color-bg": "#101418", "--color-text": "#ffffff" });
  });
});

describe("buildThemeStylesheet dark palette", () => {
  const darkVars = { "--color-bg": "#101418" };

  it("serves the dark palette to a visitor with no data-theme attribute", () => {
    const css = buildThemeStylesheet({ "--color-bg": "#ffffff" }, "", darkVars);
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain("html:not([data-theme])");
    expect(css).toContain('html[data-theme="dark"]');
    // Both dark selectors outrank :root, so declaration order cannot undo them.
    expect(css.indexOf(":root {")).toBeLessThan(css.indexOf('html[data-theme="dark"]'));
  });

  it("sets color-scheme so form controls and scrollbars follow", () => {
    expect(buildThemeStylesheet({}, "", darkVars).match(/color-scheme: dark;/g)).toHaveLength(2);
  });

  it("omits the dark blocks entirely when there is no dark palette", () => {
    const css = buildThemeStylesheet({ "--color-bg": "#ffffff" });
    expect(css).not.toContain("prefers-color-scheme");
    expect(css).not.toContain("data-theme");
  });

  it("filters an injected dark declaration the same way as the light palette", () => {
    const css = buildThemeStylesheet({}, "", {
      "--color-bg": "#000 } html { display:none } x {",
      "}html{color:red": "x",
    });
    expect(css).not.toContain("display:none");
    expect(css).not.toContain("color:red");
  });
});

describe("assembleThemeCss", () => {
  const themeStyles = ":root { --color-bg: #eeeeee; }\n.jf-color-scheme__btn { border-radius: 999px; }";
  const tokens = buildThemeStylesheet({ "--color-bg": "#ffffff" });
  const additionalCss = ".jf-color-scheme__btn { border-radius: 0; }";

  it("puts Customizer tokens after the theme so the site's colours win", () => {
    const css = assembleThemeCss(themeStyles, tokens, "");
    expect(css.indexOf("--color-bg: #eeeeee")).toBeLessThan(css.indexOf("--color-bg: #ffffff"));
  });

  it("puts Additional CSS last so it wins at equal specificity", () => {
    const css = assembleThemeCss(themeStyles, tokens, additionalCss);
    expect(css.indexOf("border-radius: 999px")).toBeLessThan(css.indexOf("border-radius: 0"));
    expect(css.indexOf("/* Block animations */")).toBeLessThan(css.indexOf("/* Custom CSS */"));
  });

  it("skips empty sections rather than emitting blank labels", () => {
    const css = assembleThemeCss("", tokens, "");
    expect(css).not.toContain("/* Theme styles */");
    expect(css).not.toContain("/* Custom CSS */");
    expect(css).not.toContain("/* Plugin styles */");
  });

  it("slots plugin CSS after the theme and before Additional CSS", () => {
    const pluginCss = ".jf-product-buy { color: red; }";
    const css = assembleThemeCss(themeStyles, tokens, additionalCss, pluginCss);
    expect(css.indexOf("--color-bg: #ffffff")).toBeLessThan(css.indexOf("/* Plugin styles */"));
    expect(css.indexOf("/* Plugin styles */")).toBeLessThan(css.indexOf("/* Custom CSS */"));
    expect(css.indexOf(".jf-product-buy")).toBeLessThan(css.indexOf("border-radius: 0"));
  });

  it("omits the plugin section when no plugin contributed CSS", () => {
    const css = assembleThemeCss(themeStyles, tokens, additionalCss, "   ");
    expect(css).not.toContain("/* Plugin styles */");
  });
});

describe("design tokens", () => {
  it("turns every range control into a token with its unit", () => {
    const vars = modsToCssVariables({}, {
      spacing: { "--space-unit-base": 12, "--block-gap": 2.25 },
      radius: { "--radius-lg": 24 },
      headings: { "--h1-size": 3.5 },
    });
    expect(vars["--space-unit-base"]).toBe("12px");
    expect(vars["--block-gap"]).toBe("2.25rem");
    expect(vars["--radius-lg"]).toBe("24px");
    expect(vars["--h1-size"]).toBe("3.5rem");
  });

  it("clamps a range to what the control declares", () => {
    expect(modsToCssVariables({}, { radius: { "--radius-sm": 9999 } })["--radius-sm"]).toBe("24px");
    expect(modsToCssVariables({}, { radius: { "--radius-sm": -50 } })["--radius-sm"]).toBe("0px");
  });

  it("refuses a range value that is not fully numeric", () => {
    // parseFloat would take the leading 1 and store a value nobody typed.
    expect(modsToCssVariables({}, { radius: { "--radius-md": "1; } html { display:none }" } })["--radius-md"])
      .toBe("10px");
  });

  it("accepts a shadow only when it is one of the presets", () => {
    const preset = THEME_CUSTOMIZE_SCHEMA.shadow?.controls["--shadow-md"]?.options?.[2]?.value ?? "";
    expect(modsToCssVariables({}, { shadow: { "--shadow-md": preset } })["--shadow-md"]).toBe(preset);
    expect(modsToCssVariables({}, { shadow: { "--shadow-md": "0 0 0 red } html { display:none } x {" } })["--shadow-md"])
      .toBe("0 8px 24px rgba(15,23,42,0.08)");
  });

  it("keeps the heading font on the same allowlist as the body font", () => {
    expect(modsToCssVariables({}, { headings: { "--font-heading": '"Inter", sans-serif' } })["--font-heading"])
      .toBe('"Inter", sans-serif');
    expect(modsToCssVariables({}, { headings: { "--font-heading": "x; } body { display:none" } })["--font-heading"])
      .toBe("system-ui, -apple-system, BlinkMacSystemFont, sans-serif");
  });

  it("never lets a token section reach the stylesheet unfiltered", () => {
    const css = buildThemeStylesheet(
      modsToCssVariables({}, { spacing: { "--space-unit-base": "8px } html { display:none } x {" } }),
    );
    expect(css).not.toContain("display:none");
  });
});
