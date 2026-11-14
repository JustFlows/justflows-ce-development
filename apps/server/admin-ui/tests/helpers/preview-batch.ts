/**
 * Answers the builder's batched preview request (`/api/blocks/preview/batch`,
 * justflows-ce#308) from a handler written for one preview at a time, so
 * tests describe each block's preview as a plain response.
 */
export async function batchPreview(
  init: RequestInit | undefined,
  single: (item: Record<string, unknown>) => Response | Promise<Response>,
): Promise<Response> {
  const { items } = JSON.parse(String(init?.body)) as { items: Array<Record<string, unknown>> };
  const results = await Promise.all(
    items.map(async (item) => {
      const res = await single(item);
      return { status: res.status, body: await res.json() };
    }),
  );
  return { ok: true, status: 200, json: async () => ({ results }) } as Response;
}
