import type { BlockNode } from "./types";

function newId(): string {
  return crypto.randomUUID();
}

export const DEFAULT_PROPS: Record<string, Record<string, unknown>> = {
  "core.section": { background: "default", padding: "lg", align: "left" },
  "core.container": { width: "default" },
  "core.group": {},
  "core.columns": { columns: 2, gap: "md" },
  "core.column": {},
  "core.hero": {
    heading: "Build something great",
    subheading: "A clean, modern page builder for your site.",
    buttonLabel: "Get started",
    buttonUrl: "/",
    backgroundImage: "",
    align: "center",
  },
  "core.features": {
    heading: "Features",
    columns: 3,
    items: [
      { icon: "⚡", title: "Fast", description: "Lightweight and performant." },
      { icon: "🎨", title: "Flexible", description: "Sections and blocks you control." },
      { icon: "🔒", title: "Secure", description: "Your content stays on your server." },
    ],
  },
  "core.cta": {
    heading: "Ready to get started?",
    text: "Create beautiful pages in minutes.",
    buttonLabel: "Contact us",
    buttonUrl: "/contact",
    variant: "primary",
  },
  "core.paragraph": { text: "" },
  "core.heading": { text: "", level: 2 },
  "core.image": { src: "", alt: "", caption: "", width: 0, height: 0, objectFit: "contain" },
  "core.quote": { text: "", attribution: "" },
  "core.button": { label: "", url: "", variant: "primary" },
  "core.link-list": {
    heading: "Links",
    items: [
      { label: "Link one", url: "/" },
      { label: "Link two", url: "/" },
    ],
  },
  "core.divider": {},
  "core.spacer": { height: 40 },
  "core.code": { code: "", language: "" },
  "core.embed": { url: "", caption: "" },
  "core.html": { html: "" },
  "justflows.forms.form": { formId: "contact" },
  "justflows.gallery.grid": { items: [], layout: "grid", columns: 3, lightbox: true },
  "justflows.blog.postList": {
    layout: "grid",
    columns: 3,
    showExcerpt: true,
    showDate: true,
    showFeaturedImage: true,
    postsPerPage: 0,
  },
  "justflows.shop.gallery": {
    layout: "thumbs",
    lightbox: true,
    images: [
      { src: "https://tailwindcss.com/plus-assets/img/ecommerce-images/product-page-03-product-01.jpg", alt: "Product photo 1" },
      { src: "https://tailwindcss.com/plus-assets/img/ecommerce-images/product-page-03-product-02.jpg", alt: "Product photo 2" },
      { src: "https://tailwindcss.com/plus-assets/img/ecommerce-images/product-page-03-product-03.jpg", alt: "Product photo 3" },
      { src: "https://tailwindcss.com/plus-assets/img/ecommerce-images/product-page-03-product-04.jpg", alt: "Product photo 4" },
    ],
  },
  "justflows.shop.buy-box": {
    title: "{{title}}",
    price: "{{price}}",
    comparePrice: "{{comparePrice}}",
    description: "{{excerpt}}",
    meta: "SKU {{sku}}",
    attributes: "{{attributes}}",
    cartLabel: "Add to cart",
    cartUrl: "/cart",
    shipping: "{{weight}} {{weightUnit}} · {{dimensions}}",
    showRating: false,
    showWishlist: false,
  },
  "justflows.shop.breadcrumbs": {
    current: "{{title}}",
    items: [{ name: "Shop", href: "/shop" }],
  },
  "justflows.shop.highlights": {
    heading: "Highlights",
    items: ["Replace these highlights with your product features."],
  },
  "justflows.shop.accordion": {
    sections: [
      { name: "Specifications", items: ["SKU: {{sku}}", "Price: {{price}}", "Stock: {{stock}}"] },
      { name: "Shipping", items: ["Replace this with your shipping copy."] },
    ],
  },
  "justflows.shop.policies": {
    items: [
      { name: "Free delivery", description: "Replace this with your shipping policy.", imageSrc: "https://tailwindcss.com/plus-assets/img/ecommerce/icons/icon-delivery-light.svg" },
      { name: "Customer support", description: "Replace this with how customers can reach you.", imageSrc: "https://tailwindcss.com/plus-assets/img/ecommerce/icons/icon-chat-light.svg" },
    ],
  },
  "justflows.shop.reviews": {
    heading: "Customer Reviews",
    average: 0,
    totalCount: 0,
    showHistogram: false,
    items: [],
    writeLabel: "Write a review",
    writeHref: "#",
  },
  "justflows.shop.related": {
    heading: "You may also like",
    layout: "cards",
    items: [
      { name: "Related product", href: "/shop", imageSrc: "https://tailwindcss.com/plus-assets/img/ecommerce-images/product-page-01-related-product-01.jpg", imageAlt: "Related product 1", price: "", color: "" },
      { name: "Related product", href: "/shop", imageSrc: "https://tailwindcss.com/plus-assets/img/ecommerce-images/product-page-01-related-product-02.jpg", imageAlt: "Related product 2", price: "", color: "" },
    ],
  },
  "justflows.shop.product-list": {
    layout: "inline",
    heading: "Customers also purchased",
    headingHidden: false,
    ctaLabel: "",
    ctaHref: "/shop",
    addLabel: "Add to bag",
    items: [
      { name: "Basic Tee", href: "/shop", imageSrc: "https://tailwindcss.com/plus-assets/img/ecommerce-images/product-page-01-related-product-01.jpg", imageAlt: "Front of men's Basic Tee in black.", price: "$35", color: "Black", description: "Everyday cotton crewneck.", rating: 5, reviewCount: 38, colors: [{ name: "Black", colorBg: "#111827" }, { name: "White", colorBg: "#F9FAFB" }] },
      { name: "Basic Tee", href: "/shop", imageSrc: "https://tailwindcss.com/plus-assets/img/ecommerce-images/product-page-01-related-product-02.jpg", imageAlt: "Front of men's Basic Tee in white.", price: "$35", color: "Aspen White", description: "Soft unisex fit.", rating: 5, reviewCount: 18, colors: [{ name: "Aspen White", colorBg: "#F9FAFB" }, { name: "Black", colorBg: "#111827" }] },
      { name: "Basic Tee", href: "/shop", imageSrc: "https://tailwindcss.com/plus-assets/img/ecommerce-images/product-page-01-related-product-03.jpg", imageAlt: "Front of men's Basic Tee in dark gray.", price: "$35", color: "Charcoal", description: "Heavyweight jersey.", rating: 4, reviewCount: 21, colors: [{ name: "Charcoal", colorBg: "#4B5563" }, { name: "Black", colorBg: "#111827" }] },
      { name: "Artwork Tee", href: "/shop", imageSrc: "https://tailwindcss.com/plus-assets/img/ecommerce-images/product-page-01-related-product-04.jpg", imageAlt: "Front of men's Artwork Tee in peach.", price: "$35", color: "Iso Dots", description: "Printed cotton tee.", rating: 5, reviewCount: 24, colors: [{ name: "Iso Dots", colorBg: "#FED7AA" }, { name: "Natural", colorBg: "#FEF3C7" }] },
    ],
  },
  "justflows.shop.detail-shots": {
    heading: "The Fine Details",
    intro: "",
    items: [
      { src: "https://tailwindcss.com/plus-assets/img/ecommerce-images/product-page-04-detail-product-shot-01.jpg", alt: "Detail photo 1", text: "Replace this caption." },
      { src: "https://tailwindcss.com/plus-assets/img/ecommerce-images/product-page-04-detail-product-shot-02.jpg", alt: "Detail photo 2", text: "Replace this caption." },
    ],
  },
  "core.grid": { columns: 12, gap: "md", rowHeight: "auto" },
  "core.color-scheme": { style: "buttons", align: "right", showSystem: false },
  "core.language-switcher": { style: "codes", align: "right" },
  "core.auth-links": {
    showLogin: true,
    showRegister: true,
    loginLabel: "Log in",
    registerLabel: "Register",
    style: "buttons",
    align: "right",
  },
};

function makeColumn(): BlockNode {
  return { id: newId(), type: "core.column", version: 1, props: {}, children: [] };
}

export function createBlock(type: string): BlockNode {
  const block: BlockNode = {
    id: newId(),
    type,
    version: 1,
    props: { ...(DEFAULT_PROPS[type] ?? {}) },
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

export const CATEGORY_LABELS: Record<string, string> = {
  sections: "Sections",
  layout: "Layout",
  content: "Content",
  media: "Media",
  commerce: "Commerce",
  site: "Site",
};

export const CATEGORY_ORDER = ["sections", "layout", "content", "media", "commerce", "site"];
