// SPDX-License-Identifier: MIT

/**
 * Structural CSS for `withWidgetLayout` (widget-areas.ts), baked into `/theme.css` ahead
 * of the theme's own styles. Every selector sits in `:where()` (no
 * specificity), so any theme rule wins. Below 900px the area stacks: above the
 * content for `left` and `top`, below it for `right`.
 */
export function widgetLayoutCss(): string {
  return `:where(.site-main:has(> .jf-widget-layout)) { max-width: var(--max-width-wide, 1140px); }
:where(.jf-widget-layout) { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--jf-widget-gap, 2rem); width: 100%; }
:where(.jf-widget-layout__main, .jf-widget-area) { min-width: 0; }
:where(.jf-widget-area) { display: flex; flex-direction: column; gap: var(--jf-widget-gap, 1.5rem); align-self: start; }
:where(.jf-widget-layout--left, .jf-widget-layout--top) > :where(.jf-widget-area) { grid-row: 1; }
@media (min-width: 900px) {
  :where(.jf-widget-layout--right) { grid-template-columns: minmax(0, 1fr) var(--jf-sidebar-width, 18rem); }
  :where(.jf-widget-layout--left) { grid-template-columns: var(--jf-sidebar-width, 18rem) minmax(0, 1fr); }
  :where(.jf-widget-layout--left) > :where(.jf-widget-area) { grid-column: 1; }
  :where(.jf-widget-layout--left) > :where(.jf-widget-layout__main) { grid-column: 2; grid-row: 1; }
}`;
}
