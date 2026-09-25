import { FormEvent, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useNavigate } from "../../../admin-router";
import { useCapability } from "@components/SessionProvider";
import { useT } from "../../../i18n/I18nProvider";

interface User {
  id: string;
  email: string;
  username: string;
  displayName: string;
  role: string;
  createdAt: string;
  roleId: string;
  grants: string[];
  denies: string[];
  effectiveCapabilities: string[];
  scopes: Record<string, { contentTypes?: string[]; locales?: string[]; ownership?: "any" | "self" }>;
}

const ROLES = ["administrator", "editor", "author", "contributor", "subscriber"];

function fromApi(user: Record<string, any>): User {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    displayName: user.display_name,
    role: user.role,
    createdAt: user.created_at,
    roleId: user.roleId ?? user.role,
    grants: user.accessPolicy?.grants ?? [],
    denies: user.accessPolicy?.denies ?? [],
    effectiveCapabilities: user.effectiveCapabilities ?? [],
    scopes: user.accessPolicy?.scopes ?? {},
  };
}

export default function EditUserPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { t } = useT();
  // Updating, resetting a password and removing are all administrator-only on
  // the server; an editor can reach this page (they can read the list) but
  // gets a read-only profile rather than controls that would 403.
  const canManage = useCapability("users:manage");

  const [user, setUser] = useState<User | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState("subscriber");
  const [roles, setRoles] = useState<Array<{ id: string; name: string; builtIn: boolean; pluginId?: string | null }>>([]);
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [grants, setGrants] = useState<string[]>([]);
  const [denies, setDenies] = useState<string[]>([]);
  const [contentTypes, setContentTypes] = useState("");
  const [locales, setLocales] = useState("");
  const [ownOnly, setOwnOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [showPasswordReset, setShowPasswordReset] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [resettingPassword, setResettingPassword] = useState(false);

  useEffect(() => {
    fetch(`/api/users/${encodeURIComponent(id ?? "")}`)
      .then(async (res) => {
        const data = await res.json() as { user?: Record<string, string>; error?: string };
        if (!res.ok || !data.user) throw new Error(data.error ?? t("users.edit.failedToLoadUser"));
        const loaded = fromApi(data.user);
        setUser(loaded);
        setDisplayName(loaded.displayName);
        setRole(loaded.roleId);
        setGrants(loaded.grants);
        setDenies(loaded.denies);
        const contentScope = loaded.scopes["content:update"] ?? {};
        setContentTypes((contentScope.contentTypes ?? []).join(", "));
        setLocales((contentScope.locales ?? []).join(", "));
        setOwnOnly(contentScope.ownership === "self");
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    fetch("/api/roles").then(async (res) => {
      const data = await res.json() as {
        roles?: Array<{ id: string; name: string; builtIn: boolean; pluginId?: string | null }>;
        capabilities?: Array<string | { id: string }>;
      };
      if (res.ok) {
        setRoles(data.roles ?? []);
        // /api/roles returns capability *definition objects*; this view only
        // needs the ids. RolesPanel does the same normalisation.
        setCapabilities((data.capabilities ?? []).map((c) => (typeof c === "string" ? c : c.id)));
      }
    }).catch(() => undefined);
  }, []);

  function sameMembers(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const sortedB = [...b].sort();
    return [...a].sort().every((value, index) => value === sortedB[index]);
  }

  function parseList(value: string): string[] {
    return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!user) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      // Only send access-policy fields that actually changed. The server
      // treats *any* of roleId/grants/denies/scopes being present as "the
      // access policy changed" — sending them unconditionally on every save
      // (even a plain display-name edit) blocks admins from editing their
      // own profile and force-revokes every session on every save.
      const roleChanged = role !== user.roleId;
      const grantsChanged = !sameMembers(grants, user.grants);
      const deniesChanged = !sameMembers(denies, user.denies);
      const baselineScope = user.scopes["content:update"] ?? {};
      const scopeChanged =
        !sameMembers(parseList(contentTypes), baselineScope.contentTypes ?? []) ||
        !sameMembers(parseList(locales), baselineScope.locales ?? []) ||
        ownOnly !== (baselineScope.ownership === "self");

      const body: Record<string, unknown> = { displayName };
      if (roleChanged) {
        const selected = roles.find((entry) => entry.id === role);
        const assignsUserRole = !selected || selected.builtIn || Boolean(selected.pluginId);
        if (assignsUserRole) body.role = role;
        body.roleId = role;
      }
      if (grantsChanged) body.grants = grants;
      if (deniesChanged) body.denies = denies;
      if (scopeChanged) {
        body.scopes = Object.fromEntries(
          ["content:read", "content:create", "content:update", "content:delete", "content:publish"].map((capability) => [capability, {
            contentTypes: parseList(contentTypes),
            locales: parseList(locales),
            ownership: ownOnly ? "self" : "any",
          }]),
        );
      }

      const res = await fetch(`/api/users/${encodeURIComponent(user.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? t("users.edit.failedToUpdateUser"));
      setUser((current) => (current
        ? {
            ...current,
            displayName,
            roleId: role,
            grants,
            denies,
            scopes: scopeChanged
              ? { ...current.scopes, ...(body.scopes as User["scopes"]) }
              : current.scopes,
          }
        : current));
      setNotice(t("users.edit.userUpdated"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function resetPassword(event: FormEvent) {
    event.preventDefault();
    if (!user) return;
    setResettingPassword(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(user.id)}/password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newPassword }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? t("users.edit.failedToResetPassword"));
      setNewPassword("");
      setShowPasswordReset(false);
      setNotice(t("users.edit.passwordResetNotice"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setResettingPassword(false);
    }
  }

  async function removeUser() {
    if (!user) return;
    if (!window.confirm(t("users.edit.removeUserConfirm", { name: user.displayName || user.email }))) return;
    setRemoving(true);
    setError("");
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(user.id)}`, { method: "DELETE" });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? t("users.edit.failedToRemoveUser"));
      navigate("/admin/users");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRemoving(false);
    }
  }

  if (loading) {
    return (
      <>
        <header className="jf-topbar">
          <button className="jf-btn jf-btn--quiet" onClick={() => navigate("/admin/users")}>← {t("common.back")}</button>
        </header>
        <div className="jf-page">{t("users.edit.loadingUser")}</div>
      </>
    );
  }

  if (!user) {
    return (
      <>
        <header className="jf-topbar">
          <button className="jf-btn jf-btn--quiet" onClick={() => navigate("/admin/users")}>← {t("common.back")}</button>
        </header>
        <div className="jf-page">
          <div className="jf-alert jf-alert--error" role="alert">{error || t("users.edit.userNotFound")}</div>
        </div>
      </>
    );
  }

  return (
    <>
      <header className="jf-topbar">
        <button className="jf-btn jf-btn--quiet" onClick={() => navigate("/admin/users")}>← {t("common.back")}</button>
        <div className="jf-topbar__title">
          <span className="jf-topbar__eyebrow">{t("users.edit.eyebrow")}</span>
          <h1>{user.displayName || user.email}</h1>
        </div>
        {canManage && (
          <div className="jf-topbar__actions">
            <button className="jf-btn jf-btn--primary" form="jf-edit-user-form" type="submit" disabled={saving}>
              {saving ? t("common.saving") : t("users.edit.saveChanges")}
            </button>
          </div>
        )}
      </header>

      <div className="jf-page">
        {error && <div className="jf-alert jf-alert--error" role="alert">{error}</div>}
        {notice && <div className="jf-alert jf-alert--success" role="status">{notice}</div>}

        <form id="jf-edit-user-form" className="jf-card" onSubmit={save}>
          <div className="jf-card__head">
            <h2 className="jf-card__title">{t("users.edit.profile")}</h2>
          </div>
          <div className="jf-card__body jf-stack">
            <div className="jf-grid jf-grid--2">
              <div className="jf-field">
                <label className="jf-field__label" htmlFor="jf-edit-email">{t("users.edit.emailAddress")}</label>
                <input id="jf-edit-email" className="jf-input" type="email" value={user.email} disabled />
              </div>
              <div className="jf-field">
                <label className="jf-field__label" htmlFor="jf-edit-username">{t("users.edit.username")}</label>
                <input id="jf-edit-username" className="jf-input" value={`@${user.username}`} disabled />
              </div>
            </div>
            <div className="jf-grid jf-grid--2">
              <div className="jf-field">
                <label className="jf-field__label" htmlFor="jf-edit-displayname">{t("users.edit.displayName")}</label>
                <input
                  id="jf-edit-displayname"
                  className="jf-input"
                  required
                  disabled={!canManage}
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              </div>
              <div className="jf-field">
                <label className="jf-field__label" htmlFor="jf-edit-role">{t("users.edit.role")}</label>
                <select
                  id="jf-edit-role"
                  className="jf-input"
                  value={role}
                  disabled={!canManage}
                  onChange={(e) => setRole(e.target.value)}
                >
                  {(roles.length ? roles : ROLES.map((id) => ({ id, name: id, builtIn: true }))).map((r) => (
                    <option key={r.id} value={r.id}>{r.name}{r.builtIn ? ` (${t("users.edit.builtIn")})` : ""}</option>
                  ))}
                </select>
              </div>
            </div>
            <span className="jf-field__hint">{t("users.edit.joined", { date: user.createdAt.slice(0, 10) })}</span>
          </div>
        </form>

        {canManage && capabilities.length > 0 && (
          <div className="jf-card">
            <div className="jf-card__head"><h2 className="jf-card__title">{t("users.edit.individualAccess")}</h2></div>
            <div className="jf-card__body jf-stack">
              <p className="jf-field__hint">{t("users.edit.individualAccessHint")}</p>
              <div className="jf-grid jf-grid--2">
                {capabilities.map((capability) => (
                  <div className="jf-field" key={capability}>
                    <span className="jf-field__label">{capability}</span>
                    <select
                      className="jf-input"
                      aria-label={capability}
                      value={denies.includes(capability) ? "deny" : grants.includes(capability) ? "grant" : "inherit"}
                      onChange={(event) => {
                        const value = event.target.value;
                        setGrants((current) => value === "grant" ? [...new Set([...current, capability])] : current.filter((item) => item !== capability));
                        setDenies((current) => value === "deny" ? [...new Set([...current, capability])] : current.filter((item) => item !== capability));
                      }}
                    >
                      <option value="inherit">{t("users.edit.inherit")}</option>
                      <option value="grant">{t("users.edit.grant")}</option>
                      <option value="deny">{t("users.edit.deny")}</option>
                    </select>
                  </div>
                ))}
              </div>
              <p className="jf-field__hint">{t("users.edit.effectiveAccessPreview", { capabilities: user.effectiveCapabilities.length ? user.effectiveCapabilities.join(", ") : t("users.edit.noCapabilities") })}</p>
              <div className="jf-grid jf-grid--2">
                <label className="jf-field"><span className="jf-field__label">{t("users.edit.contentTypes")}</span><input className="jf-input" placeholder="post, page" value={contentTypes} onChange={(e) => setContentTypes(e.target.value)} /><span className="jf-field__hint">{t("users.edit.contentTypesHint")}</span></label>
                <label className="jf-field"><span className="jf-field__label">{t("users.edit.locales")}</span><input className="jf-input" placeholder="nl-NL, nl-BE" value={locales} onChange={(e) => setLocales(e.target.value)} /><span className="jf-field__hint">{t("users.edit.localesHint")}</span></label>
              </div>
              <label className="jf-field"><span><input type="checkbox" checked={ownOnly} onChange={(e) => setOwnOnly(e.target.checked)} /> {t("users.edit.ownContentOnly")}</span></label>
              <p className="jf-field__hint">{t("users.edit.contentScopePreview", {
                contentTypes: contentTypes || t("users.edit.allContentTypes"),
                locales: locales || t("users.edit.allLocales"),
                ownership: ownOnly ? t("users.edit.ownedContentOnly") : t("users.edit.anyOwner"),
              })}</p>
            </div>
          </div>
        )}

        {canManage && (
        <div className="jf-card">
          <div className="jf-card__head">
            <h2 className="jf-card__title">{t("users.edit.password")}</h2>
          </div>
          <div className="jf-card__body jf-stack">
            {!showPasswordReset ? (
              <div className="jf-row">
                <button type="button" className="jf-btn jf-btn--ghost" onClick={() => setShowPasswordReset(true)}>
                  {t("users.edit.resetPassword")}
                </button>
              </div>
            ) : (
              <form className="jf-stack" onSubmit={resetPassword}>
                <div className="jf-field">
                  <label className="jf-field__label" htmlFor="jf-edit-newpassword">{t("users.edit.newPassword")}</label>
                  <input
                    id="jf-edit-newpassword"
                    className="jf-input"
                    type="password"
                    required
                    minLength={8}
                    autoComplete="new-password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                  />
                  <span className="jf-field__hint">{t("users.edit.newPasswordHint")}</span>
                </div>
                <div className="jf-row">
                  <button className="jf-btn jf-btn--primary" type="submit" disabled={resettingPassword}>
                    {resettingPassword ? t("users.edit.resettingPassword") : t("users.edit.setNewPassword")}
                  </button>
                  <button
                    className="jf-btn jf-btn--ghost"
                    type="button"
                    disabled={resettingPassword}
                    onClick={() => { setShowPasswordReset(false); setNewPassword(""); }}
                  >
                    {t("common.cancel")}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
        )}

        {canManage && (
        <div className="jf-card">
          <div className="jf-card__head">
            <h2 className="jf-card__title">{t("users.edit.dangerZone")}</h2>
          </div>
          <div className="jf-card__body jf-stack">
            <p className="jf-field__hint">{t("users.edit.removeUserHint")}</p>
            <div className="jf-row">
              <button type="button" className="jf-btn jf-btn--danger" disabled={removing} onClick={removeUser}>
                {removing ? t("users.edit.removingUser") : t("users.edit.removeUser")}
              </button>
            </div>
          </div>
        </div>
        )}
      </div>
    </>
  );
}
