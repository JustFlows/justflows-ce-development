import { publicAdminPath } from "../../../admin-path";
import { type Translate } from "../../../i18n/translate";
import { translateEnglish } from "../../../i18n/translate-english";
import { useEffect, useState } from "react";
import { usePluginMenu } from "@components/PluginMenuProvider";
import { useSession } from "@components/SessionProvider";
import { useT } from "../../../i18n/I18nProvider";
import {
  ExtensionAutoUpdateToggle,
  ExtensionUpdateBadge,
  ExtensionUpdateButton,
  ExtensionUpdatesBar,
  useExtensionUpdates,
} from "@components/ExtensionUpdates";
import { sendWithPermissionApproval } from "../../../lib/plugin-permission-approval";

/** The official platform's host. Read from a URL so the admin catalog check does not take it for a `platform.*` translation key. */
const OFFICIAL_PLATFORM_HOST = new URL("https://platform.justflows.com").hostname;

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
  /** SPDX license. `LicenseRef-<name>` marks closed source. */
  license?: string;
  /**
   * Set by the registry from the owning publisher account (justflows-ce#272).
   * Older registries omit it; only the official namespace counts then.
   */
  official?: boolean;
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
    beta?: boolean;
    price?: RegistryPrice;
  };
}

/** Same rule as the SDK's `isClosedLicense`: an SPDX `LicenseRef-<name>` license. */
export function isClosedLicense(license: string | undefined): boolean {
  return typeof license === "string" && /^LicenseRef-[A-Za-z0-9][A-Za-z0-9.-]{0,63}$/.test(license.trim());
}

export function listingIsPaid(item: MarketplaceItem): boolean {
  if (typeof item.registry?.free === "boolean") return !item.registry.free;
  return item.pricing?.type === "paid" || item.channel === "commercial";
}

export function listingIsComingSoon(item: MarketplaceItem): boolean {
  return item.registry?.comingSoon === true;
}

export function listingIsBeta(item: MarketplaceItem): boolean {
  return item.registry?.beta === true;
}

export function listingPriceLabel(item: MarketplaceItem, t: Translate = translateEnglish): string | null {
  if (!listingIsPaid(item)) return null;
  const price = item.registry?.price;
  const amount = price?.amount ?? item.pricing?.amount;
  const currency = price?.currency ?? item.pricing?.currency;
  if (amount == null || !currency) return listingIsPaid(item) ? t("common.paid") : null;
  try {
    const formatted = new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
    if (price?.interval === "month") return `${formatted} / month`;
    if (price?.interval === "year") return `${formatted} / year`;
    return formatted;
  } catch {
    return `${amount} ${currency}`;
  }
}

export function installedPackageIds(
  plugins: { id?: string; plugin_id?: string }[],
  themes: { themeId?: string; theme_id?: string; id?: string }[],
): Set<string> {
  return new Set([
    ...plugins.map((plugin) => plugin.id ?? plugin.plugin_id),
    ...themes.map((theme) => theme.themeId ?? theme.theme_id ?? theme.id),
  ].filter((id): id is string => Boolean(id)));
}

const CATEGORIES = ["All", "Plugins", "Themes", "SEO", "Forms", "Analytics", "Media", "E-commerce"];

const CATEGORY_LABEL_KEYS: Record<string, string> = {
  All: "marketplace.categories.all",
  Plugins: "marketplace.categories.plugins",
  Themes: "marketplace.categories.themes",
  SEO: "marketplace.categories.seo",
  Forms: "marketplace.categories.forms",
  Analytics: "marketplace.categories.analytics",
  Media: "marketplace.categories.media",
  "E-commerce": "marketplace.categories.ecommerce",
};

