// SPDX-License-Identifier: MIT

(() => {
  type Site = { id: string; name: string; status: string; url: string | null };
  type Workspace = { id: string; name: string; status: string; userMode: string; sites: Site[] };

  type Meter = { key: string; label: string; unit: string; limit: number | null; used: number | null };
  const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", cls = "") => {
    const node = document.createElement(tag); node.textContent = text; node.className = cls; return node;
  };
  const notice = (text: string) => { const message = get("account-message"); if (message) message.textContent = text; };
  const selector = get<HTMLSelectElement>("workspace-select");
  const resourceSelector = get<HTMLSelectElement>("resource-select");
  let workspaces: Workspace[] = [];
  let domain: string | null = null;
  let resourceRequest = 0;
  const current = () => workspaces.find((workspace) => workspace.id === selector.value);
  const workspaceUrl = () => `/api/account/workspaces/${encodeURIComponent(current()!.id)}`;

  async function request<T>(url: string, method = "GET", body?: object): Promise<T> {
    const csrf = document.cookie.split("; ").find((cookie) => cookie.startsWith("jf_csrf="))?.slice(8) ?? "";
    const res = await fetch(url, { method, credentials: "same-origin", headers: { "content-type": "application/json", "x-csrf-token": decodeURIComponent(csrf) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (res.status === 401) { window.location.assign("/login"); throw new Error("Please sign in again."); }
    let data: T & { error?: string };
    try { data = await res.json(); } catch { throw new Error("The request could not be completed. Please try again."); }
    if (!res.ok) throw new Error(data.error || "The request could not be completed.");
    return data;
  }
  async function saving(form: HTMLFormElement, action: () => Promise<void>) {
    const buttons = Array.from(form.querySelectorAll<HTMLButtonElement>("button"));
    buttons.forEach((button) => { button.disabled = true; });
    notice("");
    try { await action(); } catch (error) { notice(error instanceof Error ? error.message : "Please try again."); }
    finally { buttons.forEach((button) => { button.disabled = false; }); }
  }
  function renderSites(workspace: Workspace) {
    const host = get("site-list"); host.replaceChildren();
    if (!workspace.sites.length) host.append(make("p", "No sites in this workspace yet.", "muted"));
    for (const site of workspace.sites) {
      const row = make("article", "", "site-row"); const details = make("div");
      details.append(make("h3", site.name), make("p", site.url || "No site address", "muted"), make("span", site.status, "badge"));
      const actions = make("div", "", "site-actions");
      if (site.url && site.status === "active") {
        for (const [suffix, label] of [["", "Visit site ↗"], ["/admin", "Open administration ↗"]]) {
          const link = make("a", suffix ? "Site sign-in ↗" : label); link.href = site.url + (suffix ? "/login" : ""); link.target = "_blank"; link.rel = "noopener noreferrer"; actions.append(link);
        }
      }
      const rename = make("button", "Rename", "secondary"); rename.type = "button";
      const form = make("form"); form.hidden = true;
      const input = make("input"); input.name = "name"; input.value = site.name; input.required = true; input.maxLength = 255; input.setAttribute("aria-label", "Site name");
      const save = make("button", "Save"); save.type = "submit";
      const cancel = make("button", "Cancel", "secondary"); cancel.type = "button"; cancel.onclick = () => { form.hidden = true; rename.hidden = false; };
      form.append(input, save, cancel); rename.onclick = () => { form.hidden = false; rename.hidden = true; input.focus(); };
      form.onsubmit = (event) => { event.preventDefault(); void saving(form, async () => { await request(`${workspaceUrl()}/sites/${encodeURIComponent(site.id)}`, "PATCH", { name: input.value }); await loadAccount(); notice("Site name saved."); }); };
      actions.append(rename); details.append(form); row.append(details, actions); host.append(row);
    }
  }
  async function loadResources() {
    const serial = ++resourceRequest;
    const host = get("resource-list"); host.replaceChildren(make("p", "Loading resources…", "muted"));
    if (!current()) return;
    const selected = resourceSelector.value;
    const path = selected === "workspace" ? `${workspaceUrl()}/limits` : `${workspaceUrl()}/sites/${encodeURIComponent(selected)}/limits`;
    try {
      const data = await request<{ meters: Meter[] }>(path);
      if (serial !== resourceRequest) return;
      host.replaceChildren(); const grid = make("div", "", "resource-grid");
      for (const meter of data.meters) {
        const card = make("div", "", "resource-card");
        const format = (n: number) => meter.unit === "bytes" ? `${(n / 1024 / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB` : n.toLocaleString();
        const value = meter.unit === "flag" ? (meter.limit === 0 ? "Not included" : "Included") : `${meter.used === null ? "Usage unavailable" : format(meter.used)} / ${meter.limit === null ? "Unlimited" : format(meter.limit)}`;
        card.append(make("p", meter.label), make("strong", value)); grid.append(card);
      }
      host.append(grid);
    } catch (error) { if (serial === resourceRequest) host.replaceChildren(make("p", error instanceof Error ? error.message : "Resources unavailable.", "muted")); }
  }
  function renderWorkspace(loadMeters = true) {
    const workspace = current(); if (!workspace) return;
    get("workspace-status").textContent = workspace.status;
    get<HTMLInputElement>("workspace-name").value = workspace.name;
    get("workspace-id").textContent = workspace.id;
    get<HTMLButtonElement>("show-new-site").disabled = workspace.status !== "active" || !domain;
    get<HTMLFormElement>("new-site-form").hidden = true;
    get("site-domain").textContent = domain ? `.${domain}` : "";
    renderSites(workspace);
    resourceSelector.replaceChildren(new Option("Workspace", "workspace"), ...workspace.sites.map((site) => new Option(site.name, site.id)));
    if (loadMeters) void loadResources();
  }
  async function loadAccount() {
    const previous = selector.value;
    const data = await request<{ workspaces: Workspace[]; siteDomain: string | null }>("/api/account/workspaces");
    workspaces = data.workspaces; domain = data.siteDomain;
    selector.replaceChildren(...workspaces.map((workspace) => new Option(workspace.name, workspace.id)));
    if (workspaces.some((workspace) => workspace.id === previous)) selector.value = previous;
    get("account-content").hidden = !workspaces.length;
    if (workspaces.length) renderWorkspace();
  }
  if (selector) {
    selector.onchange = () => renderWorkspace();
    resourceSelector.onchange = () => void loadResources();
    const nameForm = get<HTMLFormElement>("workspace-name-form");
    nameForm.onsubmit = (event) => { event.preventDefault(); void saving(nameForm, async () => { await request(workspaceUrl(), "PATCH", { name: get<HTMLInputElement>("workspace-name").value }); await loadAccount(); notice("Workspace name saved."); }); };
    const siteForm = get<HTMLFormElement>("new-site-form");
    get("show-new-site").onclick = () => { siteForm.hidden = false; siteForm.querySelector("input")?.focus(); };
    get("cancel-new-site").onclick = () => { siteForm.hidden = true; siteForm.reset(); };
    siteForm.onsubmit = (event) => { event.preventDefault(); void saving(siteForm, async () => { const fields = new FormData(siteForm); await request(`${workspaceUrl()}/sites`, "POST", { name: fields.get("name"), address: fields.get("address"), password: fields.get("password") }); siteForm.reset(); await loadAccount(); notice("Your new site is ready."); }); };
  }
  const signOut = get<HTMLButtonElement>("sign-out");
  if (signOut) signOut.onclick = async () => { try { await request("/api/auth/logout", "POST", {}); window.location.assign("/login"); } catch (error) { notice(error instanceof Error ? error.message : "Could not sign out."); } };
  const initial = JSON.parse(get("initial-account").textContent || "{}") as { workspaces: Workspace[]; siteDomain: string | null };
  workspaces = initial.workspaces; domain = initial.siteDomain;
  if (workspaces.length && selector) renderWorkspace(false);
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-account-action]")) {
    button.onclick = async () => {
      if (button.dataset.confirm && !window.confirm(button.dataset.confirm)) return;
      button.disabled = true;
      try { await request(button.dataset.accountAction!, "POST", {}); window.location.reload(); }
      catch (error) { notice(error instanceof Error ? error.message : "Could not update your account."); button.disabled = false; }
    };
  }
})();
