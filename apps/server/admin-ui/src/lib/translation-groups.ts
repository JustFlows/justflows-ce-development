type TranslatableItem = {
  id: string;
  locale: string;
  translationGroupId?: string | null;
};

export function translationGroupKey(item: TranslatableItem): string {
  return item.translationGroupId || item.id;
}

/**
 * One catalog row per translation group. Prefer the site default language.
 * A group that has no default-language entry still appears once, so it can
 * be opened and translated from the editor.
 */
export function catalogRowsForDefaultLanguage<T extends TranslatableItem>(
  items: T[],
  defaultLocale: string,
): T[] {
  const byGroup = new Map<string, T[]>();
  for (const item of items) {
    const key = translationGroupKey(item);
    const group = byGroup.get(key);
    if (group) group.push(item);
    else byGroup.set(key, [item]);
  }

  const seen = new Set<string>();
  const rows: T[] = [];
  for (const item of items) {
    const key = translationGroupKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    const group = byGroup.get(key) ?? [item];
    rows.push(
      group.find((entry) => entry.locale === defaultLocale) ??
        group.find((entry) => entry.id === key) ??
        group[0]!,
    );
  }
  return rows;
}
