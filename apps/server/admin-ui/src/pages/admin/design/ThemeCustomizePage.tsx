import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Link, useNavigate } from "../../../admin-router";
import MediaImageField from "@components/MediaImageField";
import PageBuilder, { type BlockDocument } from "@components/builder/PageBuilder";
import HeaderLibraryEditor from "./HeaderLibraryEditor";
import MenusPage from "./MenusPage";
import { useT } from "../../../i18n/I18nProvider";

type TFunc = (key: string, vars?: Record<string, string | number>) => string;

type ControlType = "color" | "font" | "text" | "image" | "range" | "code" | "select";

interface Control {
  label: string;
  type: ControlType;
  default: string | number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: { label: string; value: string }[];
  description?: string;
}

interface Section {
  label: string;
  controls: Record<string, Control>;
}

interface ThemeMods {
  identity?: Record<string, string>;
  colors?: Record<string, string>;
  colorsDark?: Record<string, string>;
  typography?: Record<string, string | number>;
  headings?: Record<string, string | number>;
  spacing?: Record<string, string | number>;
  radius?: Record<string, string | number>;
  shadow?: Record<string, string>;
  layout?: Record<string, string | number>;
  navigation?: Record<string, string>;
  advanced?: Record<string, string>;
  /** Extra sections a theme contributes through its manifest `customize` block. */
  [section: string]: Record<string, string | number> | undefined;
}

interface ThemePageOption {
  id: string;
  title: string;
  slug: string;
  locale: string;
  status: string;
}

const SECTION_ORDER = [
  "identity",
  "colors",
  "colorsDark",
  "typography",
  "headings",
  "spacing",
  "radius",
  "shadow",
  "layout",
  "navigation",
  "advanced",
] as const;
type EditorTab =
  | "homepage"
  | "blog"
  | "styles"
  | "header"
  | "footer"
  | "menus"
  | "templates"
  | "error-pages";

function isEditorTab(value: string | null): value is EditorTab {
  return value === "homepage" || value === "blog" || value === "styles" || value === "header" ||
    value === "footer" || value === "menus" || value === "templates" || value === "error-pages";
}

interface TemplateSlot {
  slug: string;
  inTheme: boolean;
  customised: boolean;
  hasDraft: boolean;
}

/** Friendly labels for the WordPress-style template slugs — catalog keys, looked up via `t`. */
const TEMPLATE_SLOT_KEYS: Record<string, { labelKey: string; hintKey: string }> = {
  "front-page": { labelKey: "themeCustomize.slotFrontPageLabel", hintKey: "themeCustomize.slotFrontPageHint" },
  home: { labelKey: "themeCustomize.slotHomeLabel", hintKey: "themeCustomize.slotHomeHint" },
  single: { labelKey: "themeCustomize.slotSingleLabel", hintKey: "themeCustomize.slotSingleHint" },
  page: { labelKey: "themeCustomize.slotPageLabel", hintKey: "themeCustomize.slotPageHint" },
  singular: { labelKey: "themeCustomize.slotSingularLabel", hintKey: "themeCustomize.slotSingularHint" },
  archive: { labelKey: "themeCustomize.slotArchiveLabel", hintKey: "themeCustomize.slotArchiveHint" },
  search: { labelKey: "themeCustomize.slotSearchLabel", hintKey: "themeCustomize.slotSearchHint" },
  "404": { labelKey: "themeCustomize.slot404Label", hintKey: "themeCustomize.slot404Hint" },
  "403": { labelKey: "themeCustomize.slot403Label", hintKey: "themeCustomize.slot403Hint" },
  "410": { labelKey: "themeCustomize.slot410Label", hintKey: "themeCustomize.slot410Hint" },
  "429": { labelKey: "themeCustomize.slot429Label", hintKey: "themeCustomize.slot429Hint" },
  error: { labelKey: "themeCustomize.slotErrorLabel", hintKey: "themeCustomize.slotErrorHint" },
  index: { labelKey: "themeCustomize.slotIndexLabel", hintKey: "themeCustomize.slotIndexHint" },
};

function templateSlotLabel(t: TFunc, slug: string): string | undefined {
  const keys = TEMPLATE_SLOT_KEYS[slug];
  return keys ? t(keys.labelKey) : undefined;
}

function templateSlotHint(t: TFunc, slug: string): string | undefined {
  const keys = TEMPLATE_SLOT_KEYS[slug];
  return keys ? t(keys.hintKey) : undefined;
}

type ErrorPageClass = "404" | "403" | "410" | "429";
const ERROR_PAGE_CLASSES: ErrorPageClass[] = ["404", "403", "410", "429"];

interface ErrorPageSourceConfig {
  source: "theme" | "builtin" | "page";
  pageId?: string;
}
type ErrorPageConfig = Partial<Record<ErrorPageClass, ErrorPageSourceConfig>>;

/** One entry per translation group — picking it covers every locale that page has a published translation in. */
interface ErrorPagePickerOption {
  id: string;
  title: string;
  slug: string;
}

function slotLabel(t: TFunc, slug: string): string {
  const known = templateSlotLabel(t, slug);
  if (known) return known;
  // single-product, page-about, … → "Single: product", "Page: about"
  const dash = slug.indexOf("-");
  if (dash > 0) {
    const base = templateSlotLabel(t, slug.slice(0, dash)) ?? slug.slice(0, dash);
    return `${base}: ${slug.slice(dash + 1)}`;
  }
  return slug;
}

