/**
 * Plugin block previews, batched and cached (justflows-ce#308).
 *
 * Previews asked for within a few milliseconds of each other (every plugin
 * block on a page that just opened, or several blocks that changed together)
 * go to the server as one request of at most `BATCH_LIMIT` items, so a long
 * page neither floods the server nor runs into the preview rate limit.
 * Identical requests share one answer, and successful answers are kept for
 * the rest of the session until the block catalog reloads, since a preview
 * depends only on the block's type, version and props.
 *
 * The cache lives in this browser tab and is never shared: the admin runs per
 * site, and preview HTML is the block's own render of the props it was sent.
 */

export interface BlockPreviewRequest {
  type: string;
  props: unknown;
  version?: number;
}

export interface BlockPreviewResponse {
  status: number;
  body: { html?: string; placeholder?: boolean; migrationFailed?: boolean; error?: string };
}

const BATCH_LIMIT = 50;
const BATCH_DELAY_MS = 16;
const CACHE_LIMIT = 300;

interface Pending {
  key: string;
  request: BlockPreviewRequest;
  waiters: Array<{ resolve: (r: BlockPreviewResponse) => void; reject: (e: unknown) => void; signal?: AbortSignal }>;
}

const cache = new Map<string, BlockPreviewResponse>();
let queue: Pending[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function keyOf(request: BlockPreviewRequest): string {
  return JSON.stringify([request.type, request.version ?? null, request.props ?? null]);
}

function abortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

function remember(key: string, response: BlockPreviewResponse): void {
  if (response.status !== 200) return;
  cache.delete(key);
  cache.set(key, response);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

/** Forget every cached preview, e.g. after the block catalog reloaded. */
export function clearBlockPreviewCache(): void {
  cache.clear();
}

/** How many previews are cached, for diagnostics and tests. */
export function blockPreviewCacheSize(): number {
  return cache.size;
}

async function flush(): Promise<void> {
  timer = null;
  /** Requests whose every waiter gave up are dropped before sending. */
  const live = queue.filter((p) => p.waiters.some((w) => !w.signal?.aborted));
  queue = [];
  for (let i = 0; i < live.length; i += BATCH_LIMIT) {
    const batch = live.slice(i, i + BATCH_LIMIT);
    /** Shows in the browser's Performance panel, with the block types it covered. */
    const started = typeof performance !== "undefined" ? performance.now() : 0;
    const measure = () => {
      try {
        performance.measure(`jf-builder:preview ${[...new Set(batch.map((p) => p.request.type))].join(", ")} (${batch.length})`, { start: started });
      } catch {
        /** Older browsers without measure options: no diagnostics. */
      }
    };
    try {
      const res = await fetch("/api/blocks/preview/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: batch.map((p) => p.request) }),
      });
      const data = res.ok ? ((await res.json()) as { results?: BlockPreviewResponse[] }) : null;
      batch.forEach((pending, index) => {
        const response = data?.results?.[index] ?? { status: res.ok ? 422 : res.status, body: { error: "Preview failed" } };
        remember(pending.key, response);
        for (const waiter of pending.waiters) if (!waiter.signal?.aborted) waiter.resolve(response);
      });
      measure();
    } catch (error) {
      measure();
      for (const pending of batch) for (const waiter of pending.waiters) waiter.reject(error);
    }
  }
}

/**
 * The server's preview of one block. Resolves with the HTTP status and body
 * of that item; rejects with an `AbortError` when `signal` aborts first, or
 * with the network error when the request fails.
 */
export function requestBlockPreview(request: BlockPreviewRequest, signal?: AbortSignal): Promise<BlockPreviewResponse> {
  if (signal?.aborted) return Promise.reject(abortError());
  const key = keyOf(request);
  const cached = cache.get(key);
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, ...(signal ? { signal } : {}) };
    signal?.addEventListener("abort", () => reject(abortError()), { once: true });
    const existing = queue.find((p) => p.key === key);
    if (existing) existing.waiters.push(waiter);
    else queue.push({ key, request, waiters: [waiter] });
    timer ??= setTimeout(() => void flush(), BATCH_DELAY_MS);
  });
}
