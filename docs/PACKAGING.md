# Packaging a `.jfpkg`

A `.jfpkg` is a gzipped ustar archive. The installer extracts it with Node
builtins (no native `tar` addon) and requires `justflows.json` at the **root**
of the archive.

Minimum plugin layout after extract:

```
justflows.json
dist/index.js
```

If the plugin ships public styles or other runtime assets, include their built
forms below `dist/` too. For a stylesheet registered through `theme.css`, the
usual layout is:

```
justflows.json
dist/index.js
dist/styles/plugin.css
```

The host does not compile or copy assets after install. Resolve packaged files
relative to `import.meta.url`, and make the plugin's `build` script create every
file its runtime reads. Keep source-only files out of the archive when the
compiled `dist/` copy is sufficient.

Pack from the plugin folder so the manifest is not nested:

```bash
cd plugins/acme-seo
pnpm build
COPYFILE_DISABLE=1 tar -czf ../../acme-seo.jfpkg justflows.json dist
```

macOS `tar` otherwise adds `._*` AppleDouble files; `COPYFILE_DISABLE=1`
avoids that.

Install by dropping the file on Admin → **Plugins**. The host does not run
`npm install`, compile TypeScript, or build CSS from the archive — ship ready-to-run
JavaScript and assets.

Optional `registry` on `justflows.json` controls plugin-registry listing
(commercial flag, publisher visibility, coming-soon, free/paid and price). See
[MANIFEST.md](MANIFEST.md).

Since 0.1.2 the installer refuses an unsigned `.jfpkg` unless you pin its
SHA-256 digest in `JUSTFLOWS_TRUSTED_PACKAGE_DIGESTS`, or you set
`JUSTFLOWS_ALLOW_UNSIGNED_PACKAGES=1` (local development only).

The installer also rejects path traversal, oversized archives, and invalid
manifests. See `packages/installer/src/archive-safety.ts`.
