/**
 * @justflows/jobs — In-process job scheduler.
 *
 * Supports:
 *  - Cron-style schedules (simple: "* * * * *" minute-level precision)
 *  - One-shot delayed jobs
 *  - Named job registration with retry logic
 *  - No external dependencies — works without Redis
 */

export interface JobContext {
  jobId: string;
  name: string;
  attempt: number;
  scheduledAt: Date;
  payload?: unknown;
  logger: {
    info(msg: string, ctx?: Record<string, unknown>): void;
    warn(msg: string, ctx?: Record<string, unknown>): void;
    error(msg: string, ctx?: Record<string, unknown>): void;
  };
}

export interface JobResult {
  success: boolean;
  message?: string;
}

export interface JobDefinition {
  /** Unique name, e.g. "content.publish-scheduled" */
  name: string;
  /** Cron expression (5-part: min hour dom month dow) or undefined for one-shot */
  schedule?: string;
  /** Max retry attempts on failure */
  maxAttempts?: number;
  handler(ctx: JobContext): Promise<JobResult>;
}

export interface ScheduledJob {
  id: string;
  name: string;
  schedule?: string;
  nextRunAt: Date;
  lastRunAt?: Date;
  lastResult?: JobResult;
  attempts: number;
  maxAttempts: number;
  status: "pending" | "running" | "failed" | "done";
}

interface JobEntry extends Omit<JobDefinition, "maxAttempts"> {
  id: string;
  nextRunAt: Date;
  lastRunAt?: Date;
  lastResult?: JobResult;
  attempts: number;
  maxAttempts: number;
  status: ScheduledJob["status"];
  payload?: unknown;
  timer?: ReturnType<typeof setTimeout>;
}

type SimpleLogger = {
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
};

