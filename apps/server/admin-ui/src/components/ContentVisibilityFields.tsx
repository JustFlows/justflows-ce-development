// SPDX-License-Identifier: MIT
import { useEffect, useMemo, useState } from "react";
import type { ContentVisibilityPolicy, ContentVisibilityRuleRef } from "@justflows/content";
import { useT } from "../i18n/I18nProvider";

interface RuleField {
  name: string;
  label: string;
  type: "text" | "number" | "boolean" | "select";
  required?: boolean;
  options: Array<{ value: string; label: string }>;
}

interface RuleType {
  id: string;
  label: string;
  description: string;
  fields: RuleField[];
}

interface Person {
  id: string;
  label: string;
}

type Role = Person;

const EMPTY_POLICY: ContentVisibilityPolicy = {
  audience: "everyone",
  allowRoles: [],
  denyRoles: [],
  allowUsers: [],
  denyUsers: [],
  rules: [],
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Roles and people to pick from. Staff without `users:read` still get the built-in roles and can enter an id. */
export function useVisibilityDirectory() {
  const [roles, setRoles] = useState<Role[]>(
    ["administrator", "editor", "author", "subscriber"].map((id) => ({ id, label: id })),
  );
  const [people, setPeople] = useState<Person[] | null>(null);
  const [ruleTypes, setRuleTypes] = useState<RuleType[]>([]);
  useEffect(() => {
    let cancelled = false;
    const json = async (url: string) => {
      const res = await fetch(url);
      return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
    };
    void Promise.all([json("/api/roles"), json("/api/users"), json("/api/content-visibility/rule-types")])
      .then(([roleBody, userBody, ruleBody]) => {
        if (cancelled) return;
        const listed = (roleBody?.roles ?? []) as Array<{ id: string; name?: string }>;
        if (listed.length) setRoles(listed.map((role) => ({ id: role.id, label: role.name || role.id })));
        if (userBody) {
          const users = (userBody.users ?? []) as Array<{ id: string; display_name?: string; username?: string; email?: string }>;
          setPeople(users.map((user) => ({ id: user.id, label: user.display_name || user.username || user.email || user.id })));
        }
        setRuleTypes(((ruleBody?.types ?? []) as RuleType[]));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return { roles, people, ruleTypes };
}

function RoleChecks({
  id,
  legend,
  roles,
  selected,
  onChange,
}: {
  id: string;
  legend: string;
  roles: Role[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const known = new Set(roles.map((role) => role.id));
  const shown = [...roles, ...selected.filter((id) => !known.has(id)).map((id) => ({ id, label: id }))];
  return (
    <div className="jf-field" role="group" aria-labelledby={id}>
      <span className="jf-field__label" id={id}>
        {legend}
      </span>
      {shown.map((role) => (
        <label key={role.id} className="jf-checkrow">
          <input
            type="checkbox"
            checked={selected.includes(role.id)}
            onChange={(e) => onChange(e.target.checked ? [...selected, role.id] : selected.filter((value) => value !== role.id))}
          />
          {role.label}
        </label>
      ))}
    </div>
  );
}

function UserPicker({
  id,
  legend,
  people,
  selected,
  onChange,
}: {
  id: string;
  legend: string;
  people: Person[] | null;
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const { t } = useT();
  const [draft, setDraft] = useState("");
  const names = useMemo(() => new Map((people ?? []).map((person) => [person.id, person.label])), [people]);
  const add = (value: string) => {
    const next = value.trim();
    if (UUID.test(next) && !selected.includes(next)) onChange([...selected, next]);
    setDraft("");
  };
  return (
    <div className="jf-field">
      <label className="jf-field__label" htmlFor={id}>
        {legend}
      </label>
      {selected.length > 0 && (
        <div className="jf-row" style={{ flexWrap: "wrap", gap: "0.35rem" }}>
          {selected.map((userId) => {
            const name = names.get(userId) ?? userId;
            return (
              <span key={userId} className="jf-badge" style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem" }}>
                {name}
                <button
                  type="button"
                  className="jf-btn jf-btn--ghost jf-btn--sm"
                  style={{ padding: "0 0.25rem", minHeight: 0 }}
                  aria-label={t("visibility.remove", { name })}
                  onClick={() => onChange(selected.filter((value) => value !== userId))}
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      )}
      {people ? (
        <select id={id} className="jf-input" value="" onChange={(e) => add(e.target.value)}>
          <option value="">{t("visibility.userSearch")}</option>
          {people
            .filter((person) => !selected.includes(person.id))
            .map((person) => (
              <option key={person.id} value={person.id}>
                {person.label}
              </option>
            ))}
        </select>
      ) : (
        <>
          <input
            id={id}
            className="jf-input"
            placeholder={t("visibility.userIdPlaceholder")}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => add(draft)}
          />
          <span className="jf-field__hint">{t("visibility.userIdHint")}</span>
        </>
      )}
    </div>
  );
}

function RuleEditor({
  idPrefix,
  rule,
  type,
  onChange,
  onRemove,
}: {
  idPrefix: string;
  rule: ContentVisibilityRuleRef;
  type: RuleType | undefined;
  onChange: (next: ContentVisibilityRuleRef) => void;
  onRemove: () => void;
}) {
  const { t } = useT();
  const name = type?.label ?? rule.id;
  const setParam = (key: string, value: string | number | boolean) =>
    onChange({ ...rule, params: { ...rule.params, [key]: value } });
  return (
    <div className="jf-card">
      <div className="jf-card__head">
        <h3 className="jf-card__title">{name}</h3>
        <button type="button" className="jf-btn jf-btn--ghost jf-btn--sm" aria-label={t("visibility.remove", { name })} onClick={onRemove}>
          ×
        </button>
      </div>
      <div className="jf-card__body jf-stack">
      {type ? (
        type.description && <p className="jf-field__hint" style={{ margin: 0 }}>{type.description}</p>
      ) : (
        <p className="jf-field__hint" style={{ margin: 0 }}>{t("visibility.ruleMissing")}</p>
      )}
      <div className="jf-field">
        <label className="jf-field__label" htmlFor={`${idPrefix}-mode`}>
          {t("visibility.ruleMode")}
        </label>
        <select
          id={`${idPrefix}-mode`}
          className="jf-input"
          value={rule.mode}
          onChange={(e) => onChange({ ...rule, mode: e.target.value as ContentVisibilityRuleRef["mode"] })}
        >
          {(["require", "grant"] as const).map((mode) => (
            <option key={mode} value={mode}>
              {t(`visibility.ruleModes.${mode}`)}
            </option>
          ))}
        </select>
      </div>
      {type?.fields.map((field) => {
        const id = `${idPrefix}-${field.name}`;
        const value = rule.params[field.name];
        if (field.type === "boolean") {
          return (
            <label key={field.name} className="jf-checkrow">
              <input type="checkbox" checked={value === true} onChange={(e) => setParam(field.name, e.target.checked)} />
              {field.label}
            </label>
          );
        }
        return (
          <div key={field.name} className="jf-field">
            <label className="jf-field__label" htmlFor={id}>
              {field.label}
            </label>
            {field.type === "select" ? (
              <select id={id} className="jf-input" required={field.required} value={String(value ?? "")} onChange={(e) => setParam(field.name, e.target.value)}>
                <option value="" />
                {field.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={id}
                className="jf-input"
                type={field.type === "number" ? "number" : "text"}
                required={field.required}
                value={String(value ?? "")}
                onChange={(e) => setParam(field.name, field.type === "number" ? Number(e.target.value) : e.target.value)}
              />
            )}
          </div>
        );
      })}
      </div>
    </div>
  );
}

/** Edits one policy. `null` means no rule of its own. */
export default function ContentVisibilityFields({
  idPrefix,
  policy,
  onChange,
}: {
  idPrefix: string;
  policy: ContentVisibilityPolicy | null;
  onChange: (policy: ContentVisibilityPolicy | null) => void;
}) {
  const { t } = useT();
  const { roles, people, ruleTypes } = useVisibilityDirectory();
  const value = policy ?? EMPTY_POLICY;
  const update = (patch: Partial<ContentVisibilityPolicy>) => onChange({ ...value, ...patch });
  const unused = ruleTypes.filter((type) => !value.rules.some((rule) => rule.id === type.id));
  return (
    <div className="jf-stack">
      <div className="jf-field">
        <label className="jf-field__label" htmlFor={`${idPrefix}-audience`}>
          {t("visibility.audience")}
        </label>
        <select
          id={`${idPrefix}-audience`}
          className="jf-input"
          value={value.audience}
          onChange={(e) => update({ audience: e.target.value as ContentVisibilityPolicy["audience"] })}
        >
          {(["everyone", "authenticated", "nobody"] as const).map((audience) => (
            <option key={audience} value={audience}>
              {t(`visibility.audiences.${audience}`)}
            </option>
          ))}
        </select>
        <span className="jf-field__hint">{t("visibility.precedence")}</span>
      </div>
      <RoleChecks id={`${idPrefix}-allow-roles`} legend={t("visibility.allowRoles")} roles={roles} selected={value.allowRoles} onChange={(allowRoles) => update({ allowRoles })} />
      <RoleChecks id={`${idPrefix}-deny-roles`} legend={t("visibility.denyRoles")} roles={roles} selected={value.denyRoles} onChange={(denyRoles) => update({ denyRoles })} />
      <UserPicker id={`${idPrefix}-allow-users`} legend={t("visibility.allowUsers")} people={people} selected={value.allowUsers} onChange={(allowUsers) => update({ allowUsers })} />
      <UserPicker id={`${idPrefix}-deny-users`} legend={t("visibility.denyUsers")} people={people} selected={value.denyUsers} onChange={(denyUsers) => update({ denyUsers })} />
      <div className="jf-stack jf-stack--sm">
        <span className="jf-field__label">{t("visibility.rules")}</span>
        {value.rules.map((rule, index) => (
          <RuleEditor
            key={rule.id}
            idPrefix={`${idPrefix}-rule-${index}`}
            rule={rule}
            type={ruleTypes.find((type) => type.id === rule.id)}
            onChange={(next) => update({ rules: value.rules.map((entry, at) => (at === index ? next : entry)) })}
            onRemove={() => update({ rules: value.rules.filter((_, at) => at !== index) })}
          />
        ))}
        {ruleTypes.length === 0 && value.rules.length === 0 ? (
          <span className="jf-field__hint">{t("visibility.noRules")}</span>
        ) : unused.length > 0 ? (
          <select
            className="jf-input"
            aria-label={t("visibility.addRule")}
            value=""
            onChange={(e) => {
              if (e.target.value) update({ rules: [...value.rules, { id: e.target.value, mode: "require", params: {} }] });
            }}
          >
            <option value="">{t("visibility.addRule")}</option>
            {unused.map((type) => (
              <option key={type.id} value={type.id}>
                {type.label}
              </option>
            ))}
          </select>
        ) : null}
      </div>
    </div>
  );
}
