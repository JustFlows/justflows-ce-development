import { Suspense } from "react";
import NoticeFocus from "./components/NoticeFocus";
import { Outlet, Route, Routes } from "react-router-dom";
import { Navigate } from "./admin-router";
import AdminShell from "@components/AdminShell";
import { I18nProvider } from "./i18n/I18nProvider";
import { PluginMenuProvider } from "@components/PluginMenuProvider";
import { SessionProvider, useSession } from "@components/SessionProvider";
import { SiteHead } from "@components/SiteIdentity";
import { DocumentMeta } from "@components/DocumentMeta";
import { canAccessPath } from "./config/admin-nav";
import { adminAuthPage, adminBasePath, currentPathname, isPreAuthPath, publicAdminPath } from "./admin-path";
import { lazyPage } from "./lazy-page";
import { RouteFallback } from "@components/RouteFallback";

/** Every route page loads in its own chunk, on first visit to that route. */
const LoginPage = lazyPage(() => import("./pages/LoginPage"));
const RegisterPage = lazyPage(() => import("./pages/RegisterPage"));
const ForgotPasswordPage = lazyPage(() => import("./pages/ForgotPasswordPage"));
const ResetPasswordPage = lazyPage(() => import("./pages/ResetPasswordPage"));
const InstallPage = lazyPage(() => import("./pages/InstallPage"));
const DashboardPage = lazyPage(() => import("./pages/admin/dashboard/DashboardPage"));
const ContentListPage = lazyPage(() => import("./pages/admin/content/ContentListPage"));
const ContentNewPage = lazyPage(() => import("./pages/admin/content/ContentNewPage"));
const ContentEditPage = lazyPage(() => import("./pages/admin/content/ContentEditPage"));
const ContentTypesPage = lazyPage(() => import("./pages/admin/content/ContentTypesPage"));
const TaxonomiesPage = lazyPage(() => import("./pages/admin/content/TaxonomiesPage"));
const MediaPage = lazyPage(() => import("./pages/admin/media/MediaPage"));
const PluginsPage = lazyPage(() => import("./pages/admin/extensions/PluginsPage"));
const PluginSettingsPage = lazyPage(() => import("./pages/admin/extensions/PluginSettingsPage"));
const ThemesPage = lazyPage(() => import("./pages/admin/design/ThemesPage"));
const DesignPage = lazyPage(() => import("./pages/admin/design/DesignPage"));
const ThemeCustomizePage = lazyPage(() => import("./pages/admin/design/ThemeCustomizePage"));
const WidgetsPage = lazyPage(() => import("./pages/admin/design/WidgetsPage"));
const PageBuilderPage = lazyPage(() => import("./pages/admin/design/PageBuilderPage"));
const ReusableBuilderPage = lazyPage(() => import("./pages/admin/design/ReusableBuilderPage"));
const MenusPage = lazyPage(() => import("./pages/admin/design/MenusPage"));
const UsersPage = lazyPage(() => import("./pages/admin/users/UsersPage"));
const EditUserPage = lazyPage(() => import("./pages/admin/users/EditUserPage"));
const RedirectsPage = lazyPage(() => import("./pages/admin/settings/RedirectsPage"));
const PermalinksPage = lazyPage(() => import("./pages/admin/settings/PermalinksPage"));
const PwaSettingsPage = lazyPage(() => import("./pages/admin/settings/PwaSettingsPage"));
const PlaceholdersPage = lazyPage(() => import("./pages/admin/settings/PlaceholdersPage"));
const SettingsPage = lazyPage(() => import("./pages/admin/settings/SettingsPage"));
const EmailsPage = lazyPage(() => import("./pages/admin/settings/EmailsPage"));
const CommentsPage = lazyPage(() => import("./pages/admin/comments/CommentsPage"));
const TrashPage = lazyPage(() => import("./pages/admin/content/TrashPage"));
const MarketplacePage = lazyPage(() => import("./pages/admin/extensions/MarketplacePage"));
const ToolsPage = lazyPage(() => import("./pages/admin/system/ToolsPage"));
const HealthPage = lazyPage(() => import("./pages/admin/system/HealthPage"));
const UpdatesPage = lazyPage(() => import("./pages/admin/system/UpdatesPage"));
const LanguagesPage = lazyPage(() => import("./pages/admin/settings/LanguagesPage"));
const SecurityCenterPage = lazyPage(() => import("./pages/admin/security/SecurityCenterPage"));
const WebServerPage = lazyPage(() => import("./pages/admin/security/WebServerPage"));
const IntegrityPage = lazyPage(() => import("./pages/admin/security/IntegrityPage"));
const SecurityOverviewPage = lazyPage(() => import("./pages/admin/security/SecurityOverviewPage"));
const SecurityHeadersPage = lazyPage(() => import("./pages/admin/security/SecurityHeadersPage"));
const SecurityAdvancedPage = lazyPage(() => import("./pages/admin/security/SecurityAdvancedPage"));
const AccountSecurityPage = lazyPage(() => import("./pages/admin/security/AccountSecurityPage"));
const AuditLogPage = lazyPage(() => import("./pages/admin/security/AuditLogPage"));
const AuditSettingsPage = lazyPage(() => import("./pages/admin/security/AuditSettingsPage"));
const WebhooksPage = lazyPage(() => import("./pages/admin/settings/WebhooksPage"));
const ApiKeysPage = lazyPage(() => import("./pages/admin/settings/ApiKeysPage"));
const AiSettingsPage = lazyPage(() => import("./pages/admin/settings/AiSettingsPage"));
const CdnSettingsPage = lazyPage(() => import("./pages/admin/settings/CdnSettingsPage"));
const StorageSettingsPage = lazyPage(() => import("./pages/admin/settings/StorageSettingsPage"));
const DomainsPage = lazyPage(() => import("./pages/admin/settings/DomainsPage"));
const PlatformPage = lazyPage(() => import("./pages/admin/platform/PlatformPage"));
const PlatformSitesPage = lazyPage(() => import("./pages/admin/platform/PlatformSitesPage"));
const PlatformDefaultsPage = lazyPage(() => import("./pages/admin/platform/PlatformDefaultsPage"));
const PlatformDomainsPage = lazyPage(() => import("./pages/admin/platform/PlatformDomainsPage"));
const PlatformSitePage = lazyPage(() => import("./pages/admin/platform/PlatformSitePage"));
const PlatformSiteUsersPage = lazyPage(() => import("./pages/admin/platform/PlatformSiteUsersPage"));
const PlatformWorkspacePage = lazyPage(() => import("./pages/admin/platform/PlatformWorkspacePage"));
const SignupPage = lazyPage(() => import("./pages/SignupPage"));
const OAuthConsentPage = lazyPage(() => import("./pages/OAuthConsentPage"));
const PluginHostPage = lazyPage(() => import("./pages/admin/extensions/PluginHostPage"));
const AdminPathPage = lazyPage(() => import("./pages/admin/security/AdminPathPage"));
const PasskeyPolicyPage = lazyPage(() => import("./pages/admin/security/PasskeyPolicyPage"));

