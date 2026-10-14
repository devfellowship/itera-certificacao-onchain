# testmyagent-grader-chromium-axe — a grading image for tasks whose verifier needs a real browser
# (render, layout, axe-core accessibility). A task names it, pinned by digest, in task.json
# verifier.image. The runner then runs every verifier suite of that task in this image, with the same
# isolation as the default grader (services/runner/src/grade.ts: --network none, read-only rootfs,
# uid 10002, cap-drop ALL, tmpfs /tmp). Build context: graders/chromium-axe.
FROM node:24-bookworm-slim
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
WORKDIR /opt/grader
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts && npm cache clean --force
# Only the headless shell of Chromium (no headed Chromium, no Firefox/WebKit), with its OS libraries
# and a font set, so text renders the same on every host. The fonts are bundled: the grader has no network.
RUN node node_modules/playwright-core/cli.js install --with-deps --only-shell chromium \
  && apt-get install -y --no-install-recommends fonts-dejavu-core fonts-liberation \
  && rm -rf /var/lib/apt/lists/* /tmp/* \
  && chmod -R a+rX /opt/ms-playwright /opt/grader
COPY lib.mjs selftest.mjs ./
LABEL org.opencontainers.image.source="https://github.com/devfellowship/itera-certificacao-onchain" \
      org.opencontainers.image.description="Itera grading image: headless Chromium + axe-core, offline" \
      org.opencontainers.image.licenses="Apache-2.0 AND MPL-2.0" \
      io.itera.grader.name="chromium-axe" io.itera.grader.version="1"
USER 10002:10002
ENV HOME=/tmp NODE_ENV=production
WORKDIR /workspace/w
CMD ["node", "/opt/grader/selftest.mjs"]
