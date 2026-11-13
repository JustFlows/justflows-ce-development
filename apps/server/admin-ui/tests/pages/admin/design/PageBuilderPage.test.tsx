import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../../src/i18n/I18nProvider";
import PageBuilderPage from "../../../../src/pages/admin/design/PageBuilderPage";
import { recoveryKey, writeRecovery } from "../../../../src/lib/builder-recovery";

/**
 * Autosave, local recovery, and conflict handling on the page builder route
 * (justflows-ce#302). Edits are introduced through the recovery banner's
 * Restore action, which goes through the same update path as canvas edits.
 */

const live = {
  id: "p1",
  type: "page",
  title: "About",
  slug: "about",
  status: "published",
  version: 4,
  hasWorkingRevision: true,
  workingRevision: { version: 2 },
  blocks: { version: 1, blocks: [] },
  fields: {},
};

type Handler = (init?: RequestInit) => { status: number; body: unknown };
let patchHandler: Handler;
let calls: Array<{ url: string; init?: RequestInit }>;

function respond(status: number, body: unknown): Promise<Response> {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body } as Response);
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  calls = [];
  patchHandler = () => ({ status: 200, body: { ...live, workingRevision: { version: 3 } } });
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === "/api/content/p1" && init?.method === "PATCH") {
        const r = patchHandler(init);
        return respond(r.status, r.body);
      }
      if (url === "/api/content/p1") return respond(200, live);
      if (url.includes("/api/blocks")) return respond(200, { blocks: [] });
      return respond(200, {});
    }),
  );
  writeRecovery(recoveryKey(null, "p1"), { title: "About (mine)", blocks: live.blocks, fields: {} }, 4);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/admin/content/p1/builder"]}>
      <I18nProvider>
        <Routes>
          <Route path="/admin/content/:id/builder" element={<PageBuilderPage />} />
        </Routes>
      </I18nProvider>
    </MemoryRouter>,
  );
}

const patches = () => calls.filter((c) => c.init?.method === "PATCH").map((c) => JSON.parse(String(c.init!.body)));

describe("PageBuilderPage saving", () => {
  it("offers back unsaved changes this browser kept", async () => {
    renderPage();
    expect(await screen.findByText(/This browser kept unsaved changes/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore them" })).toBeInTheDocument();
  });

  it("does not offer a recovery copy that matches the server", async () => {
    writeRecovery(recoveryKey(null, "p1"), { title: "About", blocks: live.blocks, fields: {} }, 4);
    renderPage();
    expect(await screen.findByRole("heading", { level: 1, name: "About" })).toBeInTheDocument();
    expect(screen.queryByText(/This browser kept unsaved changes/)).not.toBeInTheDocument();
  });

  it("autosaves a restored edit as a draft with both versions, never publishing", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Restore them" }));
    expect(screen.getByRole("status")).toHaveTextContent("Unsaved changes");
    expect(patches()).toHaveLength(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4100);
    });
    expect(patches()).toEqual([
      expect.objectContaining({ title: "About (mine)", source: "autosave", expectedVersion: 4, expectedWorkingVersion: 2 }),
    ]);
    expect(calls.some((c) => c.url.endsWith("/publish"))).toBe(false);
    expect(await screen.findByText(/Saved/)).toBeInTheDocument();
    expect(localStorage.getItem(recoveryKey(null, "p1"))).toBeNull();
  });

  it("stops on a draft conflict, keeps the edits, and offers to load the latest version", async () => {
    patchHandler = () => ({ status: 409, body: { code: "draft_conflict", updatedByName: "Ada" } });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Restore them" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4100);
    });

    expect(await screen.findByText(/Ada changed this page's draft/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Not saved");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    /** No more autosaves while the conflict is open. */
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(patches()).toHaveLength(1);

    /** Loading theirs keeps mine as a recovery copy, offered straight back. */
    await user.click(screen.getByRole("button", { name: "Load the latest version" }));
    expect(await screen.findByText(/This browser kept unsaved changes/)).toBeInTheDocument();
  });

  it("only overwrites a newer version after explicit confirmation", async () => {
    let conflictOnce = true;
    patchHandler = () => {
      if (conflictOnce) {
        conflictOnce = false;
        return { status: 409, body: { code: "version_conflict" } };
      }
      return { status: 200, body: { ...live, version: 5, workingRevision: { version: 4 } } };
    };
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Restore them" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4100);
    });
    await user.click(await screen.findByRole("button", { name: "Save mine over it" }));
    expect(confirm).toHaveBeenCalled();
    await vi.waitFor(() => expect(patches()).toHaveLength(2));
    expect(patches()[1]).toMatchObject({ source: "manual", title: "About (mine)" });
  });

  it("shows a failed autosave and tries again later", async () => {
    let fail = true;
    patchHandler = () => (fail ? { status: 500, body: { error: "Database unavailable" } } : { status: 200, body: live });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Restore them" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4100);
    });
    expect(await screen.findByText("Database unavailable")).toBeInTheDocument();
    fail = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15100);
    });
    expect(patches()).toHaveLength(2);
  });
});
