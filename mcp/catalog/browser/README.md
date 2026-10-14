# browser@1 — a headless Chromium on a seeded site, through the official Playwright MCP

Catalog fixture server for visual and web tasks (first user: `benchmarks/dfl-ui-design-audit`).
Contract: `docs/architecture/mcp-sandbox.md`, "The fixture-server contract".

## The choice (ADR-8, TMA-Q2 = A)

**The official Playwright MCP, not a custom browser tool.** `@playwright/mcp@0.0.83` (Microsoft,
Apache-2.0) runs as a stdio child process inside the sidecar, and the base fixture bridges it to
streamable HTTP with the token, the allow-list and the call log (the `memory@1` pattern). The agent
meets the same tool names and the same output that it meets with Playwright MCP anywhere else.

## How it works

- **Seed** (`seed_schema` in `manifest.json`): `hosts` → `{ "app.local": { "files": { "index.html": "...",
  "fonts/inter.woff2": { "base64": "..." } } }, "design.local": { ... } }`, an optional default
  `viewport` (1280×800 when absent) and `snapshot_boxes` (adds `[box=x,y,w,h]` to snapshots).
  A file is a UTF-8 string or `{ "base64": ... }`. Hosts end in `.local` or `.test`, at most 4.
- **The site server** is a small in-process HTTP server on `127.0.0.1:8081`. It is also Chromium's
  **only proxy** (`--proxy-bypass-list=<-loopback>`, so loopback goes through it too). It serves the
  seeded hosts on plain `http` and port 80 only, and answers 403 to anything else, CONNECT included.
  So the site answers as `http://app.local/` with no DNS, no port 80 bind and no capability.
  Paths: `/` and `/x/` → `index.html`; `/x` → `x`, `x.html` or `x/index.html`.
- **Two layers stop other hosts.** Playwright MCP `network.allowedOrigins` (the seeded origins)
  blocks the request in the browser (`net::ERR_BLOCKED_BY_CLIENT`). The proxy refuses whatever
  passes that layer. The `--internal` Docker network is the third layer.
- **Chromium**: the headless shell only (no headed Chromium, Firefox, WebKit or ffmpeg), the
  revision that the pinned `playwright-core` names (r1247, Chrome 155). `chromiumSandbox: false`:
  the sidecar drops every capability and sets `no-new-privileges`, so the Chromium sandbox cannot
  start, and the container is the sandbox. Fonts: DejaVu and Liberation only, bundled, so a page
  renders the same on every host and screenshot hashes are stable (the conformance test proves it
  across two containers). A task that needs another font bundles it in the seed as `woff2`.
- **Every writable path is in the `/state` tmpfs** (rootfs read-only): `HOME`, `TMPDIR`, the
  Playwright output dir (`/state/out`, evicted above 8 MB), the sites.
- **Boot** launches Chromium once (`about:blank`), so `ready` means the browser works.
- **Tools** (`tools.json`, upstream definitions, compared with the live upstream at boot, exit 4 on
  drift): `browser_navigate`, `browser_navigate_back`, `browser_resize`, `browser_take_screenshot`,
  `browser_snapshot`, `browser_evaluate`, `browser_find`, `browser_click`, `browser_hover`,
  `browser_type`, `browser_press_key`, `browser_select_option`, `browser_fill_form`,
  `browser_wait_for`, `browser_console_messages`, `browser_network_requests`. Not offered:
  `browser_run_code_unsafe`, `browser_file_upload`, `browser_drop`, `browser_tabs`, `browser_close`,
  `browser_drag`, `browser_handle_dialog`, `browser_emulate_media`, `browser_network_request`.
- **Export** (`/itera/export`, for the `mcp_state` scorer):
  - `visits` — one entry per URL × viewport (`id` = `http://app.local/detail@390x844`), with the
    count of calls, screenshots and snapshots made there;
  - `screenshots` — the sha256, size and MIME type of every image the agent received;
  - `navigations`, `requests` (what the site server served, by host and path), `blocked`
    (requests the proxy refused, by origin), `calls`, `calls_outside`.

    `view` is the same without the height (`http://app.local/detail@390`), because the scorer
    filter takes one key and a task asks for a width, not for the window height the agent chose;
  Example coverage assertion (a task asks for every screen at both widths):
  `{ "path": "$.visits[?(@.view=='http://app.local/detail@390')]", "exists": true }`.

## Known upstream quirks (seen in the probe, 2026-10-14)

- The upstream `inputSchema`s declare JSON Schema draft 2020-12. The base validates arguments with
  Ajv draft-07, which refuses to compile a schema that names 2020-12. `tools.json` drops the
  `$schema` key; the boot check compares everything else.
- `browser_navigate` does not return the page snapshot inline: it writes it to a file in the
  output dir (`[Snapshot](./page-....yml)`), which the agent cannot read. The agent must call
  `browser_snapshot`. Tool output carries wall-clock file names, so it is not byte-stable; the
  export is.
- `browser_take_screenshot` has `scale` as a **required** argument (`"css"` or `"device"`).
- The package `exports` map hides `cli.js` from `require.resolve`; the server starts it by path.

## Resources

`cpus: 1`, `memory_mb: 512`, `pids: 128` — the default worker caps (`ITERA_MCP_MAX_*`). Measured
in the conformance setup: ~170 MB and 75 PIDs after a few pages. Image: ~590 MB (node bookworm-slim
~220 MB + the headless shell ~275 MB + its libraries and fonts).

## Test

```bash
docker build -t testmyagent-mcp-browser:dev -f mcp/catalog/browser/Dockerfile mcp
node mcp/conformance.mjs browser testmyagent-mcp-browser:dev
```
