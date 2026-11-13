import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { currentPathname, isPreAuthPath } from "../admin-path";
import { initialJson } from "../ssr-data";

export interface SessionInfo {
  id: string;
  email: string;
  role: string;
  roleId?: string;
  capabilities?: string[];
  /** True for the installation's first site. */
  installationRoot?: boolean;
  /** Admin paths hidden because this website turned a feature off. */
  disabledPaths?: string[];
  /** Feature keys stored as off, so a control inside a page can be removed. */
  disabledFeatures?: string[];
  /** The role must use a passkey and this account has none yet. */
  passkeyEnrollmentRequired?: boolean;
}

interface SessionValue {
  /** Null before session/:me resolves, or when there is no session at all
   *  (pre-login pages, or the request failed). */
  session: SessionInfo | null;
  loading: boolean;
}

const SessionContext = createContext<SessionValue | null>(null);

function isSessionInfo(raw: unknown): raw is SessionInfo {
  if (!raw || typeof raw !== "object") return false;
  const value = raw as Record<string, unknown>;
  return typeof value.id === "string" && typeof value.email === "string" && typeof value.role === "string";
}

/**
 * The signed-in account's identity and role, for the admin UI to decide what
 * to show — not a security control. Every route this informs still enforces
 * its own role check on the server regardless of what the client renders.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  // /login, /install, etc. never have a session and the server never embeds
  // SSR data on them — skip the request outright rather than let it 401.
  const skipFetch = isPreAuthPath(currentPathname());
  const initial = initialJson<unknown>("/api/auth/me");
  const initialSession = isSessionInfo(initial) ? initial : null;
  const [session, setSession] = useState<SessionInfo | null>(initialSession);
  const [loading, setLoading] = useState(!skipFetch && initial === undefined);

  useEffect(() => {
    if (skipFetch) return;
    fetch("/api/auth/me")
      .then(async (res) => (res.ok ? ((await res.json()) as unknown) : null))
      .then((data) => setSession(isSessionInfo(data) ? data : null))
      .catch(() => setSession(null))
      .finally(() => setLoading(false));
  }, [skipFetch]);

  return <SessionContext.Provider value={{ session, loading }}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within SessionProvider");
  return ctx;
}

/**
 * The signed-in user's id, or null. Unlike `useSession` it does not require a
 * provider, so components that also render in isolation (builders embedded in
 * other screens, tests) can use it for per-user preferences.
 */
export function useOptionalSessionUserId(): string | null {
  return useContext(SessionContext)?.session?.id ?? null;
}

/** Convenience for the common case of just needing the role. */
export function useSessionRole(): string | null {
  return useSession().session?.role ?? null;
}

/** True unless this website stored the feature as off. Missing session data stays allowed. */
export function useFeatureEnabled(key: string): boolean {
  const features = useSession().session?.disabledFeatures;
  if (!features) return true;
  return !features.includes(key);
}

export function useCapability(capability: string): boolean {
  const session = useSession().session;
  if (!session) return false;
  if (session.capabilities) return session.capabilities.includes(capability);
  // Compatibility with cached SSR data and older hosts during rolling updates.
  return session.role === "administrator";
}
