# helpdesk@1 — Itera MCP catalog fixture server. Build context: mcp/ (docker build -f catalog/helpdesk/Dockerfile mcp).
# Contract: docs/architecture/mcp-sandbox.md "The fixture-server contract". No egress, no secret.
FROM node:24-alpine
WORKDIR /itera
COPY base/package.json base/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY base/fixture.mjs base/cli.mjs ./
COPY base/bin/ /itera/bin/
COPY catalog/helpdesk/manifest.json catalog/helpdesk/tools.json catalog/helpdesk/server.mjs catalog/helpdesk/export.mjs /itera/server/
COPY base/LICENSE-NOTICE /itera/LICENSE-NOTICE
RUN ln -s /itera/bin/export /itera/export && ln -s /itera/bin/call /itera/call \
  && mkdir -p /seed /state && chown 10003:10003 /state && chmod 0755 /seed
LABEL org.opencontainers.image.source="https://github.com/devfellowship/itera-certificacao-onchain" \
      org.opencontainers.image.description="Itera MCP catalog fixture: helpdesk@1" \
      org.opencontainers.image.licenses="Apache-2.0" \
      io.itera.mcp.name="helpdesk" io.itera.mcp.version="1"
USER 10003:10003
ENV NODE_ENV=production ITERA_MCP_SERVER_DIR=/itera/server ITERA_MCP_STATE_DIR=/state
EXPOSE 8080
ENTRYPOINT ["node", "/itera/server/server.mjs"]
