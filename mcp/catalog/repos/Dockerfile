# repos@2 — Itera MCP catalog fixture server. Build context: mcp/ (docker build -f catalog/repos/Dockerfile mcp).
# Contract: docs/architecture/mcp-sandbox.md "The fixture-server contract". No egress, no secret.
# Two upstream reference servers (modelcontextprotocol/servers, see manifest.json `upstream`) run as
# stdio child processes: the filesystem server (Node) and the git server (Python + git). One more
# tool, read_file_lines (file with line numbers), is served by server.mjs itself (lines.mjs).
FROM node:24-alpine
# git: the seed is loaded with `git fast-import`, and mcp-server-git (GitPython) shells out to git.
RUN apk add --no-cache git python3
WORKDIR /itera
COPY base/package.json base/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY base/fixture.mjs base/cli.mjs ./
# Upstream filesystem server, pinned by the lockfile.
COPY catalog/repos/package.json catalog/repos/package-lock.json /itera/upstream/
RUN cd /itera/upstream && npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
# Upstream git server, pinned with hashes, wheels only (no build toolchain in the image).
COPY catalog/repos/requirements.txt /itera/git/requirements.txt
RUN python3 -m venv /itera/git/venv \
  && /itera/git/venv/bin/pip install --no-cache-dir --disable-pip-version-check --require-hashes --only-binary=:all: -r /itera/git/requirements.txt \
  && find /itera/git/venv -name '__pycache__' -prune -exec rm -rf {} + \
  && /itera/git/venv/bin/python -m compileall -q /itera/git/venv/lib >/dev/null
COPY base/bin/ /itera/bin/
COPY catalog/repos/manifest.json catalog/repos/tools.json catalog/repos/server.mjs catalog/repos/lines.mjs catalog/repos/fleet.mjs catalog/repos/export.mjs /itera/server/
COPY catalog/repos/LICENSE.upstream /itera/LICENSE.upstream
COPY base/LICENSE-NOTICE /itera/LICENSE-NOTICE
# /repos is the path the agent sees; the repos themselves live in the /state tmpfs.
RUN ln -s /itera/bin/export /itera/export && ln -s /itera/bin/call /itera/call \
  && ln -s /state/repos /repos \
  && mkdir -p /seed /state && chown 10003:10003 /state && chmod 0755 /seed
LABEL org.opencontainers.image.source="https://github.com/devfellowship/itera-certificacao-onchain" \
      org.opencontainers.image.description="Itera MCP catalog fixture: repos@2" \
      org.opencontainers.image.licenses="Apache-2.0 AND MIT" \
      io.itera.mcp.name="repos" io.itera.mcp.version="2"
USER 10003:10003
ENV NODE_ENV=production ITERA_MCP_SERVER_DIR=/itera/server ITERA_MCP_STATE_DIR=/state \
    PYTHONDONTWRITEBYTECODE=1 HOME=/state/home GIT_CONFIG_NOSYSTEM=1
EXPOSE 8080
ENTRYPOINT ["node", "/itera/server/server.mjs"]
