import {
  PluginManifestSchema,
  requiredPermissionForHook,
  isOwnedHookName,
  SDK_API_VERSION,
  SDK_VERSION,
  resolveCookies,
  type PluginManifest,
  type PluginModule,
  type PluginContext,
  type PluginPermission,
  type PluginCacheApi,
  type PluginDataApi,
  type PluginJobsApi,
  type PluginMailTransportApi,
  type PluginSecretsApi,
  type PluginDatabasesApi,
  type PluginTenancyApi,
  type PluginQuotasApi,
  type PluginUsersApi,
  type PluginBlockDefinition,
  type PluginContentApi,
  type PluginFilesApi,
  type HookRegisterOptions,
  type Unsubscribe,
  type CookieCategory,
  type CookieDeclaration,
  type PlaceholderImage,
} from "@justflows/sdk";
import type { App } from "@justflows/core";
import { PluginHttpRouter } from "./http-router.js";
import { PluginCookieRegistry } from "./cookie-registry.js";
import { PluginCapabilityRegistry } from "./capability-registry.js";
import { PluginRoleRegistry } from "./role-registry.js";
import { PluginDiagnosticRegistry } from "./diagnostic-registry.js";
import { PluginPatternRegistry } from "./pattern-registry.js";
import { PluginPlaceholderRegistry, placeholderImgHtml } from "./placeholder-registry.js";

export interface LoadedPlugin {
  manifest: PluginManifest;
  module: PluginModule;
  state: "inactive" | "active" | "error";
  error?: Error;
}

export type PluginCacheFactory = (pluginId: string) => PluginCacheApi;
export type PluginDataFactory = (pluginId: string, siteId: string) => PluginDataApi;
export type PluginJobsFactory = (pluginId: string) => PluginJobsApi;
export type PluginMailFactory = (
  pluginId: string,
  permissions: ReadonlySet<PluginPermission>,
) => PluginMailTransportApi;
export type PluginSecretsFactory = (pluginId: string, siteId: string) => PluginSecretsApi;
export type PluginDatabasesFactory = (
  pluginId: string,
  siteId: string,
  permissions: ReadonlySet<PluginPermission>,
) => PluginDatabasesApi;
export type PluginTenancyFactory = (
  pluginId: string,
  permissions: ReadonlySet<PluginPermission>,
) => PluginTenancyApi;
export type PluginQuotasFactory = (
  pluginId: string,
  permissions: ReadonlySet<PluginPermission>,
  siteId: string,
) => PluginQuotasApi;
export type PluginContentFactory = (pluginId: string, siteId: string) => PluginContentApi;
export type PluginFilesFactory = (pluginId: string, siteId: string) => PluginFilesApi;
export type PluginUsersFactory = (
  pluginId: string,
  siteId: string,
  permissions: ReadonlySet<PluginPermission>,
) => PluginUsersApi;
/** Read-only view of the site's configured locales, exposed to plugins as `ctx.i18n`. */
export type PluginI18nProvider = (siteId: string) => {
  defaultLocale(): Promise<string>;
  locales(): Promise<string[]>;
  timeZone(): Promise<string>;
  countries(locale?: string): Promise<Array<{ code: string; name: string }>>;
};
export type PluginSettingsAdapter = {
  get<T = unknown>(siteId: string, pluginId: string, key: string): Promise<T | undefined>;
  set<T = unknown>(siteId: string, pluginId: string, key: string, value: T): Promise<void>;
  delete?(siteId: string, pluginId: string, key: string): Promise<void>;
};

/**
 * Host sink for plugin failures. Every `ctx.logger.error()` call and every
 * exception thrown from a plugin hook handler is forwarded here, so plugin
 * errors reach the core diagnostics without the plugin opting in.
 */
/** Resolve a placeholder for one site. `null` means placeholders are switched off. */
export type PluginPlaceholderResolver = (siteId: string, kind: string) => PlaceholderImage | null;

