// SPDX-License-Identifier: MIT

export { PluginLoader } from "./loader.js";
export type {
  LoadedPlugin,
  PluginBlockRegistry,
  PluginErrorReporter,
  PluginPlaceholderResolver,
} from "./loader.js";
export { PluginHttpRouter, type RegisteredPluginRoute } from "./http-router.js";
export { PluginCookieRegistry } from "./cookie-registry.js";
export { PluginCapabilityRegistry } from "./capability-registry.js";
export { PluginRoleRegistry } from "./role-registry.js";
export type { RegisteredPluginRole } from "./role-registry.js";
export { PluginDiagnosticRegistry } from "./diagnostic-registry.js";
export { PluginPatternRegistry } from "./pattern-registry.js";
export type { RegisteredPluginPattern } from "./pattern-registry.js";
export { PluginVisibilityRuleRegistry } from "./visibility-rule-registry.js";
export type { RegisteredVisibilityRule } from "./visibility-rule-registry.js";
export { PluginPlaceholderRegistry, placeholderImgHtml } from "./placeholder-registry.js";
export type { RegisteredPlaceholder } from "./placeholder-registry.js";
