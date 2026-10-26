# Model lab logos (apps/web2)

Used by `ModelAvatar`: the logo sits in a small white rounded tile (designer reference 2, TG 21088), as an `<img>`.
The white tile keeps every mark legible on a dark page and on a light page.

- Which model belongs to which lab: `packages/contracts/model-catalog/labs.json` (one data file, shared with `apps/api`). To add a lab, add its entry there and put
  its SVG here under the `logo` file name. `ModelAvatar` picks the files up with `import.meta.glob`; no code change.
- Source: `@lobehub/icons-static-svg` 1.95.1 (MIT), from `https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/`,
  copied unchanged:

  | File | Package file |
  |---|---|
  | `anthropic.svg`, `openai.svg`, `zai.svg`, `xai.svg` | same name, black mark |
  | `google.svg` | `gemini-color.svg` |
  | `qwen.svg`, `deepseek.svg`, `meta.svg`, `mistral.svg` | `<name>-color.svg` |
  | `kimi.svg` | `kimi.svg` (black mark; `kimi-color.svg` draws the K in white, which disappears on the white tile) |
  | `nvidia.svg`, `minimax.svg`, `cohere.svg`, `microsoft.svg`, `tencent.svg`, `bytedance.svg` | `<name>-color.svg` (added 2026-10-24) |
  | `amazon.svg` | `aws-color.svg` (added 2026-10-24) |
  | `xiaomi.svg` | `xiaomimimo.svg` (added 2026-10-24) |

  `fill="currentColor"` renders black in an `<img>`.
- `generic.svg` is our own sparkle glyph: the neutral fallback for a model of an unknown lab.
- The lab list and the OpenRouter author slugs in `labs.json` come from one read of OpenRouter's public
  `GET https://openrouter.ai/api/v1/models` (2026-10-24). Nothing is fetched at runtime from a third-party host.
- The package license covers the SVG files. The marks stay trademarks of their owners and appear here only to name the
  lab of a model (nominative use).
- The web3 client (`apps/web`) has its own copy of these files and does not import this folder.
