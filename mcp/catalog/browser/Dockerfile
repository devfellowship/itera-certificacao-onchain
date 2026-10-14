# browser@1 — Itera MCP catalog fixture server. Build context: mcp/ (docker build -f catalog/browser/Dockerfile mcp).
# Contract: docs/architecture/mcp-sandbox.md "The fixture-server contract". No egress, no secret.
# The upstream is the official Playwright MCP (@playwright/mcp, Microsoft, Apache-2.0), pinned by the
# lockfile, with ONLY the Chromium headless shell (no headed Chromium, no Firefox/WebKit, no ffmpeg).
# Debian, not Alpine: the Playwright Chromium build is glibc-only (same base as graders/chromium-axe).
FROM node:24-bookworm-slim
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
WORKDIR /itera
COPY base/package.json base/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY base/fixture.mjs base/cli.mjs ./
COPY catalog/browser/package.json catalog/browser/package-lock.json /itera/upstream/
# The browser revision is the one that the pinned playwright-core names (browsers.json), so the
# lockfile pins the browser too. The OS libraries are the short list that the headless shell links
# (checked with ldd below), not `--with-deps` (that adds X, xvfb and ~60 MB of CJK/emoji fonts).
# Fonts: DejaVu + Liberation only, bundled (no network), so text renders the same on every host and
# the screenshot hashes stay stable. fc-cache runs here because the rootfs is read-only.
RUN cd /itera/upstream && npm ci --omit=dev --no-audit --no-fund && npm cache clean --force \
  && node node_modules/playwright-core/cli.js install --only-shell chromium \
  && rm -rf /opt/ms-playwright/ffmpeg-* \
  && apt-get update && apt-get install -y --no-install-recommends \
     libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 \
     libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 \
     libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 fontconfig fonts-dejavu-core fonts-liberation \
  && fc-cache -f >/dev/null \
  && rm -rf /var/lib/apt/lists/* /var/cache/apt/* /tmp/* /root/.cache /root/.npm \
  && chmod -R a+rX /opt/ms-playwright \
  && ln -s "$(ls -d /opt/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64)/chrome-headless-shell" /itera/chromium \
  && ! ldd /itera/chromium | grep 'not found'
COPY base/bin/ /itera/bin/
COPY catalog/browser/manifest.json catalog/browser/tools.json catalog/browser/server.mjs catalog/browser/export.mjs /itera/server/
COPY catalog/browser/LICENSE.upstream /itera/LICENSE.upstream
COPY base/LICENSE-NOTICE /itera/LICENSE-NOTICE
RUN ln -s /itera/bin/export /itera/export && ln -s /itera/bin/call /itera/call \
  && mkdir -p /seed /state && chown 10003:10003 /state && chmod 0755 /seed
LABEL org.opencontainers.image.source="https://github.com/devfellowship/itera-certificacao-onchain" \
      org.opencontainers.image.description="Itera MCP catalog fixture: browser@1" \
      org.opencontainers.image.licenses="Apache-2.0" \
      io.itera.mcp.name="browser" io.itera.mcp.version="1"
USER 10003:10003
# Every writable path is under the /state tmpfs (the rootfs is read-only).
ENV NODE_ENV=production ITERA_MCP_SERVER_DIR=/itera/server ITERA_MCP_STATE_DIR=/state \
    HOME=/state/home TMPDIR=/state/tmp XDG_CONFIG_HOME=/state/home/.config XDG_CACHE_HOME=/state/home/.cache
EXPOSE 8080
ENTRYPOINT ["node", "/itera/server/server.mjs"]