export type PluginErrorReporter = (pluginId: string, context: string, error: unknown) => void;

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
  probeShared: async () => ({
    ok: false,
    error: "Database probe is not available",
    tls: false,
    latencyMs: 0,
  }),
  probe: async () => ({
    ok: false,
    error: "Database probe is not available",
    tls: false,
    latencyMs: 0,
  }),
  ensureSchema: async () => ({ ok: false, error: "Database schema is not available", tables: [] }),
  dropSchema: async () => ({ ok: false, error: "Database schema is not available", tables: [] }),
  clear: async () => ({ ok: false, error: "Database schema is not available", tables: [] }),
  upsert: async () => undefined,
  findOne: async () => undefined,
  find: async () => [],
  delete: async () => undefined,
  insert: async () => false,
  update: async () => 0,
  increment: async () => 0,
  transaction: async () => {
    throw new Error("Database transactions are not available");
  },
  columns: async () => [],
};

const NULL_QUOTAS: PluginQuotasApi = {
  register: () => () => undefined,
  check: async () => ({ ok: true, limit: null, used: 0, remaining: null }),
  get: async (key) => ({ key, scope: "site", label: key, unit: "count", limit: null, used: null }),
  set: async () => {
    throw new Error("Quotas are not available in this runtime");
  },
};

const NULL_TENANCY: PluginTenancyApi = {
  current: async () => null,
  listWorkspaces: async () => {
    throw new Error("Workspace management is not available in this runtime");
  },
  listSites: async () => {
    throw new Error("Workspace management is not available in this runtime");
  },
  createWorkspace: async () => {
    throw new Error("Workspace management is not available in this runtime");
  },
  addSite: async () => {
    throw new Error("Workspace management is not available in this runtime");
  },
  suspend: async () => {
    throw new Error("Workspace management is not available in this runtime");
  },
  reactivate: async () => {
    throw new Error("Workspace management is not available in this runtime");
  },
  deleteWorkspace: async () => {
    throw new Error("Workspace management is not available in this runtime");
  },
};

const NULL_USERS: PluginUsersApi = {
  create: async () => {
    throw new Error("User creation is not available in this runtime");
  },
};

const filesUnavailable = async (): Promise<never> => {
  throw new Error("Private files are not available in this runtime");
};

const NULL_FILES: PluginFilesApi = {
  put: filesUnavailable,
  get: filesUnavailable,
  read: filesUnavailable,
  delete: filesUnavailable,
  list: filesUnavailable,
};

const NULL_CONTENT: PluginContentApi = {
  getPublished: async () => null,
  listPublished: async () => [],
  ensureType: async () => {
    throw new Error("Content API is not available in this runtime");
  },
  ensurePage: async () => {
    throw new Error("Content API is not available in this runtime");
  },
  deleteType: async () => {
    throw new Error("Content API is not available in this runtime");
  },
  deleteCreatedBy: async () => {
    throw new Error("Content API is not available in this runtime");
  },
};

export class PluginLoader {
  private readonly plugins = new Map<string, LoadedPlugin>();
  private readonly cacheFactory: PluginCacheFactory;
  private readonly dataFactory: PluginDataFactory;
  private readonly jobsFactory: PluginJobsFactory;
  private readonly mailFactory: PluginMailFactory;
  private readonly secretsFactory: PluginSecretsFactory;
  private readonly databasesFactory: PluginDatabasesFactory;
  private readonly tenancyFactory: PluginTenancyFactory;
  private readonly quotasFactory: PluginQuotasFactory;
  private readonly quotasCleanup: ((pluginId: string) => void) | undefined;
  private readonly contentFactory: PluginContentFactory;
  private readonly filesFactory: PluginFilesFactory;
  private readonly usersFactory: PluginUsersFactory;
  private readonly i18nProvider: PluginI18nProvider;
  private readonly jobsCleanup: ((pluginId: string) => void) | undefined;
  private readonly mailCleanup: ((pluginId: string) => void) | undefined;
  private readonly settingsAdapter: PluginSettingsAdapter;
  private readonly blockRegistry: PluginBlockRegistry | undefined;
  private readonly justflowsVersion: string;
  private readonly errorReporter: PluginErrorReporter | undefined;
  private readonly registeredBlocks = new Map<string, string[]>();
  private readonly coreCookiesFn: () => Promise<CookieDeclaration[]>;
  private readonly cookieOverrides: (siteId: string) => Promise<Record<string, CookieCategory>>;
  readonly httpRouter: PluginHttpRouter;
  readonly cookieRegistry: PluginCookieRegistry;
  readonly capabilityRegistry: PluginCapabilityRegistry;
  readonly roleRegistry: PluginRoleRegistry;
  readonly diagnosticRegistry: PluginDiagnosticRegistry;
  readonly patternRegistry: PluginPatternRegistry;
  readonly placeholderRegistry: PluginPlaceholderRegistry;
  private readonly placeholderResolver: PluginPlaceholderResolver;

