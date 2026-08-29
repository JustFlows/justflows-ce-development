import { useEffect, useState } from "react";
import { usePluginMenu } from "@components/PluginMenuProvider";

interface RegistryPrice {
  amount: number;
  currency: string;
  interval?: "once" | "month" | "year";
}

interface MarketplaceItem {
  id: string;
  name: string;
  description: string;
  version: string;
  author?: string;
  publisher?: string;
  downloads: number;
  category: string;
  type: "plugin" | "theme";
  tags: string[];
  channel?: "community" | "commercial";
  pricing?: { type: "free" | "paid"; amount?: number; currency?: string };
  registry?: {
    commercialMarketplace?: boolean;
    listed?: boolean;
    free?: boolean;
    comingSoon?: boolean;
    price?: RegistryPrice;
  };
}

export function listingIsVisible(item: MarketplaceItem): boolean {
  if (typeof item.registry?.listed === "boolean") return item.registry.listed;
  return true;
}

export function listingIsPaid(item: MarketplaceItem): boolean {
  if (typeof item.registry?.free === "boolean") return !item.registry.free;
  return item.pricing?.type === "paid" || item.channel === "commercial";
}

export function listingIsComingSoon(item: MarketplaceItem): boolean {
  return item.registry?.comingSoon === true;
}

export function listingPriceLabel(item: MarketplaceItem): string | null {
  if (!listingIsPaid(item)) return null;
  const price = item.registry?.price;
  const amount = price?.amount ?? item.pricing?.amount;
  const currency = price?.currency ?? item.pricing?.currency;
  if (amount == null || !currency) return listingIsPaid(item) ? "Paid" : null;
  try {
    const formatted = new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
    if (price?.interval === "month") return `${formatted} / month`;
    if (price?.interval === "year") return `${formatted} / year`;
    return formatted;
  } catch {
    return `${amount} ${currency}`;
  }
}

const CATEGORIES = ["All", "Plugins", "Themes", "SEO", "Forms", "Analytics", "Media", "E-commerce"];

