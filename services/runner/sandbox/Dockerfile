# ITERA agent sandbox. One container of this image runs ONE agent run.
# Build context: services/runner/sandbox. It holds no repository code, no benchmarks and no secret.
# The worker starts it with: no Docker socket, no secret at all, an internal-only network and a
# model gateway that forwards only the model API and adds the key itself. See services/runner/README.md.
FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ripgrep ca-certificates \
  && rm -rf /var/lib/apt/lists/*
# Pinned: the JSON event format that src/trace.ts parses is from this version.
RUN npm install -g opencode-ai@1.18.31 && npm cache clean --force
RUN useradd --create-home --uid 10001 agent \
  && mkdir -p /workspace /home/agent/.config/opencode \
  && chown -R agent:agent /workspace /home/agent
COPY --chown=agent:agent opencode.json /home/agent/.config/opencode/opencode.json
COPY model-gateway.mjs /opt/itera/model-gateway.mjs
ENV HOME=/home/agent \
    OPENCODE_DISABLE_AUTOUPDATE=true \
    OPENCODE_DISABLE_MODELS_FETCH=true \
    OPENCODE_DISABLE_LSP_DOWNLOAD=true \
    OPENCODE_DISABLE_SHARE=true \
    NPM_CONFIG_OFFLINE=true \
    NO_PROXY=localhost,127.0.0.1 \
    no_proxy=localhost,127.0.0.1
USER agent
WORKDIR /workspace
ENTRYPOINT ["opencode"]
