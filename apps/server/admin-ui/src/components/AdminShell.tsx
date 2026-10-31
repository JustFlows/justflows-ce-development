import { useEffect, useMemo, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Link, Navigate, NavLink } from "../admin-router";
import { adminBasePath } from "../admin-path";
import { ADMIN_UI_LOCALES, useT, type AdminUiLocale } from "../i18n/I18nProvider";
import { ADMIN_DASHBOARD, canAccessPath, filterDomainsByRole, findDomainForPath, isDomainActive, navLabel, pluginPageRoles } from "../config/admin-nav";
import DomainSubnav from "./DomainSubnav";
import { usePluginMenu } from "./PluginMenuProvider";
import { useSession, useSessionRole } from "./SessionProvider";
import { JustflowsLogo } from "./JustflowsLogo";
import { initialJson } from "../ssr-data";
import { AssistantProvider, useAssistant } from "./ai/AssistantProvider";

/** Emoji, or a same-origin image path such as a plugin logo. */
function NavGlyph({ icon }: { icon: string }) {
  const image = icon.startsWith("/");
  return (
    <span className={image ? "jf-nav__icon jf-nav__icon--image" : "jf-nav__icon"} aria-hidden="true">
      {image ? <img src={icon} alt="" /> : icon}
    </span>
  );
}

/** Sidebar entry that opens the assistant panel, for users with ai:use. */
function AssistantButton() {
  const { t } = useT();
  const { available, open } = useAssistant();
  if (!available) return null;
  return (
    <button type="button" className="jf-nav__link jf-nav__button" onClick={() => open()}>
      <span className="jf-nav__icon" aria-hidden="true">
        ✦
      </span>
      {t("ai.assistant.title")}
    </button>
  );
}

export default function AdminShell() {
  const { pathname } = useLocation();
  const { t, locale, setLocale } = useT();
  const [navOpen, setNavOpen] = useState(false);
  const [version, setVersion] = useState(
    () => initialJson<{ version?: string }>("/api/updates")?.version ?? "",
  );
  const role = useSessionRole();
  const { session } = useSession();
  // Domains carry the pages of whichever plugins are installed right now, cut
  // down to the ones this role won't hit a 403 opening.
  const { domains: allDomains, items: pluginItems } = usePluginMenu();
  const audience = session
    ? {
        installationRoot: session.installationRoot === true,
        platformOperator: session.platformOperator === true,
        disabledPaths: session.disabledPaths,
        pluginPageRoles: pluginPageRoles(pluginItems),
      }
    : undefined;
  const domains = useMemo(() => filterDomainsByRole(allDomains, role, audience), [allDomains, role, audience]);
  const activeDomain = findDomainForPath(pathname, domains);
  // A role's own capabilities can only be known once /api/auth/me resolves —
  // usually already true from SSR. Never bounce on that first, unresolved
  // render; only once we actually know the role lacks access.
  const canOpenCurrentPage = role === null || canAccessPath(role, pathname, audience);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => setNavOpen(false), [pathname]);

  useEffect(() => {
    fetch("/api/updates")
      .then((r) => r.json())
      .then((data: { version?: string }) => {
        if (data.version) setVersion(data.version);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNavOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    // A full load of the hidden staff sign-in page; the public /login is for
    // members only once the admin path has been moved.
    window.location.assign(`${adminBasePath()}/login`);
  }

  // Reached by a direct URL, a bookmark, or a link this role's own nav no
  // longer shows — bounce to the dashboard rather than mount a page that
  // would just fail its first fetch. Server-side authorization is what
  // actually protects the data either way.
  if (!canOpenCurrentPage) {
    const currentDomain = findDomainForPath(pathname, allDomains);
    const securityLanding = currentDomain?.slug === "security"
      ? domains.find((domain) => domain.slug === "security")?.items[0]?.to
      : undefined;
    return <Navigate to={securityLanding ?? "/admin"} replace />;
  }

  return (
    <AssistantProvider>
    <div className="jf-app">
      <button
        type="button"
        className="jf-scrim"
        data-open={navOpen}
        aria-label={t("shell.closeNavigation")}
        onClick={() => setNavOpen(false)}
      />

      <aside className="jf-sidebar" data-open={navOpen}>
        <div className="jf-brand">
          <JustflowsLogo />
          <span className="jf-brand__name">Justflows</span>
        </div>

        <nav className="jf-nav" aria-label={t("shell.adminNavLabel")}>
          <NavLink to={ADMIN_DASHBOARD.to} end={ADMIN_DASHBOARD.end} className="jf-nav__link">
            <span className="jf-nav__icon" aria-hidden="true">
              {ADMIN_DASHBOARD.icon}
            </span>
            {t(ADMIN_DASHBOARD.key)}
          </NavLink>

          {domains.map((domain) => (
            <Link
              key={domain.key}
              to={domain.items[0].to}
              className="jf-nav__link"
              aria-current={isDomainActive(domain, pathname) ? "page" : undefined}
            >
              <NavGlyph icon={domain.icon} />
              {navLabel(t, domain, locale)}
            </Link>
          ))}
          <AssistantButton />
        </nav>

        <div className="jf-sidebar__footer">
          <label className="jf-sidebar__label" htmlFor="jf-ui-locale">
            {t("languages.uiLanguage")}
          </label>
          <select
            id="jf-ui-locale"
            className="jf-sidebar__select"
            value={locale}
            onChange={(e) => setLocale(e.target.value as AdminUiLocale)}
          >
            {ADMIN_UI_LOCALES.map((code) => (
              <option key={code} value={code}>
                {code.toUpperCase()}
              </option>
            ))}
          </select>
          <button type="button" className="jf-sidebar__signout" onClick={logout}>
            {t("common.signOut")}
          </button>
          <div className="jf-sidebar__version">
            {version ? `Justflows v${version}` : "Justflows"}
          </div>
        </div>
      </aside>

      <main className="jf-main">
        {/* Mobile-only bar: the sidebar is a drawer below 900px, so every
            page needs a way to open it. */}
        <div className="jf-mobilebar">
          <button
            type="button"
            className="jf-navtoggle"
            onClick={() => setNavOpen(true)}
            aria-label={t("shell.openNavigation")}
            aria-expanded={navOpen}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M3 6h18M3 12h18M3 18h18" />
            </svg>
          </button>
          <JustflowsLogo />
          <span className="jf-brand__name" style={{ color: "var(--jf-text)" }}>
            Justflows
          </span>
        </div>

        {/* One page is already the sidebar item — don't repeat it as a top bar. */}
        {activeDomain && activeDomain.items.length > 1 && <DomainSubnav domain={activeDomain} />}
        <Outlet />
      </main>
    </div>
    </AssistantProvider>
  );
}
