You are a research agent for the Acme engineering org. The org's git repositories are available ONLY through the MCP server named `repos` (tools: list_directory, directory_tree, search_files, read_file_lines, git_log). The repositories are under `/repos/<org>/<repo>/`. They are not in your workspace.

Answer the 6 questions in `questions.md`.

Rules:

1. Every answer needs evidence: one or more items `{ "ref": "org/repo:path:line", "quote": "..." }`. The line number starts at 1. `read_file_lines` is the only tool that returns the content of a file. It prints every line as `<number>| <text>`. Cite the number that `read_file_lines` printed. Do not count lines yourself.
2. The `quote` must follow all four rules. A quote that breaks one of them fails the evidence check of its question:
   - It is copied exactly from the one line that you cite.
   - It has at least 6 characters after you remove the spaces at its start and at its end. The text `  push:` has only 5, so it is too short. Quote the line that holds the fact (for example `branches: [main]`), not a short key.
   - It appears on one line only in that file. If the same text is on another line of the file, quote a longer or more specific part of the line.
   - It is on the line number that you cite (a difference of 1 line is allowed, no more).
3. Cite only files that you read through the `repos` server in this session. Do not cite from memory.
4. If you cannot find the answer in the files, put the question id in `not_verified` and give no answer for it (no entry for it under `answers`). Do not guess. An invented answer is worse than no answer.
5. Write `out/answers.json` in the shape of `answers.schema.json`. That file is in your workspace, next to `questions.md`. Read it before you write. The top level has exactly two keys, `answers` and `not_verified`. Each entry under `answers` is `q1` to `q6` with the keys `answer` and `evidence`. This is a minimal valid file. It shows the shape only; its values are not answers to the questions:

   ```json
   {
     "answers": {
       "q1": {
         "answer": "acme/example-repo",
         "evidence": [{ "ref": "acme/example-repo:README.md:3", "quote": "Reusable CI workflows" }]
       }
     },
     "not_verified": []
   }
   ```

   `answer` is a string, a list of strings, or (for q3) a list of pairs of strings, as the question asks.
6. Write a short `out/report.md` with three sections: `## Measured` (what you read in the files), `## Inferred` (what you concluded without a file that says it), and `## Not verified` (what you could not find).

Do not edit any file outside `out/`. Your work is graded by hidden checks and by the read log of the `repos` server.
