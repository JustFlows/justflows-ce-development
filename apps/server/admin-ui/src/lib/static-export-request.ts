// SPDX-License-Identifier: MIT

/** Proxies can return an HTML error page even for a JSON API request. */
export async function readStaticExportJson<T>(
  response: Response,
  errorMessage: string,
): Promise<T> {
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new Error(errorMessage);
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new Error(errorMessage);
  }
}

export interface StaticExportJob {
  id: string;
  state: "running" | "completed" | "failed";
  log: string[];
  summary?: {
    pages: number;
    assets: number;
    bytes: number;
    pruned: number;
    outDir: string;
    durationMs: number;
    hitPageLimit: boolean;
    errors: string[];
  };
  error?: string;
}

export async function pollStaticExportJob(
  id: string,
  status: () => Promise<{ job?: StaticExportJob | null }>,
  update: (job: StaticExportJob) => void,
  errorMessage: string,
  delay: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 2000)),
): Promise<StaticExportJob> {
  for (let attempt = 0; attempt < 900; attempt++) {
    await delay();
    const { job } = await status();
    if (!job || job.id !== id) throw new Error(errorMessage);
    update(job);
    if (job.state !== "running") return job;
  }
  throw new Error(errorMessage);
}
