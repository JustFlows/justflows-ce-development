import { useRef, useState } from "react";
import { safeMediaSrc } from "@justflows/blocks";
import { loadMediaLibrary, MEDIA_ACCEPT, uploadMedia, type MediaKind, type MediaLibraryItem } from "../lib/media-library";
import { useT } from "../i18n/I18nProvider";

type MediaItem = MediaLibraryItem;

export default function MediaImageField({
  id,
  label,
  description,
  value,
  onChange,
  square = false,
  kind = "image",
}: {
  id: string;
  label: string;
  description?: string;
  value: string;
  onChange: (url: string) => void;
  square?: boolean;
  /**
   * What the field holds. `image` (default) shows thumbnails; `video`,
   * `audio` and `file` list filenames and only accept that kind of upload.
   */
  kind?: MediaKind;
}) {
  const { t } = useT();
  const fileRef = useRef<HTMLInputElement>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [library, setLibrary] = useState<MediaItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function openLibrary() {
    setError("");
    setLibraryOpen(true);
    if (library) return;
    try {
      setLibrary(await loadMediaLibrary(kind));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLibrary([]);
    }
  }

  async function handleUpload(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const url = await uploadMedia(file, t);
      onChange(url);
      setLibraryOpen(false);
      setLibrary((prev) => (prev ? [{ url, filename: file.name }, ...prev] : prev));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function pick(url: string) {
    onChange(url);
    setLibraryOpen(false);
  }

  return (
    <div className="jf-field">
      <label className="jf-field__label" htmlFor={id}>{label}</label>
      {description ? <p className="jf-field__hint">{description}</p> : null}

      <div
        className={`jf-media-field__preview${square ? " jf-media-field__preview--square" : ""}`}
        data-empty={!value || undefined}
      >
        {value && kind === "image" ? (
          <img src={safeMediaSrc(value)} alt="" />
        ) : value ? (
          <span className="jf-media-field__name">{decodeURIComponent(value.split("/").pop() || value)}</span>
        ) : (
          <span className="jf-field__hint">{kind === "image" ? t("mediaField.noImageSelected") : t("mediaField.noFileSelected")}</span>
        )}
      </div>

      <div className="jf-row">
        <button type="button" className="jf-btn jf-btn--sm" onClick={openLibrary} disabled={busy}>
          {value ? t("mediaField.select") : kind === "image" ? t("mediaField.selectImage") : t("mediaField.selectFile")}
        </button>
        <button
          type="button"
          className="jf-btn jf-btn--sm jf-btn--primary"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
        >
          {busy ? t("mediaField.uploading") : t("mediaField.upload")}
        </button>
        {value ? (
          <button type="button" className="jf-btn jf-btn--sm jf-btn--quiet" onClick={() => onChange("")}>
            {t("mediaField.remove")}
          </button>
        ) : null}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept={kind === "image" ? "image/jpeg,image/png,image/gif,image/webp,image/avif,image/svg+xml,image/x-icon,.ico,.svg" : MEDIA_ACCEPT[kind]}
        hidden
        onChange={(e) => void handleUpload(e.target.files?.[0])}
      />

      {error ? <p className="jf-field__hint" role="alert" style={{ color: "var(--jf-danger)" }}>{error}</p> : null}

      {libraryOpen ? (
        <div className="jf-media-library" role="listbox" aria-label={t("mediaField.mediaLibraryAriaLabel")}>
          {library === null ? (
            <p className="jf-field__hint" style={{ gridColumn: "1 / -1" }}>{t("common.loading")}</p>
          ) : library.length === 0 ? (
            <p className="jf-field__hint" style={{ gridColumn: "1 / -1" }}>
              {kind === "image" ? t("mediaField.noImagesYet") : t("mediaField.noFilesYet")}
            </p>
          ) : (
            library.map((item) => (
              <button
                key={item.url}
                type="button"
                className="jf-media-library__item"
                data-selected={item.url === value || undefined}
                title={item.filename}
                onClick={() => pick(item.url)}
              >
                {kind === "image" ? <img src={safeMediaSrc(item.url)} alt="" /> : <span className="jf-media-library__name">{item.filename}</span>}
              </button>
            ))
          )}
        </div>
      ) : null}

      <details>
        <summary className="jf-field__hint" style={{ cursor: "pointer" }}>{t("mediaField.pasteUrl")}</summary>
        <input
          id={id}
          className="jf-input"
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="https://… or /uploads/…"
        />
      </details>
    </div>
  );
}
