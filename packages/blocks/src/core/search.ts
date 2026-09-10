// SPDX-License-Identifier: MIT
import type { BlockDefinition } from "../registry/block-registry.js";
import { esc } from "../safe-url.js";

export const searchBlock: BlockDefinition = {
  type: "core.search",
  version: 1,
  title: "Search",
  icon: "⌕",
  category: "site",
  description: "Search published content with optional type, taxonomy, and date filters.",
  schema: {
    label: { type: "text", default: "Search" },
    contentType: { type: "text", default: "" },
    taxonomy: { type: "text", default: "" },
    term: { type: "text", default: "" },
    showFilters: { type: "boolean", default: false },
    limit: { type: "number", default: 20 },
  },
  validateProps: (raw) => {
    const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const text = (key: string, fallback = "") =>
      typeof r[key] === "string" ? (r[key] as string).slice(0, 255) : fallback;
    const limit = Number(r["limit"]);
    return {
      label: text("label", "Search").trim() || "Search",
      contentType: text("contentType"),
      taxonomy: text("taxonomy"),
      term: text("term"),
      showFilters: r["showFilters"] === true,
      limit: Number.isFinite(limit) ? Math.max(1, Math.min(50, Math.trunc(limit))) : 20,
    };
  },
  render: (props) => {
    const p = props as {
      label: string;
      contentType: string;
      taxonomy: string;
      term: string;
      showFilters: boolean;
      limit: number;
    };
    const scope = [
      ["type", p.contentType],
      ["taxonomy", p.taxonomy],
      ["term", p.term],
    ];
    const fields = scope
      .map(([name, value]) =>
        p.showFilters
          ? `<label><span data-jf-search-text="${name}">${esc(name!)}</span> <input name="${name}" value="${esc(value!)}" maxlength="255"></label>`
          : value
            ? `<input type="hidden" name="${name}" value="${esc(value)}">`
            : "",
      )
      .join("");
    const label =
      p.label === "Search" ? '<span data-jf-search-text="submit">Search</span>' : esc(p.label);
    return `<form class="jf-search" role="search" action="/search" method="get" data-jf-search><label>${label} <input type="search" name="q" maxlength="200" required></label>${fields}${p.showFilters ? '<label><span data-jf-search-text="after">From</span> <input type="date" name="after"></label><label><span data-jf-search-text="before">Through</span> <input type="date" name="before"></label>' : ""}<input type="hidden" name="limit" value="${p.limit}"><button type="submit">${label}</button></form>`;
  },
};
