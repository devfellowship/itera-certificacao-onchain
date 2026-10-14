# UI vs design audit workspace

- `designs/` — the design of each screen as a full-page PNG: `<screen>-1280.png` (1280×800 window)
  and `<screen>-390.png` (390×844 window). Screens: `list`, `detail`, `form`.
- The same design is also served as HTML at `http://design.local` (same paths as the app).
- `findings.schema.json` — the shape of `out/findings.json`.
- `out/findings.json` — your findings (starts empty).

Example of `out/findings.json`:

```json
{
  "findings": [
    { "screen": "list", "viewport": "390", "selector": "[data-testid=\"example-element\"]", "category": "spacing", "expected": "16px", "actual": "8px" }
  ]
}
```
