# Model provider logos

Used by `ModelAvatar`: the logo sits in a small white rounded tile (designer reference 2, TG 21088), as an `<img>`.

- Source: `@lobehub/icons-static-svg` 1.95.1 (MIT), copied unchanged. Brand-color files where the package has one
  (`gemini-color` saved as `google.svg`, `qwen-color`, `deepseek-color`, `kimi-color`, `meta-color`, `mistral-color`),
  the black mark otherwise (`anthropic`, `openai`, `zai`, `xai`; `fill="currentColor"` renders black in an `<img>`).
- `generic.svg` is our own sparkle glyph (fallback for an unknown provider).
- The package license covers the SVG files. The marks stay trademarks of their owners and appear here only to name the
  provider of a model (nominative use). Nothing is fetched at runtime from a third-party host.
- `z-ai/glm` uses `zai`. `moonshot/kimi` uses `kimi`. Google and Gemini models use the Gemini star.
