/**
 * Representative stored block documents, one per builder surface, in the exact
 * shape the server writes today. The contract tests use them to prove that
 * sanitizing is lossless and idempotent, that ids never change, and that
 * migration and rollback behave the same for every document kind.
 */

export interface FixtureDocument {
  version: 1;
  blocks: Array<Record<string, unknown>>;
}

/** A page body: sections, columns, grid placement, per-block style, CSS, animation, devices. */
export const pageDocument: FixtureDocument = {
  version: 1,
  blocks: [
    {
      id: "3f1c2a9e-6b1d-4c37-9a51-0d1e2f3a4b5c",
      type: "core.section",
      version: 1,
      props: {
        style: { padTop: "6", padBottom: "6", background: "#0f172a", textColor: "#ffffff" },
        className: "hero-band",
        css: "& { border-bottom: 1px solid #1e293b; }",
      },
      children: [
        {
          id: "b2",
          type: "core.heading",
          version: 1,
          props: { text: "Welcome", level: 1, animation: { entrance: "fade-up" } },
        },
        {
          id: "b3",
          type: "core.columns",
          version: 1,
          props: {},
          children: [
            {
              id: "b4",
              type: "core.column",
              version: 1,
              props: {},
              children: [{ id: "b5", type: "core.paragraph", version: 1, props: { text: "<p>Left <strong>column</strong></p>" } }],
            },
            {
              id: "b6",
              type: "core.column",
              version: 1,
              props: { devices: ["desktop", "tablet"] },
              children: [{ id: "b7", type: "core.button", version: 1, props: { label: "Start", url: "/start" } }],
            },
          ],
        },
      ],
    },
    {
      id: "b8",
      type: "core.grid",
      version: 1,
      props: { columns: 12 },
      children: [
        { id: "b9", type: "core.image", version: 1, props: { src: "/uploads/a.jpg", alt: "A", gridPlacement: { col: 1, span: 6 } } },
        { id: "b10", type: "core.image", version: 1, props: { src: "/uploads/b.jpg", alt: "B", gridPlacement: { col: 7, span: 6 } } },
      ],
    },
  ],
};

/** A saved header's block list, as `page-header.ts` stores it. */
export const headerDocument: FixtureDocument = {
  version: 1,
  blocks: [
    { id: "h1", type: "core.site-logo", version: 1, props: {} },
    { id: "h2", type: "core.navigation", version: 1, props: { menu: "primary" } },
    { id: "h3", type: "core.button", version: 1, props: { label: "Sign up", url: "/register", style: { radius: "pill" } } },
  ],
};

/** The footer template part. */
export const footerDocument: FixtureDocument = {
  version: 1,
  blocks: [
    {
      id: "f1",
      type: "core.container",
      version: 1,
      props: {},
      children: [
        { id: "f2", type: "core.paragraph", version: 1, props: { text: "<p>© Example</p>" } },
        { id: "f3", type: "core.link-list", version: 1, props: { items: [{ label: "Privacy", url: "/privacy" }] } },
      ],
    },
  ],
};

/** A site template override with server-provided dynamic blocks. */
export const templateDocument: FixtureDocument = {
  version: 1,
  blocks: [
    {
      id: "t1",
      type: "core.section",
      version: 1,
      props: {},
      children: [
        { id: "t2", type: "core.post-title", version: 1, props: {} },
        { id: "t3", type: "core.post-meta", version: 1, props: {} },
        { id: "t4", type: "core.post-content", version: 1, props: {} },
      ],
    },
  ],
};

/** One reusable block entry's tree. */
export const reusableDocument: FixtureDocument = {
  version: 1,
  blocks: [
    {
      id: "r1",
      type: "core.cta",
      version: 1,
      props: { title: "Ready?", buttonLabel: "Go", buttonUrl: "https://example.com/" },
    },
  ],
};

/** A site pattern, in the `BlockPatternSchema` shape. */
export const patternDefinition = {
  id: "pricing-row",
  title: "Pricing row",
  requiresBlockTypes: ["acme.price-card"],
  blocks: [
    {
      id: "p1",
      type: "core.columns",
      version: 1,
      props: {},
      children: [
        {
          id: "p2",
          type: "core.column",
          version: 1,
          props: {},
          children: [{ id: "p3", type: "acme.price-card", version: 1, props: { plan: "Starter", price: 9 } }],
        },
      ],
    },
  ],
};

/** A page that uses a plugin block, which core does not know. */
export const pluginDocument: FixtureDocument = {
  version: 1,
  blocks: [
    {
      id: "x1",
      type: "acme.slider",
      version: 1,
      props: {
        autoplay: true,
        images: [{ src: "/uploads/s1.jpg", alt: "One" }, { src: "/uploads/s2.jpg", alt: "Two" }],
      },
    },
  ],
};

export const allFixtureDocuments: Record<string, FixtureDocument> = {
  page: pageDocument,
  header: headerDocument,
  footer: footerDocument,
  template: templateDocument,
  reusable: reusableDocument,
  pattern: { version: 1, blocks: patternDefinition.blocks },
  plugin: pluginDocument,
};
