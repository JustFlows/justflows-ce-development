// SPDX-License-Identifier: MIT
import type { BlockDefinition } from "../registry/block-registry.js";
const SECTIONS = ["all", "controls", "profile", "plugins", "workspaces"];
export const accountBlock: BlockDefinition = {
  type: "core.account", version: 1, title: "Account section", icon: "◉", category: "content",
  description: "Signed-in account data. Only rendered on private account pages.",
  schema: {
    section: { type: "select", default: "all", options: SECTIONS, optionLabels: { all: "All account sections", controls: "Account controls", profile: "Profile", plugins: "Plugin sections", workspaces: "Workspaces" } },
    sectionId: { type: "text", default: "", label: "Plugin section ID", help: "Optional: show one plugin section, such as justflows.shop.orders.", showWhen: { field: "section", equals: "plugins" } },
    showTitles: { type: "boolean", default: true, label: "Show section titles" },
  },
  validateProps: raw => {
    const props = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const section = typeof props["section"] === "string" && SECTIONS.includes(props["section"]) ? props["section"] : "all";
    const sectionId = typeof props["sectionId"] === "string" && /^[a-z][a-z0-9._-]{0,119}$/.test(props["sectionId"]) ? props["sectionId"] : "";
    return { section, sectionId, showTitles: props["showTitles"] !== false };
  },
  render: props => `<div class="jf-account" data-jf-account="${props["section"]}" data-section-id="${props["sectionId"]}" data-show-titles="${props["showTitles"]}">Your account details</div>`,
};
