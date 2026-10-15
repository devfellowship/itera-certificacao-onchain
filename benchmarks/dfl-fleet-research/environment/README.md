# Fleet research workspace

- `questions.md` — the 6 questions.
- `answers.schema.json` — the shape of `out/answers.json`.
- `out/answers.json` — your answers (starts empty).
- `out/report.md` — your short report (you create it).

To read a file, use the `repos` tool `read_file_lines`. It is the only tool that returns file content, and it prints `<number>| <text>`. Cite that number as the `line` of a citation.

Quote rules: copy the text exactly from the one line that you cite; at least 6 characters after you trim the spaces at both ends (`  push:` has 5: too short); the quote appears on one line only in that file; the cited line number is the one that `read_file_lines` printed.

Minimal valid `out/answers.json` (the shape only; the values are not answers):

```json
{
  "answers": {
    "q1": { "answer": "acme/example-repo", "evidence": [{ "ref": "acme/example-repo:README.md:3", "quote": "Reusable CI workflows" }] }
  },
  "not_verified": []
}
```
