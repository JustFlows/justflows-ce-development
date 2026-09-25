import { useCallback, useEffect, useMemo, useState } from "react";
import { useT } from "../../../i18n/I18nProvider";

type Role = { id: string; name: string; description?: string | null; builtIn: boolean; pluginId?: string | null; capabilities: string[] };
type Capability = { id: string; label?: string; group?: string; description?: string; pluginId?: string | null };
const NEW_ROLE: Role = { id: "new", name: "", description: "", builtIn: false, capabilities: [] };
const title = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

export default function RolesPanel() {
  const { t } = useT();
  const [roles, setRoles] = useState<Role[]>([]);
  const [all, setAll] = useState<Capability[]>([]);
  const [editing, setEditing] = useState<Role | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const groups = useMemo(() => {
    const grouped = new Map<string, Capability[]>();
    for (const capability of all) {
      const domain = capability.group || capability.id.split(":")[0] || "other";
      grouped.set(domain, [...(grouped.get(domain) ?? []), capability]);
    }
    return [...grouped.entries()];
  }, [all]);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/roles");
      const data = await res.json() as { roles?: Role[]; capabilities?: Array<Capability | string>; error?: string };
      if (!res.ok) throw new Error(data.error ?? t("users.roles.failedToLoadRoles"));
      setRoles(data.roles ?? []);
      setAll((data.capabilities ?? []).map((capability) => typeof capability === "string" ? { id: capability } : capability));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("users.roles.failedToLoadRoles"));
    } finally { setLoading(false); }
  }, [t]);
  useEffect(() => { void load(); }, [load]);

  async function save() {
    if (!editing || !editing.name.trim()) return;
    setSaving(true); setError("");
    const creating = editing.id === "new";
    try {
      const res = await fetch(creating ? "/api/roles" : `/api/roles/${encodeURIComponent(editing.id)}`, {
        method: creating ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: editing.name, description: editing.description ?? null, capabilities: editing.capabilities }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) throw new Error(data.error ?? t("users.roles.failedToSaveRole"));
      setEditing(null); await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("users.roles.failedToSaveRole"));
    } finally { setSaving(false); }
  }

  async function remove(role: Role) {
    if (!window.confirm(t("users.roles.deleteRoleConfirm", { name: role.name }))) return;
    const res = await fetch(`/api/roles/${encodeURIComponent(role.id)}`, { method: "DELETE" });
    const data = await res.json() as { error?: string };
    if (!res.ok) { setError(data.error ?? t("users.roles.failedToDeleteRole")); return; }
    await load();
  }

  function toggleCapability(capability: string, checked: boolean) {
    if (!editing) return;
    setEditing({ ...editing, capabilities: checked ? [...editing.capabilities, capability] : editing.capabilities.filter((item) => item !== capability) });
  }

  return (
    <section className="jf-card jf-roles" aria-labelledby="jf-roles-title">
      <div className="jf-card__head">
        <div><h2 className="jf-card__title" id="jf-roles-title">{t("users.roles.title")}</h2><p className="jf-roles__subtitle">{t("users.roles.subtitle")}</p></div>
        <button className="jf-btn jf-btn--primary jf-btn--sm" type="button" onClick={() => setEditing({ ...NEW_ROLE })}>+ {t("users.roles.createRole")}</button>
      </div>
      {error && <div className="jf-alert jf-alert--error jf-roles__alert" role="alert">{error}</div>}
      <div className="jf-card__body--flush">
        {loading ? <p className="jf-roles__state">{t("users.roles.loading")}</p> : (
          <div className="jf-roles__list">{roles.map((role) => {
            const locked = role.builtIn || Boolean(role.pluginId);
            return (
            <div className="jf-roles__item" key={role.id}>
              <div className="jf-roles__identity"><strong>{title(role.name)}</strong>{role.builtIn && <span className="jf-badge">{t("users.roles.builtIn")}</span>}<span className="jf-roles__count">{t("users.roles.capabilitiesCount", { count: role.capabilities.length })}</span></div>
              <p>{role.description || (role.builtIn ? t("users.roles.managedByJustflows") : t("users.roles.customAccessRole"))}</p>
              {!locked && <div className="jf-roles__actions"><button className="jf-btn jf-btn--quiet jf-btn--sm" type="button" onClick={() => setEditing({ ...role })}>{t("users.roles.editRole")}</button><button className="jf-btn jf-btn--quiet jf-btn--sm jf-roles__delete" type="button" onClick={() => void remove(role)}>{t("common.delete")}</button></div>}
            </div>
            );
          })}</div>
        )}
      </div>
      {editing && (
        <div className="jf-roles__editor">
          <div className="jf-roles__editor-head"><div><h3>{editing.id === "new" ? t("users.roles.createCustomRole") : t("users.roles.editRoleName", { name: editing.name })}</h3><p>{t("users.roles.editorSubtitle")}</p></div><button className="jf-btn jf-btn--quiet jf-btn--sm" type="button" onClick={() => setEditing(null)} aria-label={t("users.roles.closeEditor")}>✕</button></div>
          <div className="jf-grid jf-grid--2">
            <label className="jf-field"><span className="jf-field__label">{t("users.roles.roleName")}</span><input className="jf-input" autoFocus required value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></label>
            <label className="jf-field"><span className="jf-field__label">{t("users.roles.description")}</span><input className="jf-input" placeholder={t("users.roles.descriptionPlaceholder")} value={editing.description ?? ""} onChange={(e) => setEditing({ ...editing, description: e.target.value })} /></label>
          </div>
          <div className="jf-roles__capabilities">{groups.map(([domain, capabilities]) => (
            <fieldset className="jf-roles__group" key={domain}><legend>{title(domain)}</legend>{capabilities.map((capability) => (
              <label key={capability.id} title={capability.description}><input type="checkbox" checked={editing.capabilities.includes(capability.id)} onChange={(e) => toggleCapability(capability.id, e.target.checked)} /><span>{capability.label || capability.id.slice(capability.id.indexOf(":") + 1).replaceAll(":", " · ")}</span></label>
            ))}</fieldset>
          ))}</div>
          <div className="jf-roles__editor-actions"><span>{t("users.roles.selectedCount", { count: editing.capabilities.length })}</span><button className="jf-btn jf-btn--quiet" type="button" disabled={saving} onClick={() => setEditing(null)}>{t("common.cancel")}</button><button className="jf-btn jf-btn--primary" type="button" disabled={saving || !editing.name.trim()} onClick={() => void save()}>{saving ? t("common.saving") : t("users.roles.saveRole")}</button></div>
        </div>
      )}
    </section>
  );
}
