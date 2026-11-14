// SPDX-License-Identifier: MIT

/**
 * Keep rendered block previews inert while editing (justflows-ce#295): a
 * click on a link or a form submit inside a preview must select the block,
 * not navigate away from the builder or post a form. Builder controls mark
 * themselves with `data-builder-chrome` and keep working. Testing real links
 * and forms is done through the top bar's Preview, which opens the page.
 */
export const inertPreviewHandlers = {
  onClickCapture(e: React.MouseEvent) {
    const target = e.target as Element | null;
    const link = target?.closest?.("a[href], area[href]");
    if (link && !link.closest("[data-builder-chrome]")) e.preventDefault();
  },
  onAuxClickCapture(e: React.MouseEvent) {
    const target = e.target as Element | null;
    const link = target?.closest?.("a[href], area[href]");
    if (link && !link.closest("[data-builder-chrome]")) e.preventDefault();
  },
  onSubmitCapture(e: React.FormEvent) {
    const target = e.target as Element | null;
    if (!target?.closest?.("[data-builder-chrome]")) e.preventDefault();
  },
};
