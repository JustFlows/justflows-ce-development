import { createContext, useContext } from "react";

const TAG_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

export function applyMergeTags(input: string, values: Record<string, string> | undefined): string {
  if (!values || !input.includes("{{")) return input;
  return input.replace(TAG_RE, (match, name: string) => {
    const key = name.toLowerCase();
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key]! : match;
  });
}

export const MergeTagsContext = createContext<Record<string, string> | undefined>(undefined);

export function useMergeTags(): Record<string, string> | undefined {
  return useContext(MergeTagsContext);
}
