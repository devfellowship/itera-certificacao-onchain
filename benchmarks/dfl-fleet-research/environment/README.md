# Fleet research workspace

- `questions.md` — the 6 questions.
- `answers.schema.json` — the shape of `out/answers.json`.
- `out/answers.json` — your answers (starts empty).
- `out/report.md` — your short report (you create it).

For the `line` in a citation, read the file with the `repos` tool `read_file_lines`: it prints `<number>| <text>`.

Example of `out/answers.json`:

```json
{
  "answers": {
    "q1": { "answer": "acme/acme-ci", "evidence": [{ "ref": "acme/acme-ci:README.md:3", "quote": "Reusable CI workflows" }] }
  },
  "not_verified": ["q6"]
}
```
