// SPDX-License-Identifier: MIT
import { createContext, useContext } from "react";
import type { TemplateDefaults } from "@justflows/blocks";

/**
 * The template a document renders through and its style defaults
 * (justflows-ce#301), so the canvas shows them beneath each block's own
 * values and the inspector can name them as a layer. `null` when the
 * document is not wrapped by a template (a header, a template itself).
 */
export interface TemplateContextValue {
  slug: string;
  defaults: TemplateDefaults;
}

export const TemplateDefaultsContext = createContext<TemplateContextValue | null>(null);

export function useTemplateContext(): TemplateContextValue | null {
  return useContext(TemplateDefaultsContext);
}
