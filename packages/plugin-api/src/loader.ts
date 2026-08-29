import {
  PluginManifestSchema,
  requiredPermissionForHook,
  isOwnedHookName,
  type PluginManifest,
  type PluginModule,
  type PluginContext,
  type PluginPermission,
  type PluginCacheApi,
  type PluginDataApi,
  type PluginJobsApi,
  type PluginSecretsApi,
  type PluginDatabasesApi,
  type PluginBlockDefinition,
  type PluginContentApi,
  type HookRegisterOptions,
  type Unsubscribe,
} from "@justflows/sdk";
import type { App } from "@justflows/core";
import { PluginHttpRouter } from "./http-router.js";

export interface LoadedPlugin {
  manifest: PluginManifest;
  module: PluginModule;
  state: "inactive" | "active" | "error";
  error?: Error;
}

export type PluginCacheFactory = (pluginId: string) => PluginCacheApi;
export type PluginDataFactory = (pluginId: string, siteId: string) => PluginDataApi;
export type PluginJobsFactory = (pluginId: string) => PluginJobsApi;
export type PluginSecretsFactory = (pluginId: string, siteId: string) => PluginSecretsApi;
export type PluginDatabasesFactory = (
  pluginId: string,
  siteId: string,
  permissions: ReadonlySet<PluginPermission>,
) => PluginDatabasesApi;
export type PluginContentFactory = (pluginId: string, siteId: string) => PluginContentApi;
export type PluginSettingsAdapter = {
  get<T = unknown>(siteId: string, pluginId: string, key: string): Promise<T | undefined>;
  set<T = unknown>(siteId: string, pluginId: string, key: string, value: T): Promise<void>;
  delete?(siteId: string, pluginId: string, key: string): Promise<void>;
};

export interface PluginBlockRegistry {
  register(definition: PluginBlockDefinition): void;
  unregister(type: string): void;
}

const NULL_CACHE: PluginCacheApi = {
  enabled: false,
  remember: async (_key, _ttl, fn) => fn(),
  get: async () => undefined,
  set: async () => undefined,
  delete: async () => undefined,
  invalidate: async () => undefined,
};

const NULL_DATA: PluginDataApi = {
  list: async () => [],
  get: async () => undefined,
  put: async () => undefined,
  delete: async () => undefined,
  cas: async () => false,
  transaction: async (fn) => fn(NULL_DATA),
  clear: async () => undefined,
};

const NULL_JOBS: PluginJobsApi = {
  register: () => {
    throw new Error("Job registration is not available in this runtime");
  },
  enqueue: () => {
    throw new Error("Job enqueue is not available in this runtime");
  },
};

const NULL_SECRETS: PluginSecretsApi = {
  set: async () => undefined,
  get: async () => undefined,
  has: async () => false,
  delete: async () => undefined,
};

const NULL_DATABASES: PluginDatabasesApi = {
  probeShared: async () => ({ ok: false, error: "Database probe is not available", tls: false, latencyMs: 0 }),
  probe: async () => ({ ok: false, error: "Database probe is not available", tls: false, latencyMs: 0 }),
  ensureSchema: async () => ({ ok: false, error: "Database schema is not available", tables: [] }),
  dropSchema: async () => ({ ok: false, error: "Database schema is not available", tables: [] }),
  upsert: async () => undefined,
  findOne: async () => undefined,
  find: async () => [],
  delete: async () => undefined,
  columns: async () => [],
};

const NULL_CONTENT: PluginContentApi = {
  ensureType: async () => {
    throw new Error("Content API is not available in this runtime");
  },
  ensurePage: async () => {
    throw new Error("Content API is not available in this runtime");
  },
  deleteType: async () => {
    throw new Error("Content API is not available in this runtime");
  },
};

