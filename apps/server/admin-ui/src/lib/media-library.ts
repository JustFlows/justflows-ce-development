import { translateEnglish, type Translate } from "../i18n/translate";
export interface MediaLibraryItem {
  url: string;
  filename: string;
}

/** What a media picker offers: one kind of media, or any uploaded file. */
export type MediaKind = "image" | "video" | "audio" | "file";

/** File types the upload accepts per kind; mirrors MEDIA_ALLOWED_TYPES on the server. */
export const MEDIA_ACCEPT: Record<MediaKind, string> = {
  image: "image/jpeg,image/png,image/gif,image/webp,image/avif,image/svg+xml",
  video: "video/mp4,video/webm",
  audio: "audio/mpeg,audio/ogg",
  file: "application/pdf,image/jpeg,image/png,image/gif,image/webp,image/avif,video/mp4,video/webm,audio/mpeg,audio/ogg",
};

function matchesKind(item: Record<string, unknown>, kind: MediaKind): boolean {
  const mime = String(item.mimeType ?? item.mime_type ?? "");
  const url = String(item.url ?? "");
  if (!url) return false;
  return kind === "file" ? true : mime.startsWith(`${kind}/`);
}

/** Upload any accepted media file; returns its URL. */
export async function uploadMedia(file: File, t: Translate = translateEnglish): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/media", { method: "POST", body: form });
  const data = (await res.json()) as { url?: string; error?: string };
  if (!res.ok || !data.url) throw new Error(data.error ?? t("common.uploadFailed"));
  return data.url;
}

export const uploadImage = uploadMedia;

/** Recent library items of one kind (or every file), newest first. */
export async function loadMediaLibrary(kind: MediaKind): Promise<MediaLibraryItem[]> {
  const res = await fetch("/api/media?limit=80");
  const body = (await res.json()) as { items?: Array<Record<string, unknown>> };
  return (body.items ?? [])
    .filter((item) => matchesKind(item, kind))
    .map((item) => ({ url: String(item.url), filename: String(item.filename ?? item.url) }));
}

export async function loadImageLibrary(): Promise<MediaLibraryItem[]> {
  return loadMediaLibrary("image");
}
