import { useEffect, useRef } from "react";
import { useT } from "../../i18n/I18nProvider";
import { KEYBOARD_PATHS, keyLabel, type KeyboardPathArea } from "./keyboard-paths";

/**
 * Every keyboard path in the builder, grouped by where it applies
 * (justflows-ce#307). A native modal dialog, so focus stays inside while it is
 * open, Escape closes it, and focus returns to what opened it.
 */

const AREAS: KeyboardPathArea[] = ["canvas", "layers", "library", "text", "layout", "general"];

export default function KeyboardShortcutsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(typeof document !== "undefined" ? document.activeElement : null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
    else dialog?.setAttribute("open", "");
    const restore = opener.current;
    return () => {
      if (restore instanceof HTMLElement && restore.isConnected) restore.focus();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className="jf-shortcuts"
      aria-labelledby="jf-shortcuts-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div className="jf-shortcuts__head">
        <h2 id="jf-shortcuts-title">{t("builder.keyboard.title")}</h2>
        <button type="button" className="jf-btn jf-btn--ghost jf-btn--sm" onClick={onClose} autoFocus>
          {t("builder.keyboard.close")}
        </button>
      </div>
      <p className="jf-shortcuts__intro">{t("builder.keyboard.intro")}</p>
      {AREAS.map((area) => (
        <section key={area} className="jf-shortcuts__area">
          <h3>{t(`builder.keyboard.area.${area}`)}</h3>
          <dl>
            {KEYBOARD_PATHS.filter((path) => path.area === area).map((path) => (
              <div key={path.id} className="jf-shortcuts__row">
                <dt>{t(`builder.keyboard.path.${path.id}`)}</dt>
                <dd>
                  {path.keys.length === 0
                    ? t(`builder.keyboard.how.${path.id}`)
                    : path.keys.map((chord, i) => (
                        <span key={i} className="jf-shortcuts__chord">
                          {i > 0 && <span className="jf-shortcuts__or">{t("builder.keyboard.or")}</span>}
                          {chord.map((key) => <kbd key={key}>{keyLabel(key)}</kbd>)}
                        </span>
                      ))}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </dialog>
  );
}
