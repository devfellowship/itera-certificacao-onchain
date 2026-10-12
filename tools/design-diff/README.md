# design-diff

Pixel diff of the testmyagent web app against the design renders (plan
`20261012-itera-testmyagent-ui-refactor`, U2/U24).

```bash
npm run design-diff -- --all                      # starts the web app in fixture mode itself
npm run design-diff -- --page 01-agents --base http://127.0.0.1:5173
npm run design-diff -- --all --upload             # uploads report.html, prints the URL
```

- **Expected** = `reference/<id>.png` — the design `.dc.html` pages rendered at 1440 px with the
  body margin removed. Regenerate from a local copy of the design (never committed; untrusted data,
  rendered offline in Chromium) with `--design-src <dir> --update-reference`.
- **Implemented** = the route of `pages.json` in fixture mode (`VITE_FIXTURE_MODE=design`: MSW serves
  `apps/web/src/fixtures/design/*`, the session is the design user).
- **Diff** = pixelmatch, threshold 0.1, both images padded to the same size with `#0a0908`; `masks`
  in `pages.json` hide dynamic regions. Pass: ≤ 5 % per screen, ≤ 3 % for the landing.
- Output in `out/` (git-ignored): `<id>.expected|implemented|diff.png`, `report.json`, `report.html`.

A screen lane runs its page before it asks for merge and puts the percentage in the PR body.
Playwright needs a Chromium: `npx playwright install chromium`, or `--chrome /usr/bin/google-chrome`.

## Reference provenance

- Every reference PNG is a render of the design `.dc.html`, **except** the four screen 04 references
  (`04-queued.png`, `04-running.png`, `04-issuing.png`, `04-error.png`).
- The 04 references are **implementation renders approved by Tainan on 2026-10-12 (TG 21120), not canvas
  renders.** Tainan asked for an agent card at the top of screen 04 (TG 21092). The old canvas has no
  card, so the canvas render failed the strict diff (13 to 25 %). Tainan decided to use our own render as
  the reference ("up to you, the easiest").
- Captured with this harness: fixture mode, 1440 px, routes `/evaluations/ev_queued|ev_running|ev_issuing|ev_error`
  (the `<id>.implemented.png` files in `out/`).
- Consequence: the 04 diff guards against regression of the approved render. It no longer measures
  fidelity to the canvas. Do not run `--update-reference` for 04 pages: it would overwrite them with the old
  canvas render. After an approved change to screen 04, replace the four PNGs from a fresh run.
