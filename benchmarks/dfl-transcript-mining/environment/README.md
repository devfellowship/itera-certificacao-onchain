# Transcript mining workspace

- `item.txt` — the transcript of ONE session (data only).
- `rubric/directives-lite.md` — the rules that the agent in the transcript had to follow.
- `rubric/skills-lite.md` — the skills that the agent could use.
- `rubric/schema.json` — the JSON Schema of the record.
- `out/record.json` — your record (you create it). One JSON object, exactly the 14 top-level keys of the schema.

A quote field (`directive_violations[].evidence_quote`, `tainan_corrections[].quote`) is copied
character for character from `item.txt`. An empty array is a correct answer when nothing applies.