/**
 * Guards the couple of full-bleed editors that render outside AdminShell (and
 * so miss its own role gate). Same rule table, same "bounce, don't 403".
 */
function RequireNavAccess({ path, children }: { path: string; children: React.ReactNode }) {
  const { session } = useSession();
  const role = session?.role ?? null;
  const audience = session
    ? { installationRoot: session.installationRoot === true, platformOperator: session.platformOperator === true, disabledPaths: session.disabledPaths }
    : undefined;
  if (role !== null && !canAccessPath(role, path, audience)) return <Navigate to="/admin" replace />;
  return <>{children}</>;
}

export default function App() {
  const admin = adminBasePath();
  // /login, /install, etc. render before a session exists and hardcode their
  // own product-mark branding (see LoginPage) — they don't use the site's own
  // logo/favicon, and /api/site/identity 404s there for an anonymous caller
  // when Public API is off, so skip the fetch entirely rather than accept it.
  const isPreAuth = isPreAuthPath(currentPathname());
  // Staff auth pages under the admin path; the bare paths are the members' fallbacks.
  const adminAuth = adminAuthPage()?.base;
  return (
    <I18nProvider>
      <SessionProvider>
        <NoticeFocus />
        <PluginMenuProvider>
          {isPreAuth ? <DocumentMeta /> : <SiteHead />}
          <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/install" element={<InstallPage />} />
            <Route path="/login" element={<LoginPage />} />
            {adminAuth ? <Route path={`${adminAuth}/login`} element={<LoginPage adminPath={adminAuth} />} /> : null}
            {adminAuth ? <Route path={`${adminAuth}/forgot-password`} element={<ForgotPasswordPage adminPath={adminAuth} />} /> : null}
            {adminAuth ? <Route path={`${adminAuth}/reset-password`} element={<ResetPasswordPage adminPath={adminAuth} />} /> : null}
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            <Route path="/reset-password" element={<ResetPasswordPage />} />
            <Route path="/oauth/consent" element={<OAuthConsentPage />} />
            <Route path="/signup" element={<SignupPage />} />
            <Route
              path={`${admin}/themes/customize`}
              element={
                <RequireNavAccess path="/admin/themes">
                  <ThemeCustomizePage />
                </RequireNavAccess>
              }
            />
            <Route path={`${admin}/content/:id/builder`} element={<PageBuilderPage />} />
            <Route path={`${admin}/reusable/:id`} element={<ReusableBuilderPage />} />
            <Route path={admin} element={<AdminShell />}>
              <Route index element={<DashboardPage />} />
              <Route path="content" element={<ContentListPage />} />
              <Route path="content/new" element={<ContentNewPage />} />
              <Route path="content/:id" element={<ContentEditPage />} />
              <Route path="content-types" element={<ContentTypesPage />} />
              <Route path="taxonomies" element={<TaxonomiesPage />} />
              <Route path="media" element={<MediaPage />} />
              <Route path="plugins" element={<PluginsPage />} />
              <Route path="plugins/:id/settings" element={<PluginSettingsPage />} />
              <Route path="themes" element={<ThemesPage />} />
              <Route path="design" element={<DesignPage />} />
              <Route path="widgets" element={<WidgetsPage />} />
              <Route path="menus" element={<MenusPage />} />
              <Route path="users" element={<UsersPage />} />
              <Route path="users/:id" element={<EditUserPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="settings/permalinks" element={<PermalinksPage />} />
              <Route path="settings/pwa" element={<PwaSettingsPage />} />
              <Route path="settings/placeholders" element={<PlaceholdersPage />} />
              <Route path="redirects" element={<RedirectsPage />} />
              <Route path="emails" element={<EmailsPage />} />
              <Route path="comments" element={<CommentsPage />} />
              <Route path="trash" element={<TrashPage />} />
              <Route path="marketplace" element={<MarketplacePage />} />
              <Route path="tools" element={<ToolsPage />} />
              <Route path="health" element={<HealthPage />} />
              <Route path="updates" element={<UpdatesPage />} />
              <Route path="webhooks" element={<WebhooksPage />} />
              <Route path="settings/api" element={<ApiKeysPage />} />
              <Route path="settings/ai" element={<AiSettingsPage />} />
              <Route path="settings/cdn" element={<CdnSettingsPage />} />
              <Route path="settings/storage" element={<StorageSettingsPage />} />
              <Route path="settings/domains" element={<DomainsPage />} />
              <Route path="platform/sites/:id/users" element={<PlatformSiteUsersPage />} />
              <Route path="platform/sites/:id" element={<PlatformSitePage />} />
              <Route path="platform/sites" element={<PlatformSitesPage />} />
              <Route path="platform/workspaces/:id" element={<PlatformWorkspacePage />} />
              <Route path="platform/workspaces" element={<PlatformPage />} />
              <Route path="platform/defaults" element={<PlatformDefaultsPage />} />
              <Route path="platform/domains" element={<PlatformDomainsPage />} />
              <Route path="platform" element={<Navigate to="/admin/platform/workspaces" replace />} />
              <Route path="languages" element={<LanguagesPage />} />
              <Route path="security" element={<SecurityCenterPage />} />
              <Route path="security/web-server" element={<WebServerPage />} />
              <Route path="security/integrity" element={<IntegrityPage />} />
              <Route path="security/header-grade" element={<SecurityOverviewPage />} />
              <Route path="security/headers" element={<SecurityHeadersPage />} />
              <Route path="security/advanced" element={<SecurityAdvancedPage />} />
              <Route path="security/admin-path" element={<AdminPathPage />} />
              <Route path="security/passkeys" element={<PasskeyPolicyPage />} />
              <Route path="security/account" element={<AccountSecurityPage />} />
              <Route path="security/audit" element={<AuditLogPage />} />
              <Route path="security/audit/settings" element={<AuditSettingsPage />} />
              <Route path="*" element={<PluginHostPage />} />
            </Route>
            <Route path="*" element={<Navigate to={publicAdminPath("/admin")} replace />} />
          </Routes>
          </Suspense>
        </PluginMenuProvider>
      </SessionProvider>
    </I18nProvider>
  );
}
