import { render } from "../helpers/render";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import InstallPage from "../../src/pages/InstallPage";

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}

describe("InstallPage", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("/api/bootstrap/status")) return jsonResponse({ ready: true });
        if (path.includes("/api/install/status")) {
          return jsonResponse({ tokenRequired: false, tokenFile: null });
        }
        return jsonResponse({});
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function reachSiteStep(): Promise<void> {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <InstallPage />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole("button", { name: /let's go/i }));
    await user.type(screen.getByLabelText("Database username"), "db_user");
    await user.click(screen.getByRole("button", { name: /next/i }));
    expect(await screen.findByRole("heading", { name: "Your site" })).toBeInTheDocument();
  }

  it("lets the installer choose the default site language", async () => {
    const user = userEvent.setup();
    await reachSiteStep();

    const language = screen.getByLabelText("Default site language");
    expect(language).toHaveValue("en-US");
    await user.selectOptions(language, "nl-NL");
    expect(language).toHaveValue("nl-NL");
  });

  it("offers to email site details and credentials on the account step", async () => {
    const user = userEvent.setup();
    await reachSiteStep();

    await user.type(screen.getByLabelText("Site name"), "Acme");
    await user.click(screen.getByRole("button", { name: /next/i }));

    expect(await screen.findByRole("heading", { name: "Admin account" })).toBeInTheDocument();
    const emailDetails = screen.getByRole("checkbox", {
      name: /email the full site details and admin credentials/i,
    });
    expect(emailDetails).toBeChecked();
  });

  it("posts the chosen locale and the email-details flag", async () => {
    const user = userEvent.setup();
    const encoder = new TextEncoder();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.includes("/api/bootstrap/status")) return jsonResponse({ ready: true });
      if (path.includes("/api/install/status")) {
        return jsonResponse({ tokenRequired: false, tokenFile: null });
      }
      if (path.includes("/api/install/complete")) return jsonResponse({ ok: true });
      if (path.includes("/api/install") && init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: (name: string) => (name === "content-type" ? "text/event-stream" : null) },
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode('data: {"type":"done","message":"ok"}\n\n'));
              controller.close();
            },
          }),
        } as Response);
      }
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter>
        <InstallPage />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole("button", { name: /let's go/i }));
    await user.type(screen.getByLabelText("Database username"), "db_user");
    await user.click(screen.getByRole("button", { name: /next/i }));
    await user.type(screen.getByLabelText("Site name"), "Acme");
    await user.selectOptions(screen.getByLabelText("Default site language"), "nl-NL");
    await user.click(screen.getByRole("button", { name: /next/i }));

    await user.type(screen.getByLabelText("Your email"), "admin@example.com");
    await user.type(screen.getByLabelText("Display name"), "Site Admin");
    await user.type(screen.getByLabelText("Password"), "super-secret-password");
    await user.type(screen.getByLabelText("Confirm password"), "super-secret-password");
    await user.click(screen.getByRole("button", { name: /install justflows/i }));

    await screen.findByRole("heading", { name: /is ready/i });

    const installCall = fetchMock.mock.calls.find(
      ([url, init]) => String(url).includes("/api/install") && (init as RequestInit | undefined)?.method === "POST",
    );
    expect(installCall).toBeTruthy();
    const payload = JSON.parse(String((installCall?.[1] as RequestInit).body));
    expect(payload.site.locale).toBe("nl-NL");
    expect(payload.account.emailDetails).toBe(true);
  });

  describe("when the host provisioned the database", () => {
    function stubProvisioned(onInstall?: (init: RequestInit) => void) {
      const encoder = new TextEncoder();
      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
          const path = String(input);
          if (path.includes("/api/bootstrap/status")) return jsonResponse({ ready: true });
          if (path.includes("/api/install/status")) {
            return jsonResponse({ tokenRequired: false, tokenFile: null, databaseProvisioned: true, databaseDriver: "mariadb" });
          }
          if (path.includes("/api/install/complete")) return jsonResponse({ ok: true });
          if (path.includes("/api/install") && init?.method === "POST") {
            onInstall?.(init);
            return Promise.resolve({
              ok: true,
              status: 200,
              headers: { get: (name: string) => (name === "content-type" ? "text/event-stream" : null) },
              body: new ReadableStream({
                start(controller) {
                  controller.enqueue(encoder.encode('data: {"type":"done","message":"ok"}\n\n'));
                  controller.close();
                },
              }),
            } as Response);
          }
          return jsonResponse({});
        }),
      );
    }

    it("skips the database step and never sends database details", async () => {
      let body: { db?: unknown } | null = null;
      stubProvisioned((init) => {
        body = JSON.parse(String(init.body));
      });
      const user = userEvent.setup();
      render(
        <MemoryRouter>
          <InstallPage />
        </MemoryRouter>,
      );

      expect(await screen.findByText(/already set up a MariaDB database/i)).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: /let's go/i }));
      expect(await screen.findByRole("heading", { name: "Your site" })).toBeInTheDocument();
      expect(screen.queryByLabelText("Database username")).not.toBeInTheDocument();

      await user.type(screen.getByLabelText("Site name"), "Acme");
      await user.click(screen.getByRole("button", { name: /next/i }));
      await user.type(screen.getByLabelText("Your email"), "admin@example.com");
      await user.type(screen.getByLabelText("Display name"), "Site Admin");
      await user.type(screen.getByLabelText("Password"), "super-secret-password");
      await user.type(screen.getByLabelText("Confirm password"), "super-secret-password");
      await user.click(screen.getByRole("button", { name: /install justflows/i }));
      await screen.findByRole("heading", { name: /is ready/i });

      expect(body).not.toBeNull();
      expect(body!.db).toBeUndefined();
    });

    it("lets the installer use a different database instead", async () => {
      stubProvisioned();
      const user = userEvent.setup();
      render(
        <MemoryRouter>
          <InstallPage />
        </MemoryRouter>,
      );

      await user.click(await screen.findByRole("button", { name: /use a different database/i }));
      expect(await screen.findByLabelText("Database username")).toBeInTheDocument();
    });
  });
  describe("when a hosting panel installed the site", () => {
    function stubHost(installHost: string | null) {
      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL) => {
          const path = String(input);
          if (path.includes("/api/bootstrap/status")) return jsonResponse({ ready: true });
          if (path.includes("/api/install/status")) {
            return jsonResponse({ tokenRequired: true, tokenFile: "install-token/TOKEN.txt", databaseProvisioned: false, installHost });
          }
          return jsonResponse({});
        }),
      );
    }

    async function reachAccountStep(): Promise<void> {
      const user = userEvent.setup();
      render(
        <MemoryRouter>
          <InstallPage />
        </MemoryRouter>,
      );
      await user.click(await screen.findByRole("button", { name: /let's go/i }));
      await user.type(screen.getByLabelText("Database username"), "db_user");
      await user.click(screen.getByRole("button", { name: /next/i }));
      await user.type(screen.getByLabelText("Site name"), "Acme");
      await user.click(screen.getByRole("button", { name: /next/i }));
      expect(await screen.findByRole("heading", { name: "Admin account" })).toBeInTheDocument();
    }

    afterEach(() => {
      window.history.replaceState(null, "", "/");
    });

    it("fills in the key the panel passed and removes it from the address bar", async () => {
      window.history.replaceState(null, "", "/install#setup-key=TkdsRs_P7cf3pomDXRZEjNG_-Ou05ADn");
      stubHost("plesk");
      await reachAccountStep();

      expect(window.location.hash).toBe("");
      expect(screen.getByLabelText("Setup key")).toHaveValue("TkdsRs_P7cf3pomDXRZEjNG_-Ou05ADn");
      expect(screen.getByText("Setup key filled in from Plesk.")).toBeInTheDocument();
    });

    it("says where the panel shows the key and keeps the file steps as a fallback", async () => {
      stubHost("plesk");
      await reachAccountStep();

      expect(screen.getByText("Your setup key is in Plesk")).toBeInTheDocument();
      expect(screen.getByText(/can't find it\?/i)).toBeInTheDocument();
      expect(screen.getByLabelText("Setup key")).toHaveValue("");
    });

    it("ignores a key in the link when no known panel installed the site", async () => {
      window.history.replaceState(null, "", "/install#setup-key=TkdsRs_P7cf3pomDXRZEjNG_-Ou05ADn");
      stubHost(null);
      await reachAccountStep();

      expect(window.location.hash).toBe("");
      expect(screen.getByLabelText("Setup key")).toHaveValue("");
      expect(screen.getByText("Where to find your setup key")).toBeInTheDocument();
    });
  });
});
