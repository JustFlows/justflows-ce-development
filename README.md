# Justflows

> **This repository is for development.** Open pull requests into `develop`.
> Releases are published to [`JustFlows/justflows-ce`](https://github.com/JustFlows/justflows-ce).

**The open-source platform for building the web.**

Justflows is a self-hostable website and content platform. A non-technical user
installs it through the browser — no terminal, no npm, no compilation. A
TypeScript developer gets a stable, typed SDK and plugin API.

**Requirements:** Node.js 22 or later on the host (Plesk / cPanel / VPS). Docker
installs include Node for you. Developers also need pnpm 11+ and PostgreSQL,
MySQL 8+, or MariaDB 10.6+.

---

## How to install

There are three paths depending on your situation.

---

### Option A — Docker (easiest, recommended for most people)

**What you need:** [Docker Desktop](https://www.docker.com/products/docker-desktop/)
installed on your computer or server. That's it.

**Steps:**

1. Get the project files:
   - [Download the latest release](https://github.com/JustFlows/justflows-ce/releases/latest), or
   - Clone this repository
2. Unzip or open the project folder
3. Copy `.env.production.example` to `.env` and open it in any text editor
4. Set your domain (`APP_URL`), a secret key (`APP_SECRET`, 32+ characters), and
   `DB_PASSWORD`
5. Open a terminal in that folder and run:

```
docker compose -f docker/docker-compose.yml --env-file .env up
```

6. Open **http://localhost:3000** in your browser
7. The site wizard walks you through database confirmation, site name, and your
   admin account. On a machine that is not localhost you will also paste the
   setup key from `install-token/TOKEN.txt` (see below).

> **No terminal after step 5.** Docker already has the app files. Everything
> from the wizard onwards is done in the browser, exactly like WordPress.

**On a VPS / server:** same steps, just run `docker compose up -d` (the `-d`
keeps it running in the background), then open your domain.

---

### Option B — Shared hosting / Plesk / cPanel (no terminal)

If your host provides Node.js (Plesk, cPanel, Hostinger, SiteGround, A2 Hosting,
and similar):

1. [Download the latest release](https://github.com/JustFlows/justflows-ce/releases/latest)
   and unzip it (or upload `justflows.zip`)
2. Upload the folder to your application root via File Manager or FTP
3. In **Node.js** settings, create an application pointing at that folder
4. Set **Application startup file** to `server.js` (production mode) and click
   **Restart App**
5. Open **your domain** in a browser — not `/install` yet

The first page (`index.html`) installs Justflows in the browser. Click
**Install Justflows** and keep the tab open. That installs production runtime
dependencies (a few minutes); official release archives already contain the
compiled server, public views, admin client, and admin SSR bundle. When it
finishes, the **site wizard** opens.

In the wizard you enter:

1. Database type, host, name, username, and password
2. Site name
3. Admin email, username, and password (12+ characters)

On the last step you paste a **setup key**. Open File Manager or FTP, go to
`install-token/TOKEN.txt` in the application root, and copy the key. Justflows
writes that file when Node starts; the folder is deleted after setup finishes.
Do not skip this on a public host.

The database is written only when you click **Install Justflows** on that last
step. After the site is installed, `index.html` is removed automatically.

You do not need a terminal, npm, a command line, or a frontend build step.

**If the first page says Node.js is not running:** set the startup file to
`server.js`, click Restart App, and refresh.

**Advanced (optional terminal):** `npm run setup` or `npm run install:all`
still work if you prefer the command line. Git checkouts cannot use the browser
installer — use Option C.

---

### Option C — Developers (full source)

A git checkout does **not** run the first-run `index.html` installer. Use pnpm
and open `/install` yourself.

```bash
# Prerequisites: Node.js ≥ 22, pnpm ≥ 11, PostgreSQL/MySQL/MariaDB

git clone https://github.com/JustFlows/justflows-ce
cd justflows-ce
pnpm install
cp .env.example .env
# Edit .env: set DATABASE_DRIVER, DATABASE_URL, APP_URL, APP_SECRET
pnpm --filter @justflows/server dev
# → open http://localhost:3000/install
```

Localhost is exempt from the setup key. On a remote URL, copy
`install-token/TOKEN.txt` as in Option B.

---

### Setup key (`install-token/TOKEN.txt`)

Until setup completes, whoever reaches the site first could claim it. Justflows
writes a one-time key to `install-token/TOKEN.txt` (and prints it in the server
log) as soon as Node starts. You are asked for it twice, at each point where an
anonymous visitor could otherwise act:

- On the browser first-run page, before it installs runtime dependencies and
  prepares the prebuilt application
- In the wizard, on the admin-account step

Requests from localhost skip both, so `pnpm dev` needs no key.

- Open it with the same File Manager or FTP app you used to upload Justflows
- The folder includes an Apache deny rule; Node never serves it
- Confirm your host does not publish that folder over HTTP
- It is deleted automatically when setup finishes

---

## Choosing a database

Justflows works with any of these — you do not need to know SQL:

| Database                   | When to use it                                                  |
| -------------------------- | --------------------------------------------------------------- |
| **PostgreSQL** _(default)_ | Best choice for new installs. Included automatically in Docker. |
| **MySQL 8+**               | Use this if your host already provides MySQL                    |
| **MariaDB 10.6+**          | Use this if your host already provides MariaDB                  |

When using Docker you do not need to install or configure a database yourself —
it is set up automatically.

To use MySQL or MariaDB with Docker:

```bash
# MySQL
docker compose -f docker/docker-compose.mysql.yml --env-file .env up

# MariaDB
docker compose -f docker/docker-compose.mariadb.yml --env-file .env up
```

The shared-hosting wizard lets you pick the same three drivers and uses the
database your host already gave you.

---

## Installing plugins and themes

Once your site is running, open Admin → **Plugins** or **Themes**. Download a
`.jfpkg` and drop it on the upload area — exactly like WordPress. No terminal,
no npm.

Since 0.1.2 a package is refused unless it carries a valid marketplace
signature or you pin its SHA-256 digest in `JUSTFLOWS_TRUSTED_PACKAGE_DIGESTS`.
For local development only, `JUSTFLOWS_ALLOW_UNSIGNED_PACKAGES=1` restores the
old behaviour. Do not set that on a public host.

---

## What you can do

| Feature                                                  | Where                                       |
| -------------------------------------------------------- | ------------------------------------------- |
| Search published content | `/search` or the Search block — [guide](docs/SEARCH.md) |
| Configure and rebuild search | Admin → Tools → Site search |
| Write posts and pages                                    | Admin → Content                             |
| Build pages and post bodies with blocks                  | Admin → Content → Open page builder         |
| Choose or create a paginated blog index                  | Admin → Theme builder → Blog                |
| Upload images and files                                  | Admin → Media                               |
| Install plugins                                          | Admin → Plugins → Upload .jfpkg             |
| Change your theme                                        | Admin → Themes → Upload .jfpkg → Activate   |
| Customize the home page, blog, footer, and design tokens | Admin → Theme builder                       |
| Manage users                                             | Admin → Users                               |
| Update everything                                        | Admin → Updates                             |
| Change site settings                                     | Admin → Settings                            |
| Send content events to another service                   | Admin → Webhooks                            |
| Export the public site to static files for a CDN         | Admin → System → Tools → Static site export |

---

## Project structure (for developers)

```
justflows/
├── index.html          First-run page on unzipped releases (removed after install)
├── server.js           Plesk / cPanel / production entry
├── apps/
│   └── server/         Unified Express app (API + SSR admin + public site)
│       ├── src/        Express server, routes, lib, EJS views
│       └── admin-ui/   Vite + React SSR admin dashboard and hydration client
├── packages/
│   ├── core/           App lifecycle, hooks, config, logging, health
│   ├── database/       SQL schema + PostgreSQL/MySQL/MariaDB client
│   ├── sdk/            Stable public API for plugin/theme developers
│   ├── auth/           Password hashing, sessions, capabilities
│   ├── content/        Content service + revisions
│   ├── blocks/         Block registry + core block types
│   ├── media/          Upload, storage adapters, image derivatives
│   ├── installer/      .jfpkg archive extractor + manifest validation
│   ├── updater/        Update lifecycle + rollback
│   ├── plugin-api/     Plugin loader and runtime
│   ├── cache/          Cache drivers and invalidation
│   ├── jobs/           Background jobs
│   └── cli/            Developer CLI
├── plugins/            Write your plugin here (one folder per plugin)
│   └── hello-world/    Example — copy this folder to start
├── themes/default      Bundled theme
├── css-providers/      CSS provider integrations
├── migrations/         Tracked SQL baselines/migrations for PostgreSQL, MySQL, and MariaDB
├── scripts/            Hosting install, zip, and bootstrap
└── docker/             Docker Compose variants (Postgres, MySQL, MariaDB)
```

The public website is rendered by Express before it is sent to visitors and
crawlers. Page content, titles, descriptions, canonical URLs, language
alternates, Open Graph metadata, and structured data therefore do not depend on
JavaScript. The authenticated admin uses Vite SSR for its first response and
then hydrates into an interactive React application. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Plugin development

Create a folder under [`plugins/`](plugins/) and start there. That is the
developer workspace: the pnpm workspace includes `plugins/*`, and the server
scans this directory when you run from source.

```bash
cp -R plugins/hello-world plugins/acme-seo
# edit plugins/acme-seo/package.json name, justflows.json, and src/index.ts
pnpm --filter acme.seo build
```

See [`docs/PLUGINS.md`](docs/PLUGINS.md) for hooks, admin pages, packaging, and
how to test against CE. [`plugins/README.md`](plugins/README.md) is the
workspace quickstart.

```typescript
// plugins/acme-seo/src/index.ts
import type { PluginModule } from "@justflows/sdk";

const myPlugin: PluginModule = {
  manifest: {
    id: "acme.seo",
    name: "Acme SEO",
    version: "1.0.0",
    permissions: [],
    main: "index.js",
  },

  async activate(ctx) {
    ctx.hooks.action("content.published", async (event) => {
      ctx.logger.info("A post was published!", { event });
    });
  },
};

export default myPlugin;
```

Site owners install a finished plugin as a `.jfpkg` in Admin → Plugins. They
do not add folders to `plugins/`. See [`plugins/README.md`](plugins/README.md).

---

## License

MIT

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Work happens on `feature/*`, `bug/*`,
and `patch/*` branches. Open pull requests into `develop`. `main` is protected
and only updated from `develop`.

## Security note

- Never commit real `.env` files, credentials, or API keys.
- Only commit example files such as `.env.example`.
- See [SECURITY.md](SECURITY.md) for the install token, package signatures, and
  how to report vulnerabilities.

### Scheduled publishing

Posts, pages, custom content types and working revisions support future publication
and optional expiry, with site/browser timezone display, a publishing agenda and
shareable draft previews. See [Scheduled publishing](docs/SCHEDULING.md) for author
instructions, permissions, API usage and restart recovery.
