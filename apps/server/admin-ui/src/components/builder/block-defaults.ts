import { translateEnglish, type Translate } from "../../i18n/translate";
import type { BlockNode } from "./types";
import { uid } from "../../lib/uid";

function newId(): string {
  return uid();
}

export function defaultProps(t: Translate): Record<string, Record<string, unknown>> {
return {
  "core.section": { background: "default", padding: "lg", align: "left" },
  "core.container": { width: "default" },
  "core.group": {},
  "core.columns": { columns: 2, gap: "md" },
  "core.column": {},
  "core.hero": {
    heading: t("ui.blockDefaults.buildSomethingGreat"),
    subheading: t("ui.blockDefaults.aCleanModernPageBuilderForYourSite"),
    buttonLabel: t("ui.blockDefaults.getStarted"),
    buttonUrl: "/",
    backgroundImage: "",
    align: "center",
  },
  "core.features": {
    heading: t("ui.blockDefaults.features"),
    columns: 3,
    items: [
      { icon: "⚡", title: t("ui.blockDefaults.fast"), description: t("ui.blockDefaults.lightweightAndPerformant") },
      { icon: "🎨", title: t("ui.blockDefaults.flexible"), description: t("ui.blockDefaults.sectionsAndBlocksYouControl") },
      { icon: "🔒", title: t("ui.blockDefaults.secure"), description: t("ui.blockDefaults.yourContentStaysOnYourServer") },
    ],
  },
  "core.cta": {
    heading: t("ui.blockDefaults.readyToGetStarted"),
    text: t("ui.blockDefaults.createBeautifulPagesInMinutes"),
    buttonLabel: t("ui.blockDefaults.contactUs"),
    buttonUrl: "/contact",
    variant: "primary",
  },
  "core.paragraph": { text: "" },
  "core.heading": { text: "", level: 2 },
  "core.image": { src: "", alt: "", caption: "", width: 0, height: 0, objectFit: "contain" },
  "core.quote": { text: "", attribution: "" },
  "core.button": { label: "", url: "", variant: "primary" },
  "core.link-list": {
    heading: t("ui.blockDefaults.links"),
    items: [
      { label: t("ui.blockDefaults.linkOne"), url: "/" },
      { label: t("ui.blockDefaults.linkTwo"), url: "/" },
    ],
  },
  "core.divider": {},
  "core.spacer": { height: 40 },
  "core.code": { code: "", language: "" },
  "core.embed": { url: "", caption: "" },
  "core.html": { html: "" },
  "justflows.gallery.grid": { items: [], layout: "grid", columns: 3, lightbox: true },
  "justflows.blog.postList": {
    layout: "grid",
    columns: 3,
    showExcerpt: true,
    showDate: true,
    showFeaturedImage: true,
    postsPerPage: 0,
  },
  "core.grid": { columns: 12, gap: "md", rowHeight: "auto" },
  "core.search": { label: t("ui.blockDefaults.search"), contentType: "", taxonomy: "", term: "", showFilters: false, limit: 20 },
  "core.color-scheme": {
    style: "buttons",
    align: "right",
    showSystem: false,
    animate: true,
    size: "md",
    radius: "pill",
    lightIcon: "☀",
    darkIcon: "☾",
    autoIcon: "◐",
    lightLabel: t("ui.blockDefaults.light"),
    darkLabel: t("ui.blockDefaults.dark"),
    autoLabel: t("ui.blockDefaults.auto"),
  },
  "core.language-switcher": { style: "locale-short", align: "right" },
  "core.auth-links": {
    showLogin: true,
    showRegister: true,
    loginLabel: t("ui.blockDefaults.logIn"),
    registerLabel: t("ui.blockDefaults.register"),
    style: "buttons",
    align: "right",
  },
};

}

export const DEFAULT_PROPS = defaultProps(translateEnglish);

function makeColumn(): BlockNode {
  return { id: newId(), type: "core.column", version: 1, props: {}, children: [] };
}

export function createBlock(type: string, t: Translate = translateEnglish): BlockNode {
  const block: BlockNode = {
    id: newId(),
    type,
    version: 1,
    props: { ...(defaultProps(t)[type] ?? {}) },
  };

  if (type === "core.columns") {
    const cols = (block.props.columns as number) ?? 2;
    block.children = Array.from({ length: cols }, () => makeColumn());
  }

  if (type === "core.section" || type === "core.container" || type === "core.group") {
    block.children = [];
  }

  return block;
}

export function syncColumnCount(block: BlockNode): BlockNode {
  if (block.type !== "core.columns") return block;
  const target = Math.min(4, Math.max(2, (block.props.columns as number) ?? 2));
  const children = [...(block.children ?? [])];

  while (children.length < target) children.push(makeColumn());
  while (children.length > target) children.pop();

  return { ...block, props: { ...block.props, columns: target }, children };
}

export const CATEGORY_LABEL_KEYS: Record<string, string> = {
  sections: "ui.blockCategories.sections",
  layout: "ui.blockCategories.layout",
  content: "ui.blockCategories.content",
  media: "ui.blockCategories.media",
  commerce: "ui.blockCategories.commerce",
  site: "ui.blockCategories.site",
};

export const CATEGORY_ORDER = ["sections", "layout", "content", "media", "commerce", "site"];