export class PluginLoader {
  private readonly plugins = new Map<string, LoadedPlugin>();
  private readonly cacheFactory: PluginCacheFactory;
  private readonly dataFactory: PluginDataFactory;
  private readonly jobsFactory: PluginJobsFactory;
  private readonly secretsFactory: PluginSecretsFactory;
  private readonly databasesFactory: PluginDatabasesFactory;
  private readonly contentFactory: PluginContentFactory;
  private readonly jobsCleanup: ((pluginId: string) => void) | undefined;
  private readonly settingsAdapter: PluginSettingsAdapter;
  private readonly blockRegistry: PluginBlockRegistry | undefined;
  private readonly registeredBlocks = new Map<string, string[]>();
  readonly httpRouter: PluginHttpRouter;

  constructor(
    private readonly app: App,
    options?: {
      cacheFactory?: PluginCacheFactory;
      dataFactory?: PluginDataFactory;
      jobsFactory?: PluginJobsFactory;
      secretsFactory?: PluginSecretsFactory;
      databasesFactory?: PluginDatabasesFactory;
      contentFactory?: PluginContentFactory;
      jobsCleanup?: (pluginId: string) => void;
      settingsAdapter?: PluginSettingsAdapter;
      httpRouter?: PluginHttpRouter;
      blockRegistry?: PluginBlockRegistry;
    },
  ) {
    this.cacheFactory = options?.cacheFactory ?? (() => NULL_CACHE);
    this.dataFactory = options?.dataFactory ?? (() => NULL_DATA);
    this.jobsFactory = options?.jobsFactory ?? (() => NULL_JOBS);
    this.secretsFactory = options?.secretsFactory ?? (() => NULL_SECRETS);
    this.databasesFactory = options?.databasesFactory ?? ((_pluginId, _siteId, _permissions) => NULL_DATABASES);
    this.contentFactory = options?.contentFactory ?? (() => NULL_CONTENT);
    this.jobsCleanup = options?.jobsCleanup;
    this.settingsAdapter = options?.settingsAdapter ?? {
      get: (siteId, pluginId, key) => this.app.settings.get(siteId, `${pluginId}:${key}`),
      set: (siteId, pluginId, key, value) => this.app.settings.set(siteId, `${pluginId}:${key}`, value),
      delete: (siteId, pluginId, key) => this.app.settings.delete(siteId, `${pluginId}:${key}`),
    };
    this.httpRouter = options?.httpRouter ?? new PluginHttpRouter();
    this.blockRegistry = options?.blockRegistry;
  }

  /**
   * Register a plugin module directly (for local/in-process plugins).
   * In Phase 9+ this will also support loading from .jfpkg archives.
   */
  register(pluginModule: PluginModule): void {
    const parsed = PluginManifestSchema.safeParse(pluginModule.manifest);
    if (!parsed.success) {
      throw new Error(
        `Invalid plugin manifest for "${String(pluginModule.manifest.id)}":\n${parsed.error.message}`,
      );
    }

    const manifest = parsed.data;

    if (this.plugins.has(manifest.id)) {
      throw new Error(`Plugin "${manifest.id}" is already registered`);
    }

    this.plugins.set(manifest.id, {
      manifest,
      module: pluginModule,
      state: "inactive",
    });

    this.app.logger.info("Plugin registered", {
      pluginId: manifest.id,
      version: manifest.version,
    });
  }

  async activate(pluginId: string, siteId: string): Promise<void> {
    const entry = this.plugins.get(pluginId);
    if (!entry) throw new Error(`Plugin "${pluginId}" is not registered`);
    if (entry.state === "active") return;

    const ctx = this.buildContext(entry.manifest, siteId);

    try {
      await entry.module.activate(ctx);
      entry.state = "active";
      this.app.logger.info("Plugin activated", { pluginId, version: entry.manifest.version });
      await this.app.hooks.dispatchAction(
        "plugin.activated",
        { pluginId, version: entry.manifest.version, siteId },
        { siteId, source: "system" },
      );
    } catch (err) {
      this.cleanupPlugin(pluginId);
      entry.state = "error";
      entry.error = err instanceof Error ? err : new Error(String(err));
      this.app.logger.error("Plugin activation failed", { pluginId, error: String(err) });
      throw err;
    }
  }

