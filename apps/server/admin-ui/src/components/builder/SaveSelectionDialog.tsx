// SPDX-License-Identifier: MIT
import { useEffect, useId, useRef, useState } from "react";
import { useT } from "../../i18n/I18nProvider";

export type SaveKind = "reusable" | "pattern";

interface SaveSelectionDialogProps {
  kind: SaveKind;
  onSave: (input: { name: string; synced: boolean }) => Promise<void>;
  onClose: () => void;
}

/**
 * Names the selection before it is saved to the reusable block or pattern
 * library. A reusable block replaces the selection with a linked reference; a
 * pattern stores a copy and leaves the page as it is.
 */
export default function SaveSelectionDialog({ kind, onSave, onClose }: SaveSelectionDialogProps) {
  const { t } = useT();
  const titleId = useId();
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<Element | null>(typeof document !== "undefined" ? document.activeElement : null);
  const [name, setName] = useState("");
  const [synced, setSynced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    input.current?.focus();
  }, []);

  function close() {
    onClose();
    if (opener.current instanceof HTMLElement) opener.current.focus();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (kind === "pattern" && !name.trim()) {
      setError(t("builder.actions.save.nameRequired"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onSave({ name: name.trim(), synced });
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="jf-save-selection__backdrop" data-builder-chrome="true" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="jf-save-selection"
        onSubmit={submit}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
      >
        <h2 id={titleId}>{t(`builder.actions.save.${kind}Title`)}</h2>
        <p className="jf-save-selection__hint">{t(`builder.actions.save.${kind}Hint`)}</p>
        <label className="jf-save-selection__field">
          {kind === "pattern" ? t("builder.patterns.name") : t("builder.reusable.name")}
          <input
            ref={input}
            type="text"
            value={name}
            maxLength={120}
            required={kind === "pattern"}
            placeholder={kind === "reusable" ? t("builder.reusable.namePlaceholder") : undefined}
            aria-invalid={error ? true : undefined}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {kind === "pattern" && (
          <label className="jf-save-selection__check">
            <input type="checkbox" checked={synced} onChange={(e) => setSynced(e.target.checked)} />
            {t("builder.patterns.syncConfirm")}
          </label>
        )}
        {error && (
          <p className="jf-save-selection__error" role="alert">
            {error}
          </p>
        )}
        <div className="jf-save-selection__actions">
          <button type="button" className="jf-btn jf-btn--ghost" onClick={close} disabled={busy}>
            {t("builder.actions.save.cancel")}
          </button>
          <button type="submit" className="jf-btn jf-btn--primary" disabled={busy}>
            {kind === "reusable" ? t("builder.reusable.saveAndLink") : t("builder.actions.save.savePattern")}
          </button>
        </div>
      </form>
    </div>
  );
}