function localePath(locale: string, slug: string, defaultLocale: string): string {
  const path = `/${slug}`;
  if (locale === defaultLocale) return path;
  return `/${locale}${path}`;
}

export default function CustomizeThemePage() {
  const navigate = useNavigate();
  const { t } = useT();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const previewPathRef = useRef("/");
  const [layoutScope, setLayoutScope] = useState("site");
  const [layoutTargets, setLayoutTargets] = useState<Array<{ slug: string; label: string; base: string }>>([]);
  const stylesSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [themeName, setThemeName] = useState("");
  const [schema, setSchema] = useState<Record<string, Section>>({});
  const [mods, setMods] = useState<ThemeMods>({});
  const [pages, setPages] = useState<ThemePageOption[]>([]);
  const [homePageId, setHomePageId] = useState<string | null>(null);
  const [converting, setConverting] = useState(false);
  const [blogPageId, setBlogPageId] = useState<string | null>(null);
  const [convertingBlog, setConvertingBlog] = useState(false);
  const [defaultLocale, setDefaultLocale] = useState("en-US");
  const [openSection, setOpenSection] = useState<string>("identity");
  const [footer, setFooter] = useState<BlockDocument>({ version: 1, blocks: [] });
  const [footerSaving, setFooterSaving] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = searchParams.get("tab");
  const [tab, setTabState] = useState<EditorTab>(isEditorTab(initialTab) ? initialTab : "homepage");
  const setTab = useCallback(
    (next: EditorTab) => {
      setTabState(next);
      setSearchParams((prev) => {
        const params = new URLSearchParams(prev);
        if (next === "homepage") params.delete("tab");
        else params.set("tab", next);
        return params;
      }, { replace: true });
    },
    [setSearchParams],
  );

  const [templateSlots, setTemplateSlots] = useState<TemplateSlot[]>([]);
  const [creatableSlots, setCreatableSlots] = useState<string[]>([]);
  const [templateSlug, setTemplateSlug] = useState<string | null>(null);
  const [templateDoc, setTemplateDoc] = useState<BlockDocument>({ version: 1, blocks: [] });
  const [templateFromDefault, setTemplateFromDefault] = useState(false);
  const [templateSaving, setTemplateSaving] = useState(false);

  const loadTemplateList = useCallback(async () => {
    try {
      const res = await fetch("/api/templates");
      const data = (await res.json()) as { slots?: TemplateSlot[]; creatable?: string[] };
      setTemplateSlots(data.slots ?? []);
      setCreatableSlots(data.creatable ?? []);
    } catch {
      /* leave as-is */
    }
  }, []);

  const openTemplate = useCallback(async (slug: string) => {
    setTemplateSlug(slug);
    setTemplateDoc({ version: 1, blocks: [] });
    try {
      const res = await fetch(`/api/templates/${encodeURIComponent(slug)}`);
      const data = (await res.json()) as {
        blocks?: unknown[];
        draft?: unknown[];
        fromThemeDefault?: boolean;
      };
      const blocks = (data.draft?.length ? data.draft : data.blocks) ?? [];
      setTemplateDoc({ version: 1, blocks: blocks as BlockDocument["blocks"] });
      setTemplateFromDefault(Boolean(data.fromThemeDefault));
    } catch {
      /* leave empty */
    }
  }, []);

  useEffect(() => {
    if (tab === "templates" && templateSlots.length === 0) void loadTemplateList();
  }, [tab, templateSlots.length, loadTemplateList]);

  const [errorPages, setErrorPages] = useState<ErrorPageConfig>({});
  const [errorThemeSlots, setErrorThemeSlots] = useState<string[]>([]);
  const [errorPagePickerOptions, setErrorPagePickerOptions] = useState<ErrorPagePickerOption[]>([]);
  const [errorPagesLoaded, setErrorPagesLoaded] = useState(false);
  const [errorPageSaving, setErrorPageSaving] = useState<ErrorPageClass | null>(null);

  const loadErrorPages = useCallback(async () => {
    try {
      const res = await fetch("/api/error-pages");
      const data = (await res.json()) as {
        config?: ErrorPageConfig;
        themeSlots?: string[];
        pages?: ErrorPagePickerOption[];
      };
      setErrorPages(data.config ?? {});
      setErrorThemeSlots(data.themeSlots ?? []);
      setErrorPagePickerOptions(data.pages ?? []);
    } catch {
      /* leave as-is */
    } finally {
      setErrorPagesLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (tab === "error-pages" && !errorPagesLoaded) void loadErrorPages();
  }, [tab, errorPagesLoaded, loadErrorPages]);

  async function updateErrorPageSource(
    errorClass: ErrorPageClass,
    source: ErrorPageSourceConfig["source"],
    pageId?: string,
  ) {
    setErrorPageSaving(errorClass);
    setError("");
    try {
      const res = await fetch("/api/error-pages", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [errorClass]: { source, pageId } }),
      });
      const data = (await res.json()) as { error?: string; config?: ErrorPageConfig };
      if (!res.ok) throw new Error(data.error ?? t("themeCustomize.errorPageSaveError"));
      setErrorPages(data.config ?? {});
      reloadPreview();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setErrorPageSaving(null);
    }
  }

  function errorPageSelectValue(errorClass: ErrorPageClass): string {
    const entry = errorPages[errorClass];
    if (!entry || entry.source === "theme") return "theme";
    if (entry.source === "builtin") return "builtin";
    return entry.pageId ? `page:${entry.pageId}` : "theme";
  }

  function onErrorPageSelectChange(errorClass: ErrorPageClass, value: string) {
    if (value === "theme") { void updateErrorPageSource(errorClass, "theme"); return; }
    if (value === "builtin") { void updateErrorPageSource(errorClass, "builtin"); return; }
    if (value.startsWith("page:")) void updateErrorPageSource(errorClass, "page", value.slice(5));
  }

  const reloadPreview = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const path = previewPathRef.current || "/";
    const join = path.includes("?") ? "&" : "?";
    iframe.src = `${path}${join}preview=1&_=${Date.now()}`;
  }, []);

  function selectLayoutScope(scope: string) {
    setLayoutScope(scope);
    const target = layoutTargets.find((item) => item.slug === scope);
    previewPathRef.current = target ? `/${target.base}` : "/";
    reloadPreview();
  }

  useEffect(() => {
    fetch("/api/template-parts/footer")
      .then((r) => r.json())
      .then((data: { blocks?: unknown[]; draft?: unknown[] }) => {
        const blocks = (data.draft?.length ? data.draft : data.blocks) ?? [];
        setFooter({ version: 1, blocks: blocks as BlockDocument["blocks"] });
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/languages/active")
      .then((r) => r.json())
      .then((data: { languages?: { code: string; isDefault?: boolean }[] }) => {
        const langs = data.languages ?? [];
        setDefaultLocale(langs.find((l) => l.isDefault)?.code ?? langs[0]?.code ?? "en-US");
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/themes/customize")
      .then(async (r) => {
        const data = (await r.json()) as {
          error?: string;
          theme?: { name: string };
          schema?: Record<string, Section>;
          mods?: ThemeMods;
          homePageId?: string | null;
          blogPageId?: string | null;
          pages?: ThemePageOption[];
          layoutScopes?: Array<{ id: string; label: string; base: string }>;
        };
        if (!r.ok) throw new Error(data.error ?? t("themeCustomize.loadError"));
        setThemeName(data.theme?.name ?? t("themeCustomize.themeFallbackName"));
        setSchema(data.schema ?? {});
        setMods(data.mods ?? {});
        setLayoutTargets(
          (data.layoutScopes ?? []).map((scope) => ({
            slug: scope.id,
            label: scope.label,
            base: scope.base,
          })),
        );
        setHomePageId(data.homePageId ?? null);
        setBlogPageId(data.blogPageId ?? null);
        setPages(data.pages ?? []);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const persist = useCallback(
    async (publish = false) => {
      setSaving(!publish);
      setPublishing(publish);
      setError("");
      try {
        const res = await fetch("/api/themes/customize", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mods, draft: !publish, publish }),
        });
        const data = (await res.json()) as { error?: string; mods?: ThemeMods };
        if (!res.ok) throw new Error(data.error ?? t("themeCustomize.saveError"));
        if (data.mods) setMods(data.mods);
        setDirty(false);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
        reloadPreview();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(false);
        setPublishing(false);
      }
    },
    [mods, reloadPreview],
  );

  const queueStylesSave = useCallback(
    (nextMods: ThemeMods) => {
      if (stylesSaveTimer.current) clearTimeout(stylesSaveTimer.current);
      stylesSaveTimer.current = setTimeout(async () => {
        setSaving(true);
        setError("");
        try {
          const res = await fetch("/api/themes/customize", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mods: nextMods, draft: true, publish: false }),
          });
          const data = (await res.json()) as { error?: string };
          if (!res.ok) throw new Error(data.error ?? t("themeCustomize.saveDraftError"));
          reloadPreview();
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setSaving(false);
        }
      }, 400);
    },
    [reloadPreview],
  );

  async function selectHomePage(contentId: string | null) {
    setError("");
    setSaving(true);
    try {
      const res = await fetch("/api/settings/home-page", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentId }),
      });
      const data = (await res.json()) as { error?: string; homePageId?: string | null };
      if (!res.ok) throw new Error(data.error ?? t("themeCustomize.homePageError"));
      setHomePageId(data.homePageId ?? null);
      reloadPreview();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function convertThemeHome() {
    if (!window.confirm(t("themeCustomize.convertHomeConfirm")))
      return;
    setConverting(true);
    setError("");
    try {
      const res = await fetch("/api/themes/customize/promote-home", { method: "POST" });
      const data = (await res.json()) as {
        error?: string;
        homePageId?: string;
        page?: ThemePageOption;
      };
      if (!res.ok) throw new Error(data.error ?? t("themeCustomize.createHomePageError"));
      if (data.page)
        setPages((prev) => [data.page!, ...prev.filter((p) => p.id !== data.page!.id)]);
      setHomePageId(data.homePageId ?? null);
      reloadPreview();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setConverting(false);
    }
  }

  async function selectBlogPage(contentId: string | null) {
    setError("");
    setSaving(true);
    try {
      const res = await fetch("/api/settings/blog-page", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentId }),
      });
      const data = (await res.json()) as { error?: string; blogPageId?: string | null };
      if (!res.ok) throw new Error(data.error ?? t("themeCustomize.blogPageError"));
      setBlogPageId(data.blogPageId ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function convertThemeBlog() {
    if (!window.confirm(t("themeCustomize.convertBlogConfirm")))
      return;
    setConvertingBlog(true);
    setError("");
    try {
      const res = await fetch("/api/themes/customize/promote-blog", { method: "POST" });
      const data = (await res.json()) as {
        error?: string;
        blogPageId?: string;
        page?: ThemePageOption;
      };
      if (!res.ok) throw new Error(data.error ?? t("themeCustomize.createBlogPageError"));
      if (data.page)
        setPages((prev) => [data.page!, ...prev.filter((p) => p.id !== data.page!.id)]);
      setBlogPageId(data.blogPageId ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setConvertingBlog(false);
    }
  }

  function updateMod(section: string, key: string, value: string | number) {
    setMods((prev) => {
      const next = {
        ...prev,
        [section]: { ...(prev[section] ?? {}), [key]: value },
      };
      queueStylesSave(next);
      return next;
    });
  }

  async function saveFooter(publish: boolean) {
    setFooterSaving(true);
    setError("");
    try {
      const res = await fetch("/api/template-parts/footer", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blocks: footer.blocks, draft: !publish }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? t("themeCustomize.footerSaveError"));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      reloadPreview();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setFooterSaving(false);
    }
  }

  async function saveTemplate(publish: boolean) {
    if (!templateSlug) return;
    setTemplateSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/templates/${encodeURIComponent(templateSlug)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blocks: templateDoc.blocks, draft: !publish }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? t("themeCustomize.templateSaveError"));
      setSaved(true);
      setTemplateFromDefault(false);
      setTimeout(() => setSaved(false), 2000);
      await loadTemplateList();
      reloadPreview();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTemplateSaving(false);
    }
  }

  async function resetTemplate() {
    if (!templateSlug) return;
    if (!window.confirm(t("themeCustomize.resetTemplateConfirm", { slug: templateSlug })))
      return;
    setTemplateSaving(true);
    try {
      await fetch(`/api/templates/${encodeURIComponent(templateSlug)}`, { method: "DELETE" });
      const slug = templateSlug;
      await loadTemplateList();
      await openTemplate(slug);
      reloadPreview();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTemplateSaving(false);
    }
  }

  const [savingAs, setSavingAs] = useState(false);

  async function saveAsTheme() {
    const name = window.prompt(
      t("themeCustomize.saveAsPrompt"),
      t("themeCustomize.saveAsDefaultName", { name: themeName }),
    );
    if (name == null || !name.trim()) return;
    setSavingAs(true);
    setError("");
    try {
      const res = await fetch("/api/themes/save-as", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), activate: true }),
      });
      const data = (await res.json()) as { error?: string; themeId?: string };
      if (!res.ok) throw new Error(data.error ?? t("themeCustomize.saveThemeError"));
      navigate("/admin/themes");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingAs(false);
    }
  }

  async function exitCustomize() {
    if (dirty && !window.confirm(t("themeCustomize.exitConfirm"))) return;
    await fetch("/api/themes/customize", { method: "DELETE" }).catch(() => {});
    navigate("/admin/themes");
  }

  if (loading) return <div className="jf-center">{t("themeCustomize.loading")}</div>;

  if (error && !themeName) {
    return (
      <div className="jf-center">
        <div className="jf-stack" style={{ alignItems: "center" }}>
          <div className="jf-alert jf-alert--error">{error}</div>
          <button className="jf-btn jf-btn--ghost" onClick={() => navigate("/admin/themes")}>
            {t("themeCustomize.backToThemes")}
          </button>
        </div>
      </div>
    );
  }

  const selectedHome = pages.find((page) => page.id === homePageId) ?? null;
  const selectedBlog = pages.find((page) => page.id === blogPageId) ?? null;
  const blogPreviewSrc = selectedBlog
    ? `${localePath(selectedBlog.locale, selectedBlog.slug, defaultLocale)}?preview=1`
    : null;

  return (
    <div className="jf-editor">
      <header className="jf-editor__bar">
        <button type="button" className="jf-btn jf-btn--onbar" onClick={exitCustomize}>
          ← {t("themeCustomize.exit")}
        </button>

        <div className="jf-editor__title">
          <div className="jf-editor__name">{t("themeCustomize.headerTitle", { themeName })}</div>
          <div className="jf-editor__sub">
            {tab === "homepage"
              ? t("themeCustomize.subHomepage")
              : tab === "blog"
                ? t("themeCustomize.subBlog")
                : tab === "header"
                  ? t("themeCustomize.subHeader")
                  : tab === "footer"
                    ? t("themeCustomize.subFooter")
                    : tab === "templates"
                      ? t("themeCustomize.subTemplates")
                      : t("themeCustomize.subStyles")}
            {dirty ? t("themeCustomize.unsavedSuffix") : ""}
          </div>
        </div>

        <div className="jf-editor__actions">
          {saved && <span className="jf-editor__status jf-editor__status--ok">✓ {t("common.saved")}</span>}
          {saving && !publishing && <span className="jf-editor__status">{t("common.saving")}</span>}
          {error && <span className="jf-editor__status jf-editor__status--error">{error}</span>}
          <a className="jf-btn jf-btn--onbar" href="/?preview=1" target="_blank" rel="noreferrer">
            {t("themeCustomize.preview")} ↗
          </a>
          <button
            type="button"
            className="jf-btn jf-btn--onbar"
            disabled={savingAs}
            onClick={() => void saveAsTheme()}
            title={t("themeCustomize.saveAsTitle")}
          >
            {savingAs ? t("common.saving") : t("themeCustomize.saveAsButton")}
          </button>
          {tab === "styles" && (
            <>
              <button
                type="button"
                className="jf-btn jf-btn--onbar"
                disabled={saving || publishing}
                onClick={() => persist(false)}
              >
                {saving ? t("common.saving") : t("content.saveDraft")}
              </button>
              <button
                type="button"
                className="jf-btn jf-btn--primary"
                disabled={saving || publishing}
                onClick={() => persist(true)}
              >
                {publishing ? t("themeCustomize.publishing") : t("content.publish")}
              </button>
            </>
          )}
          {tab === "footer" && (
            <>
              <button
                type="button"
                className="jf-btn jf-btn--onbar"
                disabled={footerSaving}
                onClick={() => void saveFooter(false)}
              >
                {footerSaving ? t("common.saving") : t("content.saveDraft")}
              </button>
              <button
                type="button"
                className="jf-btn jf-btn--primary"
                disabled={footerSaving}
                onClick={() => void saveFooter(true)}
              >
                {t("content.publish")}
              </button>
            </>
          )}
          {tab === "templates" && templateSlug && (
            <>
              {templateSlots.find((s) => s.slug === templateSlug)?.customised && (
                <button
                  type="button"
                  className="jf-btn jf-btn--onbar"
                  disabled={templateSaving}
                  onClick={() => void resetTemplate()}
                >
                  {t("themeCustomize.resetToTheme")}
                </button>
              )}
              <button
                type="button"
                className="jf-btn jf-btn--onbar"
                disabled={templateSaving}
                onClick={() => void saveTemplate(false)}
              >
                {templateSaving ? t("common.saving") : t("content.saveDraft")}
              </button>
              <button
                type="button"
                className="jf-btn jf-btn--primary"
                disabled={templateSaving}
                onClick={() => void saveTemplate(true)}
              >
                {t("content.publish")}
              </button>
            </>
          )}
        </div>
      </header>

      <div className="jf-theme-builder__tabs">
        <button
          type="button"
          className={`jf-theme-builder__tab${tab === "homepage" ? " jf-theme-builder__tab--active" : ""}`}
          onClick={() => setTab("homepage")}
        >
          {t("themeCustomize.tabHomepage")}
        </button>
        <button
          type="button"
          className={`jf-theme-builder__tab${tab === "blog" ? " jf-theme-builder__tab--active" : ""}`}
          onClick={() => setTab("blog")}
        >
          {t("themeCustomize.tabBlog")}
        </button>
        <button
          type="button"
          className={`jf-theme-builder__tab${tab === "styles" ? " jf-theme-builder__tab--active" : ""}`}
          onClick={() => setTab("styles")}
        >
          {t("themeCustomize.tabStyles")}
        </button>
        <button
          type="button"
          className={`jf-theme-builder__tab${tab === "header" ? " jf-theme-builder__tab--active" : ""}`}
          onClick={() => setTab("header")}
        >
          {t("themeCustomize.tabHeader")}
        </button>
        <button
          type="button"
          className={`jf-theme-builder__tab${tab === "footer" ? " jf-theme-builder__tab--active" : ""}`}
          onClick={() => setTab("footer")}
        >
          {t("themeCustomize.tabFooter")}
        </button>
        <button
          type="button"
          className={`jf-theme-builder__tab${tab === "menus" ? " jf-theme-builder__tab--active" : ""}`}
          onClick={() => setTab("menus")}
        >
          {t("nav.menus")}
        </button>
        <button
          type="button"
          className={`jf-theme-builder__tab${tab === "templates" ? " jf-theme-builder__tab--active" : ""}`}
          onClick={() => setTab("templates")}
        >
          {t("themeCustomize.tabTemplates")}
        </button>
        <button
          type="button"
          className={`jf-theme-builder__tab${tab === "error-pages" ? " jf-theme-builder__tab--active" : ""}`}
          onClick={() => setTab("error-pages")}
        >
          {t("themeCustomize.tabErrorPages")}
        </button>
      </div>

      {tab === "homepage" ? (
        <div className="jf-customizer">
          <aside className="jf-customizer__controls" style={{ padding: "1rem" }}>
            <div className="jf-field">
              <label className="jf-field__label" htmlFor="jf-home-page">
                {t("themeCustomize.homePageLabel")}
              </label>
              <select
                id="jf-home-page"
                className="jf-input"
                value={homePageId ?? ""}
                disabled={saving || converting}
                onChange={(e) => selectHomePage(e.target.value || null)}
              >
                <option value="">{t("themeCustomize.themeLayoutOption")}</option>
                {pages.map((page) => (
                  <option key={page.id} value={page.id}>
                    {page.title || page.slug}{" "}
                    {page.status !== "published" ? `(${page.status})` : ""}
                  </option>
                ))}
              </select>
              <p className="jf-field__hint">
                {t("themeCustomize.homeHint")}
              </p>
            </div>
            {selectedHome ? (
              <div className="jf-stack" style={{ gap: "0.6rem" }}>
                <Link
                  className="jf-btn jf-btn--primary jf-btn--block"
                  to={`/admin/content/${selectedHome.id}/builder`}
                >
                  {t("themeCustomize.editThisPage")}
                </Link>
                <Link
                  className="jf-btn jf-btn--ghost jf-btn--block"
                  to={`/admin/content/${selectedHome.id}`}
                >
                  {t("themeCustomize.pageSettings")}
                </Link>
                <p className="jf-field__hint" style={{ margin: 0 }}>
                  {t("themeCustomize.liveAtHome", { slug: selectedHome.slug })}
                </p>
              </div>
            ) : (
              <div className="jf-stack" style={{ gap: "0.6rem" }}>
                <button
                  type="button"
                  className="jf-btn jf-btn--primary jf-btn--block"
                  disabled={converting}
                  onClick={() => void convertThemeHome()}
                >
                  {converting ? t("themeCustomize.creating") : t("themeCustomize.turnHomeIntoPage")}
                </button>
                <Link
                  className="jf-btn jf-btn--ghost jf-btn--block"
                  to="/admin/content/new?type=page"
                >
                  {t("themeCustomize.createNewPage")}
                </Link>
                <p className="jf-field__hint" style={{ margin: 0 }}>
                  {t("themeCustomize.homeFallbackHint")}
                </p>
              </div>
            )}
          </aside>
          <div className="jf-customizer__preview">
            <div className="jf-card__title">{t("themeCustomize.livePreview")}</div>
            <iframe ref={iframeRef} src="/?preview=1" title={t("themeCustomize.homePreviewTitle")} />
          </div>
        </div>
      ) : tab === "blog" ? (
        <div className="jf-customizer">
          <aside className="jf-customizer__controls" style={{ padding: "1rem" }}>
            <div className="jf-field">
              <label className="jf-field__label" htmlFor="jf-blog-page">
                {t("themeCustomize.blogPageLabel")}
              </label>
              <select
                id="jf-blog-page"
                className="jf-input"
                value={blogPageId ?? ""}
                disabled={saving || convertingBlog}
                onChange={(e) => selectBlogPage(e.target.value || null)}
              >
                <option value="">{t("themeCustomize.noBlogPageOption")}</option>
                {pages.map((page) => (
                  <option key={page.id} value={page.id}>
                    {page.title || page.slug}{" "}
                    {page.status !== "published" ? `(${page.status})` : ""}
                  </option>
                ))}
              </select>
              <p className="jf-field__hint">
                {t("themeCustomize.blogHint")}
              </p>
            </div>
            {selectedBlog ? (
              <div className="jf-stack" style={{ gap: "0.6rem" }}>
                <Link
                  className="jf-btn jf-btn--primary jf-btn--block"
                  to={`/admin/content/${selectedBlog.id}/builder`}
                >
                  {t("themeCustomize.editThisPage")}
                </Link>
                <Link
                  className="jf-btn jf-btn--ghost jf-btn--block"
                  to={`/admin/content/${selectedBlog.id}`}
                >
                  {t("themeCustomize.pageSettings")}
                </Link>
                <p className="jf-field__hint" style={{ margin: 0 }}>
                  {t("themeCustomize.liveAtBlog", { slug: selectedBlog.slug })}
                </p>
              </div>
            ) : (
              <div className="jf-stack" style={{ gap: "0.6rem" }}>
                <button
                  type="button"
                  className="jf-btn jf-btn--primary jf-btn--block"
                  disabled={convertingBlog}
                  onClick={() => void convertThemeBlog()}
                >
                  {convertingBlog ? t("themeCustomize.creating") : t("themeCustomize.turnBlogIntoPage")}
                </button>
                <Link
                  className="jf-btn jf-btn--ghost jf-btn--block"
                  to="/admin/content/new?type=page"
                >
                  {t("themeCustomize.createNewPage")}
                </Link>
                <p className="jf-field__hint" style={{ margin: 0 }}>
                  {t("themeCustomize.blogFallbackHint")}
                </p>
              </div>
            )}
          </aside>
          <div className="jf-customizer__preview">
            <div className="jf-card__title">{t("themeCustomize.livePreview")}</div>
            {blogPreviewSrc ? (
              <iframe src={blogPreviewSrc} title={t("themeCustomize.blogPreviewTitle")} />
            ) : (
              <p className="jf-field__hint" style={{ padding: "1rem" }}>
                {t("themeCustomize.blogPreviewEmpty")}
              </p>
            )}
          </div>
        </div>
      ) : tab === "templates" ? (
        <div className="jf-customizer">
          <aside className="jf-customizer__controls" style={{ padding: "1rem" }}>
            <div className="jf-field">
              <label className="jf-field__label">{t("themeCustomize.templatesLabel")}</label>
              <p className="jf-field__hint" style={{ marginTop: 0 }}>
                {t("themeCustomize.templatesHint")}
              </p>
              <div className="jf-stack" style={{ gap: "0.35rem", marginTop: "0.5rem" }}>
                {templateSlots.length === 0 && (
                  <p className="jf-field__hint" style={{ margin: 0 }}>
                    {t("themeCustomize.noTemplatesHint")}
                  </p>
                )}
                {templateSlots.map((slot) => (
                  <button
                    key={slot.slug}
                    type="button"
                    className={`jf-btn jf-btn--block${
                      templateSlug === slot.slug ? " jf-btn--primary" : " jf-btn--ghost"
                    }`}
                    style={{ justifyContent: "space-between", display: "flex", textAlign: "left" }}
                    title={templateSlotHint(t, slot.slug) ?? slot.slug}
                    onClick={() => void openTemplate(slot.slug)}
                  >
                    <span>
                      {slotLabel(t, slot.slug)}{" "}
                      <span style={{ fontSize: "0.7rem", opacity: 0.6 }}>{slot.slug}</span>
                    </span>
                    <span style={{ fontSize: "0.7rem", opacity: 0.8 }}>
                      {slot.customised ? (slot.hasDraft ? t("themeCustomize.customisedDraft") : t("themeCustomize.customised")) : ""}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {creatableSlots.length > 0 && (
              <div className="jf-field">
                <label className="jf-field__label" htmlFor="jf-add-template">
                  {t("themeCustomize.addTemplateLabel")}
                </label>
                <select
                  id="jf-add-template"
                  className="jf-input"
                  value=""
                  onChange={(e) => {
                    if (e.target.value) void openTemplate(e.target.value);
                  }}
                >
                  <option value="">{t("themeCustomize.chooseSlotOption")}</option>
                  {creatableSlots.map((slug) => (
                    <option key={slug} value={slug}>
                      {slotLabel(t, slug)} ({slug})
                    </option>
                  ))}
                </select>
                <p className="jf-field__hint">
                  {templateSlotHint(t, templateSlug ?? "") ?? t("themeCustomize.blankCanvasHint")}
                </p>
              </div>
            )}
          </aside>
          <div className="jf-customizer__preview" style={{ padding: 0 }}>
            {templateSlug ? (
              <div className="jf-editor__body">
                {templateFromDefault && (
                  <div className="jf-alert" style={{ margin: "0.75rem", fontSize: "0.85rem" }}>
                    {t("themeCustomize.editingFromDefaultPrefix")} <strong>{templateSlug}</strong>{" "}
                    {t("themeCustomize.editingFromDefaultSuffix")}
                  </div>
                )}
                <PageBuilder value={templateDoc} onChange={setTemplateDoc} />
              </div>
            ) : (
              <p className="jf-field__hint" style={{ padding: "1rem" }}>
                {t("themeCustomize.pickTemplateHint")}
              </p>
            )}
          </div>
        </div>
      ) : tab === "error-pages" ? (
        <div className="jf-editor__body" style={{ padding: "1rem", maxWidth: "40rem" }}>
          <div className="jf-field">
            <label className="jf-field__label">{t("themeCustomize.tabErrorPages")}</label>
            <p className="jf-field__hint" style={{ marginTop: 0 }}>
              {t("themeCustomize.errorPagesHint")}
            </p>
            <div className="jf-stack" style={{ gap: "1rem", marginTop: "0.75rem" }}>
              {ERROR_PAGE_CLASSES.map((errorClass) => (
                <div className="jf-field" key={errorClass}>
                  <label className="jf-field__label" htmlFor={`jf-error-page-${errorClass}`}>
                    {templateSlotLabel(t, errorClass) ?? errorClass}
                  </label>
                  <select
                    id={`jf-error-page-${errorClass}`}
                    className="jf-input"
                    value={errorPageSelectValue(errorClass)}
                    disabled={errorPageSaving === errorClass}
                    onChange={(e) => onErrorPageSelectChange(errorClass, e.target.value)}
                  >
                    <option value="theme">
                      {t("themeCustomize.themeLayoutOptionShort")}
                      {errorThemeSlots.includes(errorClass) || errorThemeSlots.includes("error")
                        ? t("themeCustomize.themeProvidesOneSuffix")
                        : ""}
                    </option>
                    <option value="builtin">{t("themeCustomize.builtinDefaultOption")}</option>
                    {errorPagePickerOptions.map((page) => (
                      <option key={page.id} value={`page:${page.id}`}>
                        {page.title || page.slug}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : tab === "footer" ? (
        <div className="jf-editor__body">
          <PageBuilder value={footer} onChange={setFooter} />
        </div>
      ) : tab === "header" ? (
        <div className="jf-editor__body">
          <HeaderLibraryEditor />
        </div>
      ) : tab === "menus" ? (
        <div className="jf-editor__body">
          <MenusPage embedded />
        </div>
      ) : (
        <div className="jf-customizer">
          <aside className="jf-customizer__controls">
            {[
              ...SECTION_ORDER.filter((key) => schema[key]),
              // Sections a theme package added via its manifest `customize`
              // block — rendered after the built-ins, in manifest order.
              ...Object.keys(schema).filter(
                (key) => !SECTION_ORDER.includes(key as (typeof SECTION_ORDER)[number]),
              ),
            ].map((sectionKey) => {
              const section = schema[sectionKey]!;
              const isOpen = openSection === sectionKey;
              return (
                <div key={sectionKey} className="jf-accordion">
                  <button
                    className="jf-accordion__trigger"
                    aria-expanded={isOpen}
                    onClick={() => setOpenSection(isOpen ? "" : sectionKey)}
                  >
                    <span className="jf-accordion__caret" aria-hidden="true">
                      ▸
                    </span>
                    {section.label}
                  </button>
                  {isOpen && (
                    <div className="jf-accordion__panel">
                      {sectionKey === "colorsDark" && (
                        <p className="jf-field__hint">
                          {t("themeCustomize.colorsDarkHint")}
                        </p>
                      )}
                      {sectionKey === "layout" && (
                        <div className="jf-field">
                          <label className="jf-field__label" htmlFor="layout-scope">
                            {t("themeCustomize.layoutScope")}
                          </label>
                          <select
                            className="jf-input"
                            id="layout-scope"
                            value={layoutScope}
                            onChange={(e) => selectLayoutScope(e.target.value)}
                          >
                            <option value="site">{t("themeCustomize.layoutScopeSite")}</option>
                            {layoutTargets.map((target) => (
                              <option key={target.slug} value={target.slug}>
                                {target.label} (/{target.base})
                              </option>
                            ))}
                          </select>
                          <p className="jf-field__hint">{t("themeCustomize.layoutScopeHint")}</p>
                        </div>
                      )}
                      {sectionKey === "navigation" && (
                        <p className="jf-field__hint">
                          {t("themeCustomize.navigationHintPrefix")}{" "}
                          <button type="button" className="jf-linkbtn" onClick={() => setTab("menus")}>
                            {t("themeCustomize.menusTabLink")}
                          </button>
                          {t("themeCustomize.navigationHintSuffix")}
                        </p>
                      )}
                      {Object.entries(section.controls).map(([key, control]) => {
                        const storedKey =
                          sectionKey === "layout" && layoutScope !== "site" ? `${key}__${layoutScope}` : key;
                        return (
                          <ControlField
                            key={`${storedKey}`}
                            controlKey={key}
                            sectionKey={sectionKey}
                            control={control}
                            value={mods[sectionKey]?.[storedKey] ?? mods[sectionKey]?.[key] ?? control.default}
                            onChange={(v) => updateMod(sectionKey, storedKey, v)}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </aside>

          <div className="jf-customizer__preview">
            <div className="jf-card__title">{t("themeCustomize.livePreview")}</div>
            <iframe ref={iframeRef} src="/?preview=1" title={t("themeCustomize.themePreviewTitle")} />
          </div>
        </div>
      )}
    </div>
  );
}

function ControlField({
  controlKey,
  sectionKey,
  control,
  value,
  onChange,
}: {
  controlKey: string;
  sectionKey: string;
  control: Control;
  value: string | number;
  onChange: (v: string | number) => void;
}) {
  const { t } = useT();
  const id = `${sectionKey}-${controlKey}`;

  if (control.type === "color") {
    return (
      <div className="jf-field">
        <label className="jf-field__label" htmlFor={id}>
          {control.label}
        </label>
        <div className="jf-row" style={{ flexWrap: "nowrap" }}>
          <input
            id={id}
            className="jf-swatch"
            type="color"
            value={String(value)}
            onChange={(e) => onChange(e.target.value)}
          />
          <input
            className="jf-input jf-input--mono"
            type="text"
            value={String(value)}
            aria-label={t("themeCustomize.hexValueAriaLabel", { label: control.label })}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      </div>
    );
  }

  if ((control.type === "font" || control.type === "select") && control.options) {
    return (
      <div className="jf-field">
        <label className="jf-field__label" htmlFor={id}>
          {control.label}
        </label>
        <select
          id={id}
          className="jf-input"
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
        >
          {control.options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (control.type === "range") {
    return (
      <div className="jf-field">
        <label className="jf-field__label" htmlFor={id}>
          {control.label}: {value}
          {control.unit ?? ""}
        </label>
        <input
          id={id}
          type="range"
          min={control.min}
          max={control.max}
          step={control.step ?? 1}
          value={Number(value)}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </div>
    );
  }

  if (control.type === "code") {
    return (
      <div className="jf-field">
        <label className="jf-field__label" htmlFor={id}>
          {control.label}
        </label>
        <textarea
          id={id}
          className="jf-input jf-input--mono"
          rows={6}
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t("ui.themeCustomizePage.yourCustomCSS")}
        />
      </div>
    );
  }

  if (control.type === "image") {
    return (
      <MediaImageField
        id={id}
        label={control.label}
        description={control.description}
        value={String(value)}
        onChange={(url) => onChange(url)}
      />
    );
  }

  return (
    <div className="jf-field">
      <label className="jf-field__label" htmlFor={id}>
        {control.label}
      </label>
      {control.description ? <p className="jf-field__hint">{control.description}</p> : null}
      <input
        id={id}
        className="jf-input"
        type="text"
        value={String(value)}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