  async deactivate(pluginId: string, siteId: string): Promise<void> {
    const entry = this.plugins.get(pluginId);
    if (!entry || entry.state !== "active") return;

    const ctx = this.buildContext(entry.manifest, siteId);

    try {
      await entry.module.deactivate?.(ctx);
    } catch (err) {
      this.app.logger.warn("Plugin deactivate() threw", { pluginId, error: String(err) });
    }

    this.cleanupPlugin(pluginId);
    entry.state = "inactive";

    this.app.logger.info("Plugin deactivated", { pluginId });
    await this.app.hooks.dispatchAction(
        "plugin.deactivated",
        { pluginId, version: entry.manifest.version, siteId },
        { siteId, source: "system" },
      );
  }

  /**
   * Run the plugin's `deleteData` hook. Works while inactive. Other plugins
   * then observe `plugin.deleteData`.
   */
  async deleteData(pluginId: string, siteId: string): Promise<void> {
    const entry = this.plugins.get(pluginId);
    if (!entry) throw new Error(`Plugin "${pluginId}" is not registered`);

    const ctx = this.buildContext(entry.manifest, siteId);
    const hook = entry.module.deleteData;
    if (typeof hook !== "function") {
      this.app.logger.warn("Plugin has no deleteData() hook", { pluginId });
      return;
    }
    try {
      await hook(ctx);
    } catch (err) {
      this.app.logger.error("Plugin deleteData() failed", { pluginId, error: String(err) });
      throw err;
    }

    this.app.logger.info("Plugin data deleted", { pluginId });
    await this.app.hooks.dispatchAction(
      "plugin.deleteData",
      { pluginId, version: entry.manifest.version, siteId },
      { siteId, source: "system" },
    );
  }

  getPlugin(pluginId: string): LoadedPlugin | undefined {
    return this.plugins.get(pluginId);
  }

  listPlugins(): LoadedPlugin[] {
    return Array.from(this.plugins.values());
  }

  private cleanupPlugin(pluginId: string): void {
    this.app.hooks.removePlugin(pluginId);
    this.httpRouter.removePlugin(pluginId);
    this.jobsCleanup?.(pluginId);
    const types = this.registeredBlocks.get(pluginId) ?? [];
    for (const type of types) this.blockRegistry?.unregister(type);
    this.registeredBlocks.delete(pluginId);
  }

