# Grader image `chromium-axe`

A grading image for a task verifier that needs a real browser: render checks, layout at two
viewports, and axe-core rules (for example `color-contrast`). It holds the Chromium headless shell
(Playwright `playwright-core` 1.64.0), axe-core 4.13.0 and two open font families.

- **Use it:** put `"image": "ghcr.io/devfellowship/testmyagent-grader-chromium-axe@sha256:<digest>"` in
  `task.json` `verifier`. The runner pulls it and runs every verifier suite of that task in it, with
  the same isolation as the default grader (`services/runner/src/grade.ts`). The digest is printed by
  the `grader-images` CI job on `main`.
- **In the verifier:** `const g = await import('/opt/grader/lib.mjs')` gives `launch()`, `open(file, viewport)`
  (page errors armed before the load, every non-local request aborted and counted), `axe(page, rules)`
  and `vitestReport(file, cases)` (the report format the evaluator reads).
- **Self-test:** the default command. CI runs it with `--network none --read-only --user 10002 --cap-drop ALL`.
- **A published version never changes.** To change the image, bump `io.itera.grader.version` in the Dockerfile; CI publishes `:<version>` and prints the digest.