export default function MarketplacePage() {
  const [items, setItems] = useState<MarketplaceItem[]>([]);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All");
  const [installing, setInstalling] = useState<string | null>(null);
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const { refresh: refreshMenu } = usePluginMenu();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [marketRes, pluginsRes, themesRes] = await Promise.all([
          fetch("/api/marketplace"),
          fetch("/api/plugins"),
          fetch("/api/themes"),
        ]);
        const market = (await marketRes.json()) as { items?: MarketplaceItem[]; error?: string };
        if (market.error) throw new Error(market.error);
        const plugins = (await pluginsRes.json()) as { plugins?: { id?: string; plugin_id?: string }[] };
        const themes = (await themesRes.json()) as { themes?: { themeId?: string }[] };
        if (cancelled) return;
        setItems(Array.isArray(market.items) ? market.items.filter(listingIsVisible) : []);
        const ids = [
          ...(plugins.plugins ?? []).map((p) => p.id ?? p.plugin_id),
          ...(themes.themes ?? []).map((t) => t.themeId),
        ].filter((id): id is string => Boolean(id));
        setInstalled(new Set(ids));
      } catch (err: unknown) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = items.filter((item) => {
    const matchesSearch =
      !search ||
      item.name.toLowerCase().includes(search.toLowerCase()) ||
      item.description.toLowerCase().includes(search.toLowerCase()) ||
      item.tags.some((t) => t.includes(search.toLowerCase()));

    const matchesCategory =
      category === "All" ||
      (category === "Plugins" && item.type === "plugin") ||
      (category === "Themes" && item.type === "theme") ||
      item.category === category;

    return matchesSearch && matchesCategory;
  });

  async function install(item: MarketplaceItem) {
    setInstalling(item.id);
    setError("");
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 45_000);
    try {
      const res = await fetch("/api/marketplace/install", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: item.type, id: item.id, version: item.version }),
        signal: controller.signal,
      });
      const data = await res.json() as { error?: string; checkoutUrl?: string };
      if (res.status === 403) {
        throw new Error(data.error ?? "This listing is coming soon and cannot be installed yet.");
      }
      if (res.status === 402) {
        window.open(data.checkoutUrl ?? "https://justflows.com/marketplace", "_blank");
        throw new Error(data.error ?? "Commercial listing");
      }
      if (!res.ok) throw new Error(data.error ?? "Install failed");
      setInstalled((prev) => new Set(prev).add(item.id));
      // A newly installed plugin may own admin pages — surface them right away.
      if (item.type === "plugin") await refreshMenu();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setError("Install timed out. Extract the latest justflows.zip, run npm run install:all, and restart Node.js.");
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      window.clearTimeout(timer);
      setInstalling(null);
    }
  }

  return (
    <div className="jf-page">
      <header className="jf-pagehead">
        <div className="jf-pagehead__text">
          <h1>Marketplace</h1>
          <p>Discover and install plugins and themes for your site</p>
        </div>
      </header>

      <div className="jf-stack jf-stack--sm">
        {error && <div className="jf-alert jf-alert--error" role="alert">{error}</div>}
        <input
          type="search"
          className="jf-input"
          placeholder="Search plugins and themes…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search the marketplace"
        />
        <div className="jf-filterbar">
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              className="jf-chip"
              aria-pressed={category === cat}
              onClick={() => setCategory(cat)}
            >
              {cat}
            </button>
          ))}
          <span className="jf-meta" style={{ marginInlineStart: "auto" }}>
            {loading ? "Loading…" : `${filtered.length} result${filtered.length !== 1 ? "s" : ""}`}
          </span>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="jf-card">
          <div className="jf-empty">
            <span className="jf-empty__icon" aria-hidden="true">🔍</span>
            <span className="jf-empty__title">{loading ? "Loading catalogue" : "Nothing matches that search"}</span>
            <p>{loading ? "Fetching listings from the Justflows API." : "Try a different keyword or clear the category filter."}</p>
          </div>
        </div>
      ) : (
        <div className="jf-cardgrid">
          {filtered.map((item) => {
            const isInstalling = installing === item.id;
            const isInstalled = installed.has(item.id);
            const paid = listingIsPaid(item);
            const comingSoon = listingIsComingSoon(item);
            const priceLabel = listingPriceLabel(item);

            return (
              <div key={item.id} className="jf-card">
                <div className="jf-card__body jf-stack jf-stack--sm" style={{ height: "100%" }}>
                  <div className="jf-row">
                    <span className={`jf-badge ${item.type === "theme" ? "jf-badge--warn" : "jf-badge--info"}`}>
                      {item.type}
                    </span>
                    {comingSoon && <span className="jf-badge jf-badge--warn">Coming soon</span>}
                    {paid && <span className="jf-badge">{priceLabel ?? "paid"}</span>}
                    <span className="jf-meta" style={{ marginInlineStart: "auto" }}>
                      ↓ {item.downloads.toLocaleString()}
                    </span>
                  </div>

                  <h3 className="jf-section-title">{item.name}</h3>
                  <p className="jf-list__desc" style={{ flex: 1 }}>{item.description}</p>
                  <p className="jf-meta">v{item.version} · by {item.publisher ?? item.author ?? "Justflows"}</p>

                  <button
                    className={`jf-btn jf-btn--block ${isInstalled ? "jf-btn--success" : isInstalling || comingSoon ? "jf-btn--ghost" : "jf-btn--primary"}`}
                    onClick={() => {
                      if (!comingSoon) void install(item);
                    }}
                    disabled={isInstalling || isInstalled || comingSoon}
                  >
                    {isInstalled
                      ? "✓ Installed"
                      : isInstalling
                        ? "Installing…"
                        : comingSoon
                          ? "Coming soon"
                          : paid
                            ? "Get on Justflows"
                            : "Install"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
