// SPDX-License-Identifier: MIT

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Whether the current public render is an editor's draft preview
 * (`?preview=1` for a signed-in editor), for code deep in the block render
 * that has no request to look at, such as resolving reusable block drafts
 * (justflows-ce#304). Set once per request with `enterPreviewScope`; absent
 * means a normal visitor render. Shared preview links (`/preview/<token>`)
 * show a stored content version and never enter this scope.
 */
const scope = new AsyncLocalStorage<boolean>();

export function enterPreviewScope(preview: boolean): void {
  scope.enterWith(preview);
}

export function inPreviewScope(): boolean {
  return scope.getStore() === true;
}