  constructor(
    private readonly app: App,
    options?: {
      cacheFactory?: PluginCacheFactory;
      dataFactory?: PluginDataFactory;
      jobsFactory?: PluginJobsFactory;
      mailFactory?: PluginMailFactory;
      secretsFactory?: PluginSecretsFactory;
      databasesFactory?: PluginDatabasesFactory;
      tenancyFactory?: PluginTenancyFactory;
      quotasFactory?: PluginQuotasFactory;
      quotasCleanup?: (pluginId: string) => void;
      contentFactory?: PluginContentFactory;
      filesFactory?: PluginFilesFactory;
      usersFactory?: PluginUsersFactory;
      i18nProvider?: PluginI18nProvider;
      jobsCleanup?: (pluginId: string) => void;
      mailCleanup?: (pluginId: string) => void;
      settingsAdapter?: PluginSettingsAdapter;
      httpRouter?: PluginHttpRouter;
      blockRegistry?: PluginBlockRegistry;
      justflowsVersion?: string;
      /** Cookies the host itself sets, seeded into every `ctx.cookies.list()`.
       * A function is re-evaluated per call (the set can depend on live config,
       * e.g. whether a Google Tag is configured). */
      coreCookies?:
        CookieDeclaration[] | (() => CookieDeclaration[] | Promise<CookieDeclaration[]>);
      /** Operator category overrides, keyed by cookie name, per site. */
      cookieOverrides?: (siteId: string) => Promise<Record<string, CookieCategory>>;
      cookieRegistry?: PluginCookieRegistry;
      capabilityRegistry?: PluginCapabilityRegistry;
      roleRegistry?: PluginRoleRegistry;
      diagnosticRegistry?: PluginDiagnosticRegistry;
      patternRegistry?: PluginPatternRegistry;
      placeholderRegistry?: PluginPlaceholderRegistry;
      /** Host resolution (site choice, filter, shipped defaults). Without one,
       * only plugin-registered kinds resolve. */
      placeholderResolver?: PluginPlaceholderResolver;
      errorReporter?: PluginErrorReporter;
    },
  ) {
    this.cacheFactory = options?.cacheFactory ?? (() => NULL_CACHE);
    this.dataFactory = options?.dataFactory ?? (() => NULL_DATA);
    this.jobsFactory = options?.jobsFactory ?? (() => NULL_JOBS);
    this.mailFactory =
      options?.mailFactory ??
      (() => ({
        send: async () => {
          throw new Error("Mail sending is not available in this runtime");
        },
        register: () => {
          throw new Error("Mail transport registration is not available in this runtime");
        },
        registerTemplate: () => {
          throw new Error("Email template registration is not available in this runtime");
        },
      }));
    this.secretsFactory = options?.secretsFactory ?? (() => NULL_SECRETS);
    this.databasesFactory =
      options?.databasesFactory ?? ((_pluginId, _siteId, _permissions) => NULL_DATABASES);
    this.tenancyFactory = options?.tenancyFactory ?? (() => NULL_TENANCY);
    this.quotasFactory = options?.quotasFactory ?? (() => NULL_QUOTAS);
    this.quotasCleanup = options?.quotasCleanup;
    this.contentFactory = options?.contentFactory ?? (() => NULL_CONTENT);
    this.filesFactory = options?.filesFactory ?? (() => NULL_FILES);
    this.usersFactory = options?.usersFactory ?? (() => NULL_USERS);
    this.i18nProvider =
      options?.i18nProvider ??
      (() => ({
        defaultLocale: async () => "en-US",
        locales: async () => ["en-US"],
        timeZone: async () => "UTC",
        countries: async () => [],
      }));
    this.jobsCleanup = options?.jobsCleanup;
    this.mailCleanup = options?.mailCleanup;
    this.settingsAdapter = options?.settingsAdapter ?? {
      get: (siteId, pluginId, key) => this.app.settings.get(siteId, `${pluginId}:${key}`),
      set: (siteId, pluginId, key, value) =>
        this.app.settings.set(siteId, `${pluginId}:${key}`, value),
      delete: (siteId, pluginId, key) => this.app.settings.delete(siteId, `${pluginId}:${key}`),
    };
    this.httpRouter = options?.httpRouter ?? new PluginHttpRouter();
    this.cookieRegistry = options?.cookieRegistry ?? new PluginCookieRegistry();
    this.capabilityRegistry = options?.capabilityRegistry ?? new PluginCapabilityRegistry();
    this.roleRegistry = options?.roleRegistry ?? new PluginRoleRegistry();
    this.diagnosticRegistry = options?.diagnosticRegistry ?? new PluginDiagnosticRegistry();
    this.patternRegistry = options?.patternRegistry ?? new PluginPatternRegistry();
    this.placeholderRegistry = options?.placeholderRegistry ?? new PluginPlaceholderRegistry();
    this.placeholderResolver =
      options?.placeholderResolver ??
      ((_siteId, kind) => {
        const entry = this.placeholderRegistry.get(kind);
        return entry
          ? { kind, src: entry.src, width: entry.width, height: entry.height, source: "plugin" }
          : null;
      });
    const coreCookies = options?.coreCookies ?? [];
    this.coreCookiesFn =
      typeof coreCookies === "function" ? async () => coreCookies() : async () => coreCookies;
    this.cookieOverrides = options?.cookieOverrides ?? (async () => ({}));
    this.blockRegistry = options?.blockRegistry;
    this.justflowsVersion = options?.justflowsVersion ?? "unknown";
    this.errorReporter = options?.errorReporter;
  }

