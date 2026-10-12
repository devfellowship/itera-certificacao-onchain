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