/** Parse a 5-part cron expression and compute the next Date after `from`. */
function nextCronDate(cron: string, from: Date): Date {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Invalid cron expression: ${cron}`);
  const [minuteSpec, hourSpec, domSpec, monthSpec, dowSpec] = parts as [string, string, string, string, string];

  const matches = (spec: string, value: number): boolean => {
    if (spec === "*") return true;
    return spec.split(",").some((part) => {
      if (part.includes("/")) {
        const [rangeStr, stepStr] = part.split("/");
        const step = parseInt(stepStr!, 10);
        const range = rangeStr === "*" ? [0, 59] : rangeStr!.split("-").map(Number);
        const start = range[0]!;
        const end = range[1] ?? start;
        return value >= start && value <= end && (value - start) % step === 0;
      }
      if (part.includes("-")) {
        const [a, b] = part.split("-").map(Number);
        return value >= a! && value <= b!;
      }
      return parseInt(part, 10) === value;
    });
  };

  const d = new Date(from.getTime() + 60_000); // start at least 1 minute ahead
  d.setSeconds(0, 0);

  for (let i = 0; i < 366 * 24 * 60; i++) {
    const min = d.getMinutes();
    const hour = d.getHours();
    const dom = d.getDate();
    const month = d.getMonth() + 1;
    const dow = d.getDay();

    if (
      matches(minuteSpec, min) &&
      matches(hourSpec, hour) &&
      matches(domSpec, dom) &&
      matches(monthSpec, month) &&
      matches(dowSpec, dow)
    ) {
      return new Date(d);
    }

    d.setTime(d.getTime() + 60_000);
  }

  throw new Error(`Could not find next cron date for: ${cron}`);
}

export class JobScheduler {
  private readonly jobs = new Map<string, JobEntry>();
  private running = false;
  private ticker?: ReturnType<typeof setInterval>;

  constructor(private readonly logger: SimpleLogger = console) {}

  /**
   * Register a job definition. If `schedule` is provided, the job runs on that cron.
   * If not provided, call `enqueue(name)` to trigger it manually.
   */
  register(def: JobDefinition): void {
    if (this.jobs.has(def.name)) {
      throw new Error(`Job "${def.name}" is already registered`);
    }

    const entry: JobEntry = {
      ...def,
      id: def.name,
      nextRunAt: def.schedule ? nextCronDate(def.schedule, new Date()) : new Date(Date.now() + 1e15),
      attempts: 0,
      maxAttempts: def.maxAttempts ?? 3,
      status: "pending",
    };

    this.jobs.set(def.name, entry);
    this.logger.info(`[jobs] Registered job "${def.name}"${def.schedule ? ` (cron: ${def.schedule})` : ""}`);
  }

  /** Manually enqueue a one-shot execution of a registered job. */
  enqueue(name: string, delayMs = 0, payload?: unknown): void {
    const entry = this.jobs.get(name);
    if (!entry) throw new Error(`Job "${name}" not found`);
    entry.nextRunAt = new Date(Date.now() + delayMs);
    entry.status = "pending";
    entry.payload = payload;
    entry.attempts = 0;
  }

  unregister(name: string): void {
    this.jobs.delete(name);
  }

  unregisterPrefix(prefix: string): void {
    for (const name of [...this.jobs.keys()]) {
      if (name === prefix || name.startsWith(`${prefix}:`)) this.jobs.delete(name);
    }
  }

  /** Start the scheduler tick loop (every 30 seconds). */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.tick(); // run immediately on start
    this.ticker = setInterval(() => this.tick(), 30_000);
    this.logger.info("[jobs] Scheduler started");
  }

  /** Stop the scheduler. Running jobs complete normally. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.ticker) clearInterval(this.ticker);
    this.logger.info("[jobs] Scheduler stopped");
  }

  listJobs(): ScheduledJob[] {
    return Array.from(this.jobs.values()).map((e) => ({
      id: e.id,
      name: e.name,
      nextRunAt: e.nextRunAt,
      attempts: e.attempts,
      maxAttempts: e.maxAttempts,
      status: e.status,
      ...(e.schedule === undefined ? {} : { schedule: e.schedule }),
      ...(e.lastRunAt === undefined ? {} : { lastRunAt: e.lastRunAt }),
      ...(e.lastResult === undefined ? {} : { lastResult: e.lastResult }),
    }));
  }

  private async tick(): Promise<void> {
    const now = new Date();

    for (const entry of this.jobs.values()) {
      if (entry.status === "running") continue;
      if (entry.nextRunAt > now) continue;

      this.runJob(entry);
    }
  }

  private async runJob(entry: JobEntry): Promise<void> {
    entry.status = "running";
    entry.attempts++;

    const ctx: JobContext = {
      jobId: entry.id,
      name: entry.name,
      attempt: entry.attempts,
      scheduledAt: entry.nextRunAt,
      payload: entry.payload,
      logger: this.logger,
    };

    try {
      const result = await entry.handler(ctx);
      entry.lastResult = result;
      entry.lastRunAt = new Date();
      entry.status = entry.schedule ? "pending" : "done";
      entry.attempts = 0;

      if (entry.schedule) {
        entry.nextRunAt = nextCronDate(entry.schedule, new Date());
      }

      this.logger.info(`[jobs] "${entry.name}" completed`, { success: result.success });
    } catch (err) {
      this.logger.error(`[jobs] "${entry.name}" attempt ${entry.attempts} failed`, { error: String(err) });
      entry.lastResult = { success: false, message: String(err) };
      entry.lastRunAt = new Date();

      if (entry.attempts >= entry.maxAttempts) {
        entry.status = "failed";
        this.logger.error(`[jobs] "${entry.name}" permanently failed after ${entry.attempts} attempts`);
      } else {
        // Exponential backoff: 1min, 5min, 15min
        const backoff = Math.pow(5, entry.attempts) * 60_000;
        entry.nextRunAt = new Date(Date.now() + backoff);
        entry.status = "pending";
      }
    }
  }
}
