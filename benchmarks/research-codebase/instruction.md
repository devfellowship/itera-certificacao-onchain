You joined a small team and must find your way around its backend. The code of the invented shop backend is in `repo/` (read only). The questions are in `data/questions.json`: each one describes what a function does, without naming it.

For every question, find the function that does it and answer with the file and a line inside that function: `path:line`.

- The path is relative to `repo/`, for example `src/foo/bar.ts`.
- The line is 1-based and must be inside the function, from its declaration line to its closing brace.
- Some names exist more than once. Pick the function that the current code uses, not a deprecated copy.

Write `out/answers.json`:

```json
{ "answers": [ { "id": "q1", "answer": "src/foo/bar.ts:42" } ] }
```

Rules:

- Answer every question exactly once, with the ids of `data/questions.json`.
- Do not edit any file outside `out/`. Your work is graded by hidden tests; any change under tests/ is out of scope and will be rejected.