  /** Forward a plugin failure to the host. A broken reporter never breaks the plugin. */
  private reportError(pluginId: string, context: string, error: unknown): void {
    if (!this.errorReporter) return;
    try {
      this.errorReporter(pluginId, context, error);
    } catch {
      // diagnostics are best-effort
    }
  }

  /**
   * Wrap a hook handler so a throw or rejection is reported before the hooks
   * registry sees it. The error is rethrown unchanged, so failure counting and
   * auto-disable keep working. Gate aborts are intentional, not failures.
   */
  private reportingHandler(pluginId: string, hook: string, handler: unknown): unknown {
    if (typeof handler !== "function") return handler;
    const fn = handler as (...args: unknown[]) => unknown;
    const report = (err: unknown): never => {
      if (!(err instanceof Error && err.name === "HookAbortError"))
        this.reportError(pluginId, `hook:${hook}`, err);
      throw err;
    };
    return (...args: unknown[]) => {
      let result: unknown;
      try {
        result = fn(...args);
      } catch (err) {
        report(err);
      }
      return result instanceof Promise ? result.catch(report) : result;
    };
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

    const ctx = this.buildContext(entry.manifest, siteId);
    // Another site may already have loaded the module. The main site still
    // needs `provision` so its tables are created in every site database.
    if (entry.state === "active") {
      await entry.module.provision?.(ctx);
      return;
    }

    try {
      if (entry.manifest.apiNamespace) this.httpRouter.setApiNamespace(pluginId, entry.manifest.apiNamespace);
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
   * Drop a plugin from the in-memory registry so the next `register()` +
   * `activate()` imports a freshly (re)installed build. Node caches an ESM
   * module for the life of the process, so without this a reinstall over the
   * same id kept running the old code until a full restart. The caller is
   * responsible for `deactivate()` first when the plugin may be active; this
   * still force-cleans hooks, routes, cookies, capabilities, jobs, and blocks
   * as a safety net.
   */
  unregister(pluginId: string): void {
    if (!this.plugins.has(pluginId)) return;
    this.cleanupPlugin(pluginId);
    this.plugins.delete(pluginId);
    this.app.logger.info("Plugin unregistered", { pluginId });
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
    this.cookieRegistry.removePlugin(pluginId);
    this.capabilityRegistry.removePlugin(pluginId);
    this.roleRegistry.removePlugin(pluginId);
    this.diagnosticRegistry.removePlugin(pluginId);
    this.patternRegistry.removePlugin(pluginId);
    this.placeholderRegistry.removePlugin(pluginId);
    this.jobsCleanup?.(pluginId);
    this.mailCleanup?.(pluginId);
    this.quotasCleanup?.(pluginId);
    const types = this.registeredBlocks.get(pluginId) ?? [];
    for (const type of types) this.blockRegistry?.unregister(type);
    this.registeredBlocks.delete(pluginId);
  }

  private buildContext(manifest: PluginManifest, siteId: string): PluginContext {
    const pluginId = manifest.id;
    const permissions = new Set(manifest.permissions);
    const baseLogger = this.app.logger.child({ pluginId });
    const logger: PluginContext["logger"] = {
      debug: (message, context) => baseLogger.debug(message, context),
      info: (message, context) => baseLogger.info(message, context),
      warn: (message, context) => baseLogger.warn(message, context),
      error: (message, context) => {
        baseLogger.error(message, context);
        const detail = context?.["error"];
        this.reportError(
          pluginId,
          message,
          detail === undefined ? message : detail instanceof Error ? detail : String(detail),
        );
      },
    };
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
      const wrapped = this.reportingHandler(pluginId, hook, handler);
      if (kind === "filter") {
        return hooks.filter(hook, wrapped as never, opts);
      }
      return hooks.action(hook, wrapped as never, opts);
    };

    return {
      pluginId,
      version: manifest.version,
      runtime: {
        justflows: this.justflowsVersion,
        sdk: SDK_VERSION,
        sdkApi: SDK_API_VERSION,
      },
      permissions,
      capabilities: {
        register: (definition) => this.capabilityRegistry.register(pluginId, definition),
      },
      roles: {
        register: (definition) => this.roleRegistry.register(pluginId, definition),
      },
      users: {
        create: async (input, actor) => {
          if (!permissions.has("users:manage")) {
            throw new Error(
              `Plugin "${pluginId}" cannot create users without the "users:manage" permission`,
            );
          }
          const role = String(input.role ?? "");
          const registered = this.roleRegistry.get(role);
          if (!registered || registered.pluginId !== pluginId) {
            return {
              ok: false,
              status: 400,
              error: "Plugins can only create users in a role they registered.",
            };
          }
          return this.usersFactory(pluginId, siteId, permissions).create(input, actor);
        },
        addRole: async (target, role, actor) => {
          if (!permissions.has("users:manage")) {
            throw new Error(
              `Plugin "${pluginId}" cannot change user roles without the "users:manage" permission`,
            );
          }
          const registered = this.roleRegistry.get(String(role ?? ""));
          if (!registered || registered.pluginId !== pluginId) {
            return {
              ok: false,
              status: 400,
              error: "Plugins can only add a role they registered.",
            };
          }
          const users = this.usersFactory(pluginId, siteId, permissions);
          if (!users.addRole) {
            return { ok: false, status: 501, error: "Adding roles is not available in this runtime." };
          }
          return users.addRole(target, role, actor);
        },
        removeRole: async (target, role, actor) => {
          if (!permissions.has("users:manage")) {
            throw new Error(
              `Plugin "${pluginId}" cannot change user roles without the "users:manage" permission`,
            );
          }
          const registered = this.roleRegistry.get(String(role ?? ""));
          if (!registered || registered.pluginId !== pluginId) {
            return {
              ok: false,
              status: 400,
              error: "Plugins can only remove a role they registered.",
            };
          }
          const users = this.usersFactory(pluginId, siteId, permissions);
          if (!users.removeRole) {
            return { ok: false, status: 501, error: "Removing roles is not available in this runtime." };
          }
          return users.removeRole(target, role, actor);
        },
        get: async (userId) => {
          if (!permissions.has("users:manage")) {
            throw new Error(`Plugin "${pluginId}" cannot read users without the "users:manage" permission`);
          }
          const users = this.usersFactory(pluginId, siteId, permissions);
          return users.get ? users.get(userId) : null;
        },
      },
      diagnostics: {
        register: (check) => {
          if (!permissions.has("diagnostics:publish"))
            throw new Error(
              `Plugin "${pluginId}" cannot publish diagnostics without the "diagnostics:publish" permission`,
            );
          return this.diagnosticRegistry.register(pluginId, check);
        },
      },
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
        url: (path = "") => this.httpRouter.url(pluginId, path),
        get: (path, handler, options) => this.httpRouter.register(pluginId, "GET", path, handler, options),
        post: (path, handler, options) => this.httpRouter.register(pluginId, "POST", path, handler, options),
        put: (path, handler, options) => this.httpRouter.register(pluginId, "PUT", path, handler, options),
        patch: (path, handler, options) => this.httpRouter.register(pluginId, "PATCH", path, handler, options),
        delete: (path, handler, options) => this.httpRouter.register(pluginId, "DELETE", path, handler, options),
      },
      jobs: this.scopedJobs(pluginId, permissions),
      mail: this.mailFactory(pluginId, permissions),
      data,
      secrets: this.secretsFactory(pluginId, siteId),
      databases: this.databasesFactory(pluginId, siteId, permissions),
      tenancy: this.tenancyFactory(pluginId, permissions),
      quotas: this.quotasFactory(pluginId, permissions, siteId),
      files: this.scopedFiles(pluginId, siteId, permissions),
      cookies: {
        declare: (cookie) => this.cookieRegistry.declare(pluginId, cookie),
        list: async () =>
          resolveCookies(
            [
              ...(await this.coreCookiesFn()).map((c) => ({ ...c, declaredBy: "core" })),
              ...this.cookieRegistry.all(),
            ],
            await this.cookieOverrides(siteId),
          ),
      },
      content: this.scopedContent(pluginId, siteId, permissions),
      i18n: this.i18nProvider(siteId),
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
      patterns: {
        register: (pattern) => this.patternRegistry.register(pluginId, pattern),
      },
      media: {
        placeholder: (kind) => this.placeholderResolver(siteId, kind),
        placeholderHtml: (kind, options) => {
          const image = this.placeholderResolver(siteId, kind);
          return image ? placeholderImgHtml(image, options) : "";
        },
        registerPlaceholder: (kind, definition) =>
          this.placeholderRegistry.register(pluginId, kind, definition),
      },
      logger,
    };
  }

