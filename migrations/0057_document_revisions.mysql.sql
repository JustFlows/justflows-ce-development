/**
 * Optimistic concurrency for site-wide builder documents (justflows-ce#302).
 * Every write to a header library, footer, widget area, or template override
 * bumps `revision`; a save that names an older revision is refused instead of
 * overwriting another editor's work.
 */
ALTER TABLE template_parts ADD COLUMN revision INT NOT NULL DEFAULT 1;
ALTER TABLE theme_templates ADD COLUMN revision INT NOT NULL DEFAULT 1;
