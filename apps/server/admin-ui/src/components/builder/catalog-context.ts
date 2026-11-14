// SPDX-License-Identifier: MIT
import { createContext, useContext } from "react";
import type { BlockCatalogEntry } from "./types";

/**
 * The block catalog the builder loaded, for components deep in the canvas
 * that need a block's editor contract (preview mode, actions) without
 * threading the catalog through every preview (justflows-ce#305).
 */
export const BlockCatalogContext = createContext<ReadonlyMap<string, BlockCatalogEntry>>(new Map());

export function useCatalogEntry(type: string): BlockCatalogEntry | undefined {
  return useContext(BlockCatalogContext).get(type);
}
