# studio-visual-match

Visual match of each studio screen (S1 to S13, plus S10a and S11a) against its artboard on the design canvas
"TMA + Eval Studio: real-trace evals". Plan `20261112-tma-c5-studio-area-web2`, task C5-VIS-MATCH.

```bash
npm run studio-visual-match -- --judge                 # all screens, signed in, judged
npm run studio-visual-match -- --screen S1,S5 --judge  # some screens
npm run studio-visual-match -- --judge --upload        # also upload each pair and report.html, print the URL
```

Each screen gives `out/<id>.pair.png`: the artboard at the left, the live page at the right, the same viewport
(1440x960; S13 390x844).

- **Design** = `reference/<id>.png`, the artboard rendered by this script. The canvas source is never committed
  (untrusted data). To refresh it from a local copy of the `.dc.html` files (rendered offline, only 127.0.0.1 and
  Google Fonts reachable): `--design-src <dir> --update-reference`. `reference/chrome.json` holds the chrome that the
  render measured.
- **Live** = the route of `screens.json` on `--base` (default `https://testmyagent.com`). Routes with ids that change
  are `{from, link}`: the script opens `from` and follows the first link that matches.
- **Chrome cut (ADR-1).** The studio keeps the shared web2 nav and has no own top bar or icon rail. So the script cuts
  the artboard's top `<header>` and left icon rail, and the live `[data-testid=app-nav]`, before the compare.
- **Judge** (`--judge`): `vision-llm-judge --rubric-pair`, function = the screen's `actions`, aesthetic = loose. When
  it gives no verdict (no backend, quota), Claude Code headless (`claude -p`, model `sonnet`, Read tool only) judges
  with the same rubric (`--judge-backend vision|claude` forces one). Score 0-100 = the mean of the aesthetic score
  (matches 1, adapted 0.75, diverges 0) and the function score (present or equivalent). **match** = no action
  missing and no aspect diverges.
- **Pixel diff** is information only: the artboards hold illustrative data, the live pages real data.
- **Unavailable**: a screen with `optional` whose link is absent (S3: a fleet trace is readable only through
  `tma studio serve` on the tailnet; the plan keeps S3 human-checkable).

Sign-in: the environment of `scripts/e2e/tma-session.mjs` (`TMA_E2E_DFL_EMAIL`, `TMA_E2E_DFL_PASSWORD`,
`DFL_SUPABASE_URL`, `DFL_SUPABASE_ANON_KEY`), a smoke identity fetched by the caller and unset after use. Nothing is
printed or written. `--anonymous` skips it.

Exit: 0 every capture ok (with `--judge`: every pair matches) · 1 a pair does not match · 2 usage, sign-in or capture
error. Unit tests (offline, in CI): `node --test tools/studio-visual-match/lib.test.mjs`.

Before the merge, `--dist apps/web2/dist` (after `npm run build -w @itera/web2`) serves the pages and assets of the live
origin from the local build, while the API calls stay live. A redesign lane runs its screen that way, then again after the deploy, and puts the pair and the score in the PR or the plan.