  private scopedFiles(pluginId: string, siteId: string, permissions: Set<PluginPermission>): PluginFilesApi {
    const inner = this.filesFactory(pluginId, siteId);
    const allowed = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => (...args: A): Promise<R> => {
      if (!permissions.has("files:private")) {
        return Promise.reject(
          new Error(`Plugin "${pluginId}" cannot use private files without the "files:private" permission. Add it to the plugin manifest.`),
        );
      }
      return fn(...args);
    };
    return {
      put: allowed((key: string, data: Buffer, options?: { contentType?: string }) => inner.put(key, data, options)),
      get: allowed((key: string) => inner.get(key)),
      read: allowed((key: string) => inner.read(key)),
      delete: allowed((key: string) => inner.delete(key)),
      list: allowed((prefix?: string) => inner.list(prefix)),
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
    const assertRead = (): void => {
      if (permissions.has("content:read")) return;
      throw new Error(
        `Plugin "${pluginId}" cannot read content without the "content:read" permission. Add it to the plugin manifest.`,
      );
    };
    const getPublished = inner.getPublished?.bind(inner);
    return {
      listPublished: (query) => {
        assertRead();
        return inner.listPublished(query);
      },
      ...(getPublished
        ? {
            getPublished: (query: Parameters<NonNullable<PluginContentApi["getPublished"]>>[0]) => {
              assertRead();
              return getPublished(query);
            },
          }
        : {}),
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
      deleteCreatedBy: (userId) => {
        assertDelete();
        return inner.deleteCreatedBy(userId);
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
