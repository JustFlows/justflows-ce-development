import { useEffect, useState } from "react";
import { useT } from "../../i18n/I18nProvider";
import MediaImageField from "../MediaImageField";
import MegaRegionEditor from "./MegaRegionEditor";
import { updateItem, type MegaMenuRegion, type MenuButtonStyle, type MenuItem } from "./menu-tree";
import { emptyLinksRegion, emptyPromoRegion } from "./mega-region";

const BUTTON_SIZES = ["sm", "md", "lg"] as const;
const isButtonPreset = (preset: string | undefined) => Boolean(preset && preset.startsWith("button"));

const CORE_VISIBILITY_ROLES = ["administrator", "editor", "author", "contributor", "subscriber"];
const DEVICES: Array<"desktop" | "tablet" | "mobile"> = ["desktop", "tablet", "mobile"];
const BADGE_TONES = ["info", "success", "warning", "danger"] as const;

interface MenuItemDrawerProps {
  item: MenuItem;
  items: MenuItem[];
  isMegaLayout: boolean;
  isTopLevel: boolean;
  activeLocales: string[];
  onChange: (items: MenuItem[]) => void;
  onClose: () => void;
}

export default function MenuItemDrawer({
  item,
  items,
  isMegaLayout,
  isTopLevel,
  activeLocales,
  onChange,
  onClose,
}: MenuItemDrawerProps) {
  const { t } = useT();
  const [visibilityRoles, setVisibilityRoles] = useState(CORE_VISIBILITY_ROLES);

  useEffect(() => {
    fetch("/api/roles")
      .then(async (res) => {
        if (!res.ok) return;
        const data = await res.json() as {
          roles?: Array<{ id: string; builtIn?: boolean; pluginId?: string | null }>;
        };
        const assignable = (data.roles ?? [])
          .filter((role) => role.builtIn || role.pluginId)
          .map((role) => role.id);
        if (assignable.length > 0) setVisibilityRoles(assignable);
      })
      .catch(() => undefined);
  }, []);

  function set(updater: (draft: MenuItem) => MenuItem) {
    onChange(updateItem(items, item.id, updater));
  }

  const visibility = item.visibility ?? {};
  const dropdown = item.dropdown ?? {};
  const regions = item.megaMenu?.regions ?? [];
  const buttonStyle = item.buttonStyle ?? {};

  function setButtonStyle(patch: Partial<MenuButtonStyle>) {
    set((d) => {
      const next: MenuButtonStyle = { ...(d.buttonStyle ?? {}), ...patch };
      for (const key of Object.keys(next) as (keyof MenuButtonStyle)[]) {
        const v = next[key];
        if (v === "" || v === undefined || v === null || v === false) delete next[key];
      }
      return { ...d, buttonStyle: Object.keys(next).length ? next : undefined };
    });
  }

  function toggleListValue<T extends string>(list: T[] | undefined, value: T): T[] {
    const values = new Set(list ?? []);
    if (values.has(value)) values.delete(value);
    else values.add(value);
    return [...values];
  }

  function moveRegion(from: number, dir: -1 | 1) {
    const to = from + dir;
    const list = item.megaMenu?.regions ?? [];
    if (to < 0 || to >= list.length) return;
    const next = [...list];
    [next[from], next[to]] = [next[to]!, next[from]!];
    updateRegions(next);
  }

  function updateRegions(next: MegaMenuRegion[]) {
    set((draft) => ({ ...draft, megaMenu: next.length ? { regions: next } : undefined }));
  }

  return (
    <div className="jf-card">
      <div className="jf-card__head">
        <h2 className="jf-card__title">{t("menus.itemSettings")}</h2>
        <button className="jf-btn jf-btn--ghost" onClick={onClose}>
          {t("common.close")}
        </button>
      </div>
      <div className="jf-card__body jf-stack">
        <div className="jf-field">
          <label className="jf-field__label" htmlFor="jf-item-label">{t("menus.customLabel")}</label>
          <input
            id="jf-item-label"
            className="jf-input"
            value={item.label}
            onChange={(e) => set((d) => ({ ...d, label: e.target.value }))}
          />
        </div>

        {item.type === "custom" && (
          <div className="jf-field">
            <label className="jf-field__label" htmlFor="jf-item-url">{t("menus.customUrl")}</label>
            <input
              id="jf-item-url"
              className="jf-input"
              value={item.url ?? ""}
              onChange={(e) => set((d) => ({ ...d, url: e.target.value }))}
            />
          </div>
        )}

        <div className="jf-field">
          <label className="jf-field__label" htmlFor="jf-item-title-attr">{t("menus.titleAttr")}</label>
          <input
            id="jf-item-title-attr"
            className="jf-input"
            value={item.titleAttr ?? ""}
            onChange={(e) => set((d) => ({ ...d, titleAttr: e.target.value || undefined }))}
          />
        </div>

        <div className="jf-field">
          <label className="jf-field__label" htmlFor="jf-item-style-preset">{t("menus.stylePreset")}</label>
          <input
            id="jf-item-style-preset"
            className="jf-input"
            placeholder="button"
            list="jf-item-style-preset-options"
            value={item.stylePreset ?? ""}
            onChange={(e) => set((d) => ({ ...d, stylePreset: e.target.value || undefined }))}
          />
          <datalist id="jf-item-style-preset-options">
            <option value="button" />
            <option value="button-outline" />
            <option value="button-ghost" />
          </datalist>
          <p className="jf-field__hint">{t("menus.stylePresetHint")}</p>
        </div>

        {isButtonPreset(item.stylePreset) && (
          <div className="jf-field">
            <span className="jf-field__label">{t("menus.button.title")}</span>
            <p className="jf-field__hint">{t("menus.button.hint")}</p>

            <div className="jf-row" style={{ flexWrap: "wrap", gap: "0.75rem" }}>
              {([
                ["bg", t("menus.button.bg")],
                ["fg", t("menus.button.fg")],
                ["border", t("menus.button.border")],
              ] as const).map(([key, label]) => {
                const val = buttonStyle[key] ?? "";
                return (
                  <div key={key} style={{ flex: "1 1 8rem" }}>
                    <span className="jf-field__label">{label}</span>
                    <div className="jf-row" style={{ flexWrap: "nowrap", gap: "0.25rem" }}>
                      <input
                        type="color"
                        className="jf-input"
                        style={{ width: 40, flex: "none", padding: 2 }}
                        aria-label={label}
                        value={/^#[0-9a-fA-F]{6}$/.test(val) ? val : "#3b82f6"}
                        onChange={(e) => setButtonStyle({ [key]: e.target.value })}
                      />
                      <input
                        type="text"
                        className="jf-input"
                        placeholder={t("menus.button.themeDefault")}
                        value={val}
                        onChange={(e) => setButtonStyle({ [key]: e.target.value || undefined })}
                      />
                      {val && (
                        <button
                          type="button"
                          className="jf-iconbtn"
                          aria-label={t("menus.button.reset")}
                          title={t("menus.button.reset")}
                          onClick={() => setButtonStyle({ [key]: undefined })}
                        >
                          ×
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="jf-row" style={{ marginTop: "0.5rem" }}>
              <label className="jf-field" style={{ flex: 1 }}>
                <span className="jf-field__label">{t("menus.button.borderWidth")}</span>
                <input
                  type="number"
                  min={0}
                  max={8}
                  className="jf-input"
                  placeholder={buttonStyle.border ? "1.5" : t("menus.button.themeDefault")}
                  value={buttonStyle.borderWidth ?? ""}
                  onChange={(e) =>
                    setButtonStyle({ borderWidth: e.target.value === "" ? undefined : Number(e.target.value) })
                  }
                />
              </label>
              <label className="jf-field" style={{ flex: 1 }}>
                <span className="jf-field__label">{t("menus.button.radius")}</span>
                <input
                  type="number"
                  min={0}
                  max={40}
                  className="jf-input"
                  placeholder={t("menus.button.themeDefault")}
                  value={buttonStyle.radius ?? ""}
                  onChange={(e) =>
                    setButtonStyle({ radius: e.target.value === "" ? undefined : Number(e.target.value) })
                  }
                />
              </label>
              <label className="jf-field" style={{ flex: 1 }}>
                <span className="jf-field__label">{t("menus.button.size")}</span>
                <select
                  className="jf-input"
                  value={buttonStyle.size ?? "md"}
                  onChange={(e) =>
                    setButtonStyle({ size: e.target.value === "md" ? undefined : (e.target.value as "sm" | "lg") })
                  }
                >
                  {BUTTON_SIZES.map((s) => (
                    <option key={s} value={s}>{t(`menus.button.size.${s}`)}</option>
                  ))}
                </select>
              </label>
            </div>

            <label className="jf-checkrow" style={{ marginTop: "0.4rem" }}>
              <input
                type="checkbox"
                checked={Boolean(buttonStyle.fullWidth)}
                onChange={(e) => setButtonStyle({ fullWidth: e.target.checked || undefined })}
              />
              <span>{t("menus.button.fullWidth")}</span>
            </label>
          </div>
        )}

        <label className="jf-checkrow">
          <input
            type="checkbox"
            checked={item.target === "_blank"}
            onChange={(e) => set((d) => ({ ...d, target: e.target.checked ? "_blank" : undefined }))}
          />
          <span>{t("menus.openInNewTab")}</span>
        </label>

        {item.target === "_blank" && (
          <div className="jf-field">
            <label className="jf-field__label" htmlFor="jf-item-rel">{t("menus.rel")}</label>
            <input
              id="jf-item-rel"
              className="jf-input"
              placeholder="sponsored nofollow"
              value={item.rel ?? ""}
              onChange={(e) => set((d) => ({ ...d, rel: e.target.value || undefined }))}
            />
            <p className="jf-field__hint">{t("menus.relHint")}</p>
          </div>
        )}

        <MediaImageField
          id="jf-item-icon"
          label={t("menus.icon")}
          value={item.icon ?? ""}
          onChange={(url) => set((d) => ({ ...d, icon: url || undefined }))}
          square
        />

        <MediaImageField
          id="jf-item-image"
          label={t("menus.image")}
          value={item.image ?? ""}
          onChange={(url) => set((d) => ({ ...d, image: url || undefined }))}
        />

        <div className="jf-field">
          <label className="jf-field__label" htmlFor="jf-item-description">{t("menus.description")}</label>
          <textarea
            id="jf-item-description"
            className="jf-input"
            rows={2}
            value={item.description ?? ""}
            onChange={(e) => set((d) => ({ ...d, description: e.target.value || undefined }))}
          />
        </div>

        <div className="jf-field">
          <label className="jf-field__label" htmlFor="jf-item-badge-text">{t("menus.badge")}</label>
          <div className="jf-row">
            <input
              id="jf-item-badge-text"
              className="jf-input"
              placeholder={t("menus.badgeText")}
              value={item.badge?.text ?? ""}
              onChange={(e) =>
                set((d) => ({
                  ...d,
                  badge: e.target.value ? { text: e.target.value, tone: d.badge?.tone } : undefined,
                }))
              }
            />
            <select
              className="jf-input"
              value={item.badge?.tone ?? "info"}
              disabled={!item.badge?.text}
              onChange={(e) =>
                set((d) => (d.badge ? { ...d, badge: { ...d.badge, tone: e.target.value as (typeof BADGE_TONES)[number] } } : d))
              }
            >
              {BADGE_TONES.map((tone) => (
                <option key={tone} value={tone}>{tone}</option>
              ))}
            </select>
          </div>
        </div>

        <hr className="jf-divider" />
        <h3 className="jf-card__title">{t("menus.visibility.title")}</h3>

        <div className="jf-field">
          <label className="jf-field__label" htmlFor="jf-item-auth">{t("menus.visibility.auth")}</label>
          <select
            id="jf-item-auth"
            className="jf-input"
            value={visibility.auth ?? "any"}
            onChange={(e) =>
              set((d) => ({
                ...d,
                visibility: { ...d.visibility, auth: e.target.value === "any" ? undefined : (e.target.value as "guest" | "authenticated") },
              }))
            }
          >
            <option value="any">{t("menus.visibility.authAny")}</option>
            <option value="guest">{t("menus.visibility.authGuest")}</option>
            <option value="authenticated">{t("menus.visibility.authAuthenticated")}</option>
          </select>
          <p className="jf-field__hint">
            {t("menus.visibility.authHint")}
          </p>
        </div>

        <div className="jf-field">
          <span className="jf-field__label">{t("menus.visibility.roles")}</span>
          <div className="jf-filterbar">
            {[...new Set([...visibilityRoles, ...(visibility.roles ?? [])])].map((role) => (
              <button
                key={role}
                type="button"
                className="jf-chip"
                aria-pressed={(visibility.roles ?? []).includes(role)}
                onClick={() =>
                  set((d) => ({
                    ...d,
                    visibility: { ...d.visibility, roles: toggleListValue(d.visibility?.roles, role) },
                  }))
                }
              >
                {role}
              </button>
            ))}
          </div>
        </div>

        {activeLocales.length > 1 && (
          <div className="jf-field">
            <span className="jf-field__label">{t("menus.visibility.locales")}</span>
            <div className="jf-filterbar">
              {activeLocales.map((locale) => (
                <button
                  key={locale}
                  type="button"
                  className="jf-chip"
                  aria-pressed={(visibility.locales ?? []).includes(locale)}
                  onClick={() =>
                    set((d) => ({
                      ...d,
                      visibility: { ...d.visibility, locales: toggleListValue(d.visibility?.locales, locale) },
                    }))
                  }
                >
                  {locale}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="jf-field">
          <span className="jf-field__label">{t("menus.visibility.devices")}</span>
          <p className="jf-field__hint">{t("menus.visibility.devicesHint")}</p>
          <div className="jf-filterbar">
            {DEVICES.map((device) => (
              <button
                key={device}
                type="button"
                className="jf-chip"
                aria-pressed={!(visibility.devices?.length) || visibility.devices.includes(device)}
                onClick={() =>
                  set((d) => ({
                    ...d,
                    visibility: { ...d.visibility, devices: toggleListValue(d.visibility?.devices, device) },
                  }))
                }
              >
                {device}
              </button>
            ))}
          </div>
        </div>

        <hr className="jf-divider" />
        <h3 className="jf-card__title">{t("menus.dropdown.title")}</h3>

        <label className="jf-checkrow">
          <input
            type="checkbox"
            checked={Boolean(dropdown.disableParentLink)}
            onChange={(e) =>
              set((d) => ({ ...d, dropdown: { ...d.dropdown, disableParentLink: e.target.checked || undefined } }))
            }
          />
          <span>{t("menus.dropdown.disableParentLink")}</span>
        </label>

        <div className="jf-field">
          <label className="jf-field__label" htmlFor="jf-item-align">{t("menus.dropdown.align")}</label>
          <select
            id="jf-item-align"
            className="jf-input"
            value={dropdown.align ?? "start"}
            onChange={(e) => set((d) => ({ ...d, dropdown: { ...d.dropdown, align: e.target.value as "start" | "center" | "end" } }))}
          >
            <option value="start">{t("menus.dropdown.alignStart")}</option>
            <option value="center">{t("menus.dropdown.alignCenter")}</option>
            <option value="end">{t("menus.dropdown.alignEnd")}</option>
          </select>
        </div>

        <div className="jf-field">
          <label className="jf-field__label" htmlFor="jf-item-width-mode">{t("menus.dropdown.widthMode")}</label>
          <select
            id="jf-item-width-mode"
            className="jf-input"
            value={typeof dropdown.width === "number" ? "fixed" : dropdown.width === "viewport" ? "viewport" : "auto"}
            onChange={(e) => {
              const mode = e.target.value;
              set((d) => ({
                ...d,
                dropdown: {
                  ...d.dropdown,
                  width: mode === "fixed" ? 720 : mode === "viewport" ? "viewport" : undefined,
                },
              }));
            }}
          >
            <option value="auto">{t("menus.dropdown.widthAuto")}</option>
            <option value="fixed">{t("menus.dropdown.widthFixed")}</option>
            <option value="viewport">{t("menus.dropdown.widthViewport")}</option>
          </select>
          <p className="jf-field__hint">{t("menus.dropdown.widthHint")}</p>
        </div>

        {typeof dropdown.width === "number" && (
          <div className="jf-field">
            <label className="jf-field__label" htmlFor="jf-item-width-px">{t("menus.dropdown.widthPx")}</label>
            <input
              id="jf-item-width-px"
              type="number"
              min={320}
              max={1600}
              step={10}
              className="jf-input"
              value={dropdown.width}
              onChange={(e) => set((d) => ({ ...d, dropdown: { ...d.dropdown, width: Number(e.target.value) || 720 } }))}
            />
          </div>
        )}

        <div className="jf-field">
          <label className="jf-field__label" htmlFor="jf-item-max-width">{t("menus.dropdown.maxWidth")}</label>
          <input
            id="jf-item-max-width"
            type="number"
            min={320}
            max={1800}
            step={10}
            className="jf-input"
            placeholder={t("menus.dropdown.maxWidthPlaceholder")}
            value={dropdown.maxWidth ?? ""}
            onChange={(e) =>
              set((d) => ({
                ...d,
                dropdown: { ...d.dropdown, maxWidth: e.target.value ? Number(e.target.value) : undefined },
              }))
            }
          />
        </div>

        <div className="jf-field">
          <span className="jf-field__label">{t("menus.dropdown.offset")}</span>
          <div className="jf-row">
            <input
              aria-label={t("menus.dropdown.offsetX")}
              type="number"
              min={-400}
              max={400}
              step={4}
              className="jf-input"
              placeholder={t("menus.dropdown.offsetX")}
              value={dropdown.offsetX ?? ""}
              onChange={(e) =>
                set((d) => ({
                  ...d,
                  dropdown: { ...d.dropdown, offsetX: e.target.value ? Number(e.target.value) : undefined },
                }))
              }
            />
            <input
              aria-label={t("menus.dropdown.offsetY")}
              type="number"
              min={-400}
              max={400}
              step={4}
              className="jf-input"
              placeholder={t("menus.dropdown.offsetY")}
              value={dropdown.offsetY ?? ""}
              onChange={(e) =>
                set((d) => ({
                  ...d,
                  dropdown: { ...d.dropdown, offsetY: e.target.value ? Number(e.target.value) : undefined },
                }))
              }
            />
          </div>
          <p className="jf-field__hint">{t("menus.dropdown.offsetHint")}</p>
        </div>

        {isMegaLayout && isTopLevel && (
          <>
            <hr className="jf-divider" />
            <h3 className="jf-card__title">{t("menus.mega.title")}</h3>
            <div className="jf-field">
              <label className="jf-field__label" htmlFor="jf-item-columns">{t("menus.mega.columns")}</label>
              <input
                id="jf-item-columns"
                type="number"
                min={1}
                max={6}
                className="jf-input"
                value={dropdown.columns ?? 3}
                onChange={(e) => set((d) => ({ ...d, dropdown: { ...d.dropdown, columns: Number(e.target.value) || 3 } }))}
              />
            </div>

            <div className="jf-stack jf-stack--sm">
              {regions.map((region, i) => (
                <MegaRegionEditor
                  key={region.id}
                  region={region}
                  canMoveUp={i > 0}
                  canMoveDown={i < regions.length - 1}
                  onMoveUp={() => moveRegion(i, -1)}
                  onMoveDown={() => moveRegion(i, 1)}
                  onChange={(next) => {
                    const nextRegions = [...regions];
                    nextRegions[i] = next;
                    updateRegions(nextRegions);
                  }}
                  onDelete={() => updateRegions(regions.filter((_, ri) => ri !== i))}
                />
              ))}
              <div className="jf-row">
                <button
                  type="button"
                  className="jf-btn jf-btn--ghost"
                  style={{ flex: 1 }}
                  onClick={() => updateRegions([...regions, emptyLinksRegion()])}
                >
                  {t("menus.mega.addLinkColumn")}
                </button>
                <button
                  type="button"
                  className="jf-btn jf-btn--ghost"
                  style={{ flex: 1 }}
                  onClick={() => updateRegions([...regions, emptyPromoRegion()])}
                >
                  {t("menus.mega.addPromoPanel")}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
