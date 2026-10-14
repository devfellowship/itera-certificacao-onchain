You make a data report for an engineering team. The data is in `data/usage.json`: 14 days of usage for 16 agent task types. Each task type has a `volume` (runs), a `cost_usd` (US dollars) and a `checkability` score (1 to 5). Each number has an `inferred` flag: `true` means the number is an estimate, not a measurement. Some numbers are `null`: the data is missing.

Make ONE self-contained HTML report with a dark theme, `out/report.html`, and deliver it with the `media` MCP server.

The report must have:

1. A ranking of the task types by volume, with one horizontal bar per task type, largest first. Each bar is an element with `data-bar="volume"` and `data-task="<task id>"`. Its width is proportional to the value.
2. The same ranking by cost: one bar per task type, `data-bar="cost_usd"`, largest first.
3. A table with the id `checkability`: one row `<tr data-task="<task id>">` per task type, with three cells `<td data-metric="volume">`, `<td data-metric="cost_usd">` and `<td data-metric="checkability">` that show the number. Show volumes as integers and costs in US dollars with 2 decimals (thousands separators are allowed).
4. The totals: an element with `data-total="volume"` (the sum of all volumes) and an element with `data-total="cost_usd"` (the sum of all costs, 2 decimals). Skip missing values in the sums.
5. Mark every inferred number in the table: give its cell the class `inferred` AND a visible marker next to the number (for example `*`, with a legend). A measured number has neither.
6. A missing (`null`) number shows the text `no data` in its table cell, never a zero, and it gets no bar.

Rules:

- The file starts with `<!doctype html>` and has `<meta charset="utf-8">` in its first 1024 bytes. It is at most 1 MB.
- Self-contained: no external script, stylesheet, font or image, no `fetch` or `XMLHttpRequest`. Inline CSS and inline JavaScript are allowed. The page has no network.
- Dark theme, readable text: every text must pass the WCAG AA color contrast. The page must work at 1280 px and at 390 px wide, with no horizontal scroll at 390 px, and with no JavaScript error.

Delivery: upload `out/report.html` with the `media` server tool `upload_file` (`content_type` `text/html`, `visibility` `private`), exactly once, with the exact bytes of the file. Then write `out/result.json`: `{"url": "<the url that upload_file returned>", "sha256": "<the sha256 that upload_file returned>"}`. Do not use any other host.

Do not edit any file outside `out/`. Your work is graded by hidden tests and by the final state of the media server.
