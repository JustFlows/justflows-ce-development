// SPDX-License-Identifier: MIT
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { EDITOR_LOCK_FLAGS, type EditorLockFlag } from "@justflows/blocks";
import { useT } from "../../i18n/I18nProvider";
import type { ActionState, BlockAction } from "./block-actions";
import type { MenuAnchor } from "./selection-context";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = IS_MAC ? "⌘" : "Ctrl+";
const SHIFT = IS_MAC ? "⇧" : "Shift+";

/** Shortcuts shown next to each action; PageBuilder binds the same keys. */
export const ACTION_SHORTCUTS: Partial<Record<BlockAction, string>> = {
  duplicate: `${MOD}D`,
  copy: `${MOD}C`,
  cut: `${MOD}X`,
  paste: `${MOD}V`,
  delete: IS_MAC ? "⌫" : "Del",
  group: `${MOD}G`,
  ungroup: `${MOD}${SHIFT}G`,
};

const GROUPS: BlockAction[][] = [
  ["duplicate", "copy", "cut", "paste", "delete"],
  ["group", "ungroup", "resetStyle"],
  ["saveReusable", "savePattern"],
];

export interface LockMenuState {
  /** Flags every selected block has. */
  flags: ReadonlySet<EditorLockFlag>;
  /** The actor may change locks (`content:locks:manage`). */
  canManage: boolean;
}

interface BlockActionsMenuProps {
  anchor: MenuAnchor;
  states: Record<BlockAction, ActionState>;
  lock: LockMenuState;
  onRun: (action: BlockAction) => void;
  onToggleLock: (flag: EditorLockFlag) => void;
  onClose: () => void;
}

/**
 * The contextual actions menu for the selected blocks: right-click, the "⋯"
 * button, Shift+F10, or the context-menu key. Unavailable actions stay listed,
 * disabled, with the reason underneath, so authors learn why rather than
 * wondering where an action went. Follows the WAI-ARIA menu pattern.
 */
export default function BlockActionsMenu({ anchor, states, lock, onRun, onToggleLock, onClose }: BlockActionsMenuProps) {
  const { t } = useT();
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(anchor);
  const opener = useRef<Element | null>(typeof document !== "undefined" ? document.activeElement : null);

  /** Keep the menu inside the viewport. */
  useLayoutEffect(() => {
    const el = menu.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    /** In right-to-left layouts the menu opens toward the start (left) of the anchor. */
    const rtl = getComputedStyle(el).direction === "rtl";
    const start = rtl ? anchor.x - rect.width : anchor.x;
    const x = Math.max(8, Math.min(start, window.innerWidth - rect.width - 8));
    const y = Math.max(8, Math.min(anchor.y, window.innerHeight - rect.height - 8));
    setPosition({ x, y });
  }, [anchor]);

  useEffect(() => {
    items()[0]?.focus();
    const onPointer = (e: PointerEvent) => {
      if (menu.current && !menu.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", onPointer, true);
    return () => document.removeEventListener("pointerdown", onPointer, true);
  }, []);

  function items(): HTMLElement[] {
    return Array.from(menu.current?.querySelectorAll<HTMLElement>("[role^='menuitem']") ?? []);
  }

  function close(restoreFocus = true) {
    onClose();
    if (restoreFocus && opener.current instanceof HTMLElement) opener.current.focus();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (e.key === "ArrowDown") next = (at + 1) % list.length;
    else if (e.key === "ArrowUp") next = (at - 1 + list.length) % list.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    else if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      close();
      return;
    }
    if (next >= 0) {
      e.preventDefault();
      list[next]?.focus();
    }
  }

  const run = (action: BlockAction) => {
    if (!states[action].ok) return;
    close(false);
    onRun(action);
  };

  const showLocks = lock.canManage || lock.flags.size > 0;

  return (
    <div
      ref={menu}
      role="menu"
      aria-label={t("builder.actions.menu")}
      className="jf-actions-menu"
      data-builder-chrome="true"
      style={{ left: position.x, top: position.y }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      onClick={(e) => e.stopPropagation()}
    >
      {GROUPS.map((group, gi) => (
        <div key={gi} role="group" className="jf-actions-menu__group">
          {group.map((action) => {
            const state = states[action];
            const reasonId = `jf-action-reason-${action}`;
            return (
              <button
                key={action}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="jf-actions-menu__item"
                aria-disabled={state.ok ? undefined : true}
                aria-describedby={state.ok ? undefined : reasonId}
                aria-keyshortcuts={ACTION_SHORTCUTS[action] ? keyshortcuts(action) : undefined}
                onClick={() => run(action)}
              >
                <span className="jf-actions-menu__label">{t(`builder.actions.${action}`)}</span>
                {ACTION_SHORTCUTS[action] && <kbd className="jf-actions-menu__kbd">{ACTION_SHORTCUTS[action]}</kbd>}
                {!state.ok && (
                  <span id={reasonId} className="jf-actions-menu__reason">
                    {t(`builder.actions.blocked.${state.reason}`)}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ))}
      {showLocks && (
        <div role="group" aria-label={t("builder.actions.locks")} className="jf-actions-menu__group">
          <div className="jf-actions-menu__heading" aria-hidden="true">
            {t("builder.actions.locks")}
          </div>
          {EDITOR_LOCK_FLAGS.map((flag) => (
            <button
              key={flag}
              type="button"
              role="menuitemcheckbox"
              tabIndex={-1}
              aria-checked={lock.flags.has(flag)}
              aria-disabled={lock.canManage ? undefined : true}
              aria-describedby={lock.canManage ? undefined : "jf-action-lock-reason"}
              className="jf-actions-menu__item"
              onClick={() => {
                if (!lock.canManage) return;
                onToggleLock(flag);
              }}
            >
              <span className="jf-actions-menu__check" aria-hidden="true">
                {lock.flags.has(flag) ? "✓" : ""}
              </span>
              <span className="jf-actions-menu__label">{t(`builder.actions.lock.${flag}`)}</span>
            </button>
          ))}
          {!lock.canManage && (
            <span id="jf-action-lock-reason" className="jf-actions-menu__reason">
              {t("builder.actions.lockedByPolicy")}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** `aria-keyshortcuts` uses key names, not symbols. */
function keyshortcuts(action: BlockAction): string {
  const mod = IS_MAC ? "Meta" : "Control";
  switch (action) {
    case "duplicate":
      return `${mod}+D`;
    case "copy":
      return `${mod}+C`;
    case "cut":
      return `${mod}+X`;
    case "paste":
      return `${mod}+V`;
    case "delete":
      return "Delete Backspace";
    case "group":
      return `${mod}+G`;
    case "ungroup":
      return `${mod}+Shift+G`;
    default:
      return "";
  }
}