  private buildContext(manifest: PluginManifest, siteId: string): PluginContext {
    const pluginId = manifest.id;
    const permissions = new Set(manifest.permissions);
    const logger = this.app.logger.child({ pluginId });
    const settings = this.settingsAdapter;
    const hooks = this.app.hooks;
    const cache = this.cacheFactory(pluginId);
    const data = this.dataFactory(pluginId, siteId);

    /**
     * Listening on a sensitive namespace requires the matching manifest
     * permission. This fails loudly at activation rather than silently at
     * runtime, so a mis-declared plugin never half-works in production.
     */
    const assertMayListen = (hook: string): void => {
      const required = requiredPermissionForHook(hook);
      if (required === null) return;
      if (permissions.has(required as PluginPermission)) return;
      throw new Error(
        `Plugin "${pluginId}" cannot register on "${hook}" without the ` +
          `"${required}" permission. Add it to the plugin manifest.`,
      );
    };

    /** A plugin may only emit hooks inside its own namespace. */
    const assertMayEmit = (hook: string): void => {
      if (isOwnedHookName(pluginId, hook)) return;
      throw new Error(
        `Plugin "${pluginId}" cannot emit "${hook}" — plugins may only emit ` +
          `hooks under their own namespace ("${pluginId}.*").`,
      );
    };

    const register = (
      kind: "action" | "gate" | "filter",
      hook: string,
      handler: unknown,
      options: HookRegisterOptions | undefined,
    ): Unsubscribe => {
      assertMayListen(hook);
      const opts = { ...options, pluginId };
      if (kind === "filter") {
        return hooks.filter(hook, handler as never, opts);
      }
      return hooks.action(hook, handler as never, opts);
    };

    return {
      pluginId,
      version: manifest.version,
      permissions,
      cache,
      hooks: {
        action: (hook, handler, options) => register("action", hook, handler, options),
        gate: (hook, handler, options) => register("gate", hook, handler, options),
        filter: (hook, handler, options) => register("filter", hook, handler, options),
        emit: async (hook, event) => {
          assertMayEmit(hook);
          await hooks.dispatchAction(hook, event, { siteId, source: "system" });
        },
        apply: async (hook, value, context) => {
          assertMayEmit(hook);
          return hooks.applyFilter(hook, value, context, { siteId, source: "system" });
        },
        check: async (hook, event) => {
          assertMayEmit(hook);
          await hooks.dispatchGate(hook, event as object, { siteId, source: "system" });
        },
        has: (hook) => hooks.has(hook),
      },
      settings: {
        get: (key) => settings.get(siteId, pluginId, key),
        set: (key, value) => settings.set(siteId, pluginId, key, value),
        delete: (key) => settings.delete?.(siteId, pluginId, key) ?? Promise.resolve(),
      },
      http: {
        get: (path, handler) => this.httpRouter.register(pluginId, "GET", path, handler),
        post: (path, handler) => this.httpRouter.register(pluginId, "POST", path, handler),
        put: (path, handler) => this.httpRouter.register(pluginId, "PUT", path, handler),
        patch: (path, handler) => this.httpRouter.register(pluginId, "PATCH", path, handler),
        delete: (path, handler) => this.httpRouter.register(pluginId, "DELETE", path, handler),
      },
      jobs: this.scopedJobs(pluginId, permissions),
      data,
      secrets: this.secretsFactory(pluginId, siteId),
      databases: this.databasesFactory(pluginId, siteId, permissions),
      content: this.scopedContent(pluginId, siteId, permissions),
      blocks: {
        register: (definition) => {
          if (!definition.type.startsWith(`${pluginId}.`) && definition.type !== pluginId) {
            throw new Error(
              `Plugin "${pluginId}" can only register blocks under its own namespace`,
            );
          }
          this.blockRegistry?.register(definition);
          const types = this.registeredBlocks.get(pluginId) ?? [];
          types.push(definition.type);
          this.registeredBlocks.set(pluginId, types);
        },
      },
      logger,
    };
  }

  private scopedContent(
    pluginId: string,
    siteId: string,
    permissions: Set<PluginPermission>,
  ): PluginContentApi {
    const inner = this.contentFactory(pluginId, siteId);
    const assertCreate = (): void => {
      if (permissions.has("content:create")) return;
      throw new Error(
        `Plugin "${pluginId}" cannot create content without the "content:create" permission. Add it to the plugin manifest.`,
      );
    };
    const assertPublish = (): void => {
      if (permissions.has("content:publish")) return;
      throw new Error(
        `Plugin "${pluginId}" cannot publish content without the "content:publish" permission. Add it to the plugin manifest.`,
      );
    };
    const assertDelete = (): void => {
      if (permissions.has("content:delete")) return;
      throw new Error(
        `Plugin "${pluginId}" cannot delete content without the "content:delete" permission. Add it to the plugin manifest.`,
      );
    };
    return {
      ensureType: (input) => {
        assertCreate();
        return inner.ensureType(input);
      },
      ensurePage: (input) => {
        assertCreate();
        if ((input.status ?? "draft") === "published") assertPublish();
        return inner.ensurePage(input);
      },
      deleteType: (slug) => {
        assertDelete();
        return inner.deleteType(slug);
      },
    };
  }

  private scopedJobs(pluginId: string, permissions: Set<PluginPermission>): PluginJobsApi {
    const inner = this.jobsFactory(pluginId);
    const assertJobs = (): void => {
      if (permissions.has("jobs:register")) return;
      throw new Error(
        `Plugin "${pluginId}" cannot use jobs without the "jobs:register" permission. Add it to the plugin manifest.`,
      );
    };
    return {
      register: (def) => {
        assertJobs();
        inner.register(def);
      },
      enqueue: (name, options) => {
        assertJobs();
        inner.enqueue(name, options);
      },
    };
  }
}