export default function MarketplacePage() {
  const { t } = useT();
  const installationRoot = useSession().session?.installationRoot !== false;
  /** UI convenience only; the registry still authenticates the platform token server-side. */
  const [officialPlatformEarlyAccess, setOfficialPlatformEarlyAccess] = useState(false);
  const [items, setItems] = useState<MarketplaceItem[]>([]);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All");
  const [installing, setInstalling] = useState<string | null>(null);
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const { refresh: refreshMenu } = usePluginMenu();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [allowBeta, setAllowBeta] = useState(false);
  const updates = useExtensionUpdates(true);

  useEffect(() => {
    setOfficialPlatformEarlyAccess(window.location.hostname === OFFICIAL_PLATFORM_HOST);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [marketRes, pluginsRes, themesRes, settingsRes] = await Promise.all([
          fetch("/api/marketplace"),
          fetch("/api/plugins"),
          fetch("/api/themes"),
          fetch("/api/settings"),
        ]);
        const market = (await marketRes.json()) as { items?: MarketplaceItem[]; error?: string };
        if (market.error) throw new Error(market.error);
        const plugins = (await pluginsRes.json()) as { plugins?: { id?: string; plugin_id?: string }[] };
        const themes = (await themesRes.json()) as {
          themes?: { themeId?: string; theme_id?: string; id?: string }[];
        };
        const settings = (await settingsRes.json().catch(() => ({}))) as {
          marketplace_allow_beta?: boolean;
        };
        if (cancelled) return;
        setAllowBeta(settings.marketplace_allow_beta === true);
        /**
         * The server already dropped hidden listings. It alone knows whether
         * this install is the platform, which also sees platform-only ones.
         */
        setItems(Array.isArray(market.items) ? market.items : []);
        setInstalled(installedPackageIds(plugins.plugins ?? [], themes.themes ?? []));
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
    if (listingIsBeta(item) && !window.confirm(t("marketplace.betaInstallConfirm", { name: item.name }))) {
      return;
    }
    setInstalling(item.id);
    setError("");
    try {
      const res = await sendWithPermissionApproval(
        (approvedPermissions, signal) =>
          fetch("/api/marketplace/install", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: item.type, id: item.id, version: item.version, approvedPermissions }),
            signal,
          }),
        (name, permissions) =>
          window.confirm(t("plugins.permissionApprovalConfirm", { name, permissions: permissions.join("\n") })),
        45_000,
      );
      const data = await res.json() as { error?: string; checkoutUrl?: string };
      if (res.status === 403) {
        throw new Error(data.error ?? t("marketplace.comingSoonInstallError"));
      }
      if (res.status === 402) {
        window.open(data.checkoutUrl ?? "https://justflows.com/marketplace", "_blank");
        throw new Error(data.error ?? t("marketplace.commercialListingError"));
      }
      if (!res.ok) throw new Error(data.error ?? t("marketplace.installFailed"));
      setInstalled((prev) => new Set(prev).add(item.id));
      // A newly installed plugin may own admin pages — surface them right away.
      if (item.type === "plugin") await refreshMenu();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setError(t("marketplace.installTimeout"));
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setInstalling(null);
    }
  }

  return (
    <div className="jf-page">
      <header className="jf-pagehead">
        <div className="jf-pagehead__text">
          <h1>{t("marketplace.title")}</h1>
          <p>{t("marketplace.subtitle")}</p>
        </div>
      </header>

      <div className="jf-stack jf-stack--sm">
        {error && <div className="jf-alert jf-alert--error" role="alert">{error}</div>}
        <input
          type="search"
          className="jf-input"
          placeholder={t("marketplace.searchPlaceholder")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label={t("marketplace.searchAriaLabel")}
        />
        <ExtensionUpdatesBar state={updates} />
        <div className="jf-filterbar">
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              className="jf-chip"
              aria-pressed={category === cat}
              onClick={() => setCategory(cat)}
            >
              {t(CATEGORY_LABEL_KEYS[cat] ?? cat)}
            </button>
          ))}
          <span className="jf-meta" style={{ marginInlineStart: "auto" }}>
            {loading ? t("common.loading") : t("marketplace.resultsCount", { count: filtered.length })}
          </span>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="jf-card">
          <div className="jf-empty">
            <span className="jf-empty__icon" aria-hidden="true">🔍</span>
            <span className="jf-empty__title">{loading ? t("marketplace.loadingCatalogue") : t("marketplace.emptyTitle")}</span>
            <p>{loading ? t("marketplace.loadingListings") : t("marketplace.emptyDesc")}</p>
          </div>
        </div>
      ) : (
        <div className="jf-cardgrid">
          {filtered.map((item) => {
            const isInstalling = installing === item.id;
            const isInstalled = installed.has(item.id);
            const paid = listingIsPaid(item);
            const comingSoon = listingIsComingSoon(item);
            const beta = listingIsBeta(item);
            // Beta listings stay visible so admins know they exist, but only
            // install once the site has opted in.
            const pluginElsewhere = !installationRoot && item.type === "plugin";
            const blocked = (!officialPlatformEarlyAccess && (comingSoon || (beta && !allowBeta))) || pluginElsewhere;
            const priceLabel = listingPriceLabel(item, t);

            return (
              <div key={item.id} className="jf-card">
                <div className="jf-card__body jf-stack jf-stack--sm" style={{ height: "100%" }}>
                  <div className="jf-row">
                    <span className={`jf-badge ${item.type === "theme" ? "jf-badge--warn" : "jf-badge--info"}`}>
                      {item.type}
                    </span>
                    {comingSoon && <span className="jf-badge jf-badge--warn">{t("marketplace.comingSoon")}</span>}
                    {beta && <span className="jf-badge jf-badge--warn">{t("marketplace.beta")}</span>}
                    {paid && <span className="jf-badge">{priceLabel ?? t("common.paid")}</span>}
                    {(item.official ?? item.id.startsWith("justflows.")) ? (
                      <span className="jf-badge jf-badge--info">{t("marketplace.official")}</span>
                    ) : (
                      <span className="jf-badge jf-badge--warn" title={t("marketplace.thirdPartyHint")}>{t("marketplace.thirdParty")}</span>
                    )}
                    {isClosedLicense(item.license) && (
                      <span className="jf-badge" title={t("marketplace.closedSourceHint")}>{t("marketplace.closedSource")}</span>
                    )}
                    {isInstalled && <ExtensionUpdateBadge state={updates} type={item.type} id={item.id} />}
                    <span className="jf-meta" style={{ marginInlineStart: "auto" }}>
                      ↓ {item.downloads.toLocaleString()}
                    </span>
                  </div>

                  <h3 className="jf-section-title">{item.name}</h3>
                  <p className="jf-list__desc" style={{ flex: 1 }}>{item.description}</p>
                  {beta && (
                    <p className="jf-field__hint">
                      {allowBeta || officialPlatformEarlyAccess ? (
                        t("marketplace.betaWarning")
                      ) : (
                        <>
                          {t("marketplace.betaDisabledHint")}{" "}
                          <a href={publicAdminPath("/admin/settings")}>{t("marketplace.betaSettingsLink")}</a>
                        </>
                      )}
                    </p>
                  )}
                  <p className="jf-meta">{t("marketplace.versionBy", { version: item.version, publisher: item.publisher ?? item.author ?? "Justflows" })}</p>

                  {isInstalled && !pluginElsewhere && updates.updateFor(item.type, item.id) ? (
                    <ExtensionUpdateButton
                      state={updates}
                      type={item.type}
                      id={item.id}
                      block
                      onUpdated={() => {
                        if (item.type === "plugin") void refreshMenu();
                      }}
                    />
                  ) : (
                    <button
                      className={`jf-btn jf-btn--block ${isInstalled ? "jf-btn--success" : isInstalling || blocked ? "jf-btn--ghost" : "jf-btn--primary"}`}
                      onClick={() => {
                        if (!blocked) void install(item);
                      }}
                      disabled={isInstalling || isInstalled || blocked}
                    >
                      {isInstalled
                        ? t("marketplace.installedLabel")
                        : isInstalling
                          ? t("marketplace.installing")
                          : comingSoon && !officialPlatformEarlyAccess
                            ? t("marketplace.comingSoon")
                              : pluginElsewhere
                                ? t("marketplace.installOnMainSite")
                              : blocked
                              ? t("marketplace.betaDisabledButton")
                              : paid
                                ? t("marketplace.getOnJustflows")
                                : t("marketplace.install")}
                    </button>
                  )}
                  {isInstalled && !pluginElsewhere && <ExtensionAutoUpdateToggle state={updates} type={item.type} id={item.id} />}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
