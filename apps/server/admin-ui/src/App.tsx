import { Navigate, Outlet, Route, Routes } from "react-router-dom";
import AdminShell from "@components/AdminShell";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import ForgotPasswordPage from "./pages/ForgotPasswordPage";
import ResetPasswordPage from "./pages/ResetPasswordPage";
import InstallPage from "./pages/InstallPage";
import DashboardPage from "./pages/admin/DashboardPage";
import ContentListPage from "./pages/admin/ContentListPage";
import ContentNewPage from "./pages/admin/ContentNewPage";
import ContentEditPage from "./pages/admin/ContentEditPage";
import ContentTypesPage from "./pages/admin/ContentTypesPage";
import MediaPage from "./pages/admin/MediaPage";
import PluginsPage from "./pages/admin/PluginsPage";
import PluginSettingsPage from "./pages/admin/PluginSettingsPage";
import AnalyticsPage from "./pages/admin/AnalyticsPage";
import ConsentPage from "./pages/admin/ConsentPage";
import ThemesPage from "./pages/admin/ThemesPage";
import DesignPage from "./pages/admin/DesignPage";
import ThemeCustomizePage from "./pages/admin/ThemeCustomizePage";
import PageBuilderPage from "./pages/admin/PageBuilderPage";
import MenusPage from "./pages/admin/MenusPage";
import UsersPage from "./pages/admin/UsersPage";
import EditUserPage from "./pages/admin/EditUserPage";
import PermalinksPage from "./pages/admin/PermalinksPage";
import SettingsPage from "./pages/admin/SettingsPage";
import EmailsPage from "./pages/admin/EmailsPage";
import CommentsPage from "./pages/admin/CommentsPage";
import TrashPage from "./pages/admin/TrashPage";
import MarketplacePage from "./pages/admin/MarketplacePage";
import ToolsPage from "./pages/admin/ToolsPage";
import HealthPage from "./pages/admin/HealthPage";
import UpdatesPage from "./pages/admin/UpdatesPage";
import LanguagesPage from "./pages/admin/LanguagesPage";
import SecurityOverviewPage from "./pages/admin/security/SecurityOverviewPage";
import SecurityHeadersPage from "./pages/admin/security/SecurityHeadersPage";
import SecurityAdvancedPage from "./pages/admin/security/SecurityAdvancedPage";
import AccountSecurityPage from "./pages/admin/security/AccountSecurityPage";
import AuditLogPage from "./pages/admin/security/AuditLogPage";
import WebhooksPage from "./pages/admin/WebhooksPage";
import { I18nProvider } from "./i18n/I18nProvider";
import { PluginMenuProvider } from "@components/PluginMenuProvider";
import { SessionProvider, useSessionRole } from "@components/SessionProvider";
import PluginRoute from "@components/PluginRoute";
import PluginHostPage from "./pages/admin/PluginHostPage";
import { SiteFavicon } from "@components/SiteIdentity";
import { canAccessPath } from "./config/admin-nav";
import AdminPathPage from "./pages/admin/security/AdminPathPage";
import { adminBasePath, publicAdminPath } from "./admin-path";

/**
 * Guards the couple of full-bleed editors that render outside AdminShell (and
 * so miss its own role gate). Same rule table, same "bounce, don't 403".
 */
function RequireNavAccess({ path, children }: { path: string; children: React.ReactNode }) {
  const role = useSessionRole();
  if (role !== null && !canAccessPath(role, path)) return <Navigate to="/admin" replace />;
  return <>{children}</>;
}

export default function App() {
  const admin = adminBasePath();
  return (
    <I18nProvider>
      <SessionProvider>
        <PluginMenuProvider>
          <SiteFavicon />
          <Routes>
            <Route path="/install" element={<InstallPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            <Route path="/reset-password" element={<ResetPasswordPage />} />
            <Route
              path={`${admin}/themes/customize`}
              element={
                <RequireNavAccess path="/admin/themes">
                  <ThemeCustomizePage />
                </RequireNavAccess>
              }
            />
            <Route path={`${admin}/content/:id/builder`} element={<PageBuilderPage />} />
            <Route path={admin} element={<AdminShell />}>
              <Route index element={<DashboardPage />} />
              <Route path="content" element={<ContentListPage />} />
              <Route path="content/new" element={<ContentNewPage />} />
              <Route path="content/:id" element={<ContentEditPage />} />
              <Route path="content-types" element={<ContentTypesPage />} />
              <Route path="media" element={<MediaPage />} />
              <Route path="plugins" element={<PluginsPage />} />
              <Route path="plugins/:id/settings" element={<PluginSettingsPage />} />
              {/* Owned by the Analytics and Forms plugins — unreachable once deleted. */}
              <Route
                path="analytics"
                element={
                  <PluginRoute>
                    <AnalyticsPage />
                  </PluginRoute>
                }
              />
              <Route
                path="consent"
                element={
                  <PluginRoute>
                    <ConsentPage />
                  </PluginRoute>
                }
              />
              <Route path="themes" element={<ThemesPage />} />
              <Route path="design" element={<DesignPage />} />
              <Route path="menus" element={<MenusPage />} />
              <Route path="users" element={<UsersPage />} />
              <Route path="users/:id" element={<EditUserPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="settings/permalinks" element={<PermalinksPage />} />
              <Route path="emails" element={<EmailsPage />} />
              <Route path="comments" element={<CommentsPage />} />
              <Route path="trash" element={<TrashPage />} />
              <Route path="marketplace" element={<MarketplacePage />} />
              <Route path="tools" element={<ToolsPage />} />
              <Route path="health" element={<HealthPage />} />
              <Route path="updates" element={<UpdatesPage />} />
              <Route path="webhooks" element={<WebhooksPage />} />
              <Route path="languages" element={<LanguagesPage />} />
              <Route path="security" element={<SecurityOverviewPage />} />
              <Route path="security/headers" element={<SecurityHeadersPage />} />
              <Route path="security/advanced" element={<SecurityAdvancedPage />} />
              <Route path="security/admin-path" element={<AdminPathPage />} />
              <Route path="security/account" element={<AccountSecurityPage />} />
              <Route path="security/audit" element={<AuditLogPage />} />
              {/* The SEO Toolkit plugin's nav entry uses a dotless `/admin/seo`
                  path — its id (`justflows.seo`) has a dot, which the manifest
                  validator rejects in an adminMenu path. Send it to the plugin's
                  settings screen. */}
              <Route
                path="seo"
                element={
                  <Navigate
                    to={publicAdminPath("/admin/plugins/justflows.seo/settings")}
                    replace
                  />
                }
              />
              <Route path="*" element={<PluginHostPage />} />
            </Route>
            <Route path="*" element={<Navigate to={publicAdminPath("/admin")} replace />} />
          </Routes>
        </PluginMenuProvider>
      </SessionProvider>
    </I18nProvider>
  );
}
