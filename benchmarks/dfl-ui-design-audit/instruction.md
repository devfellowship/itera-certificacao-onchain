You audit a web app against its design. The app runs at `http://app.local` and has 3 screens:

| Screen | URL |
|---|---|
| `list` | `http://app.local/` |
| `detail` | `http://app.local/orders/1042` |
| `form` | `http://app.local/new` |

The design is in two forms. Use either one, or both:

- PNG files in `designs/`: `<screen>-1280.png` (a 1280×800 window) and `<screen>-390.png` (a 390×844 window), full page.
- The same design as HTML at `http://design.local`, with the same paths (`http://design.local/new` is the design of the `form` screen).

Use the `browser` MCP server (Playwright) to open each screen of the app at both widths: 1280×800 and 390×844 (`browser_resize`, then `browser_navigate`). You can inspect the pages with `browser_snapshot`, `browser_take_screenshot` and `browser_evaluate` (for example `getComputedStyle`). The browser can reach only `app.local` and `design.local`.

Find every place where the app does not match the design. The elements carry `data-testid` attributes. Some differences show at one width only.

Do NOT report:

- the "Updated hh:mm" clock in the header: the app shows the live time, the design a fixed time;
- any difference smaller than 1 px (anti-aliasing, sub-pixel positions).

Write `out/findings.json` (schema in `findings.schema.json`):

```json
{ "findings": [ { "screen": "list", "viewport": "390", "selector": "[data-testid=\"example\"]", "category": "spacing", "expected": "16px", "actual": "8px" } ] }
```

- `screen`: `list`, `detail` or `form`.
- `viewport`: `1280`, `390`, or `both` when the difference shows at both widths.
- `selector`: a CSS selector of the element in the app. Use `[data-testid="..."]`. For a missing element, use the selector of that element in the design.
- `category`: one of `spacing`, `color`, `typography`, `copy`, `missing-element`, `order`, `size`.
- `expected`: the value in the design; `actual`: the value in the app. Colors as hex (`#2952cc`), sizes in px (`16px`), font weights as numbers (`600`), text exactly as shown.

Report each difference once (one finding per element and property). A false report lowers your score. Do not edit any file outside `out/`. Hidden tests grade your findings, and the final state of the browser server must show that you opened every screen of the app at both widths.
