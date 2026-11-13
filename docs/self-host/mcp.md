# The learn MCP and the eval results

An agent that has the learn MCP can send a result without `tma login`.

## The tool that this repo names

| Tool | What it does |
|---|---|
| `create_tma_local_result` | Uploads a local result file. It takes the same file that `tma upload` sends. |

This repo names only this one learn MCP tool for TMA results.
The tools that read results are defined in the learn MCP, not in this repo.
Do not guess a tool name.
Read the tool list of your MCP client, and use the names that it shows.

The runner README says that the tool takes the same file as `tma upload`.
That is the file `result.json` of `tma run` and `tma grade` (format `tma-local-result/1`).
This repo does not say that the tool takes a `tma-local-result/2` or `/3` body.
For the eval kit, use `tma eval upload`.
That command builds and checks the body on your host first.

## CLI or tool?

| Situation | Use |
|---|---|
| You run the eval kit and you can sign in | `tma eval upload` |
| You want to see the body before you send it | `tma eval upload --dry-run` or `tma upload <file> --dry-run` |
| You upload a recorded session with a human label | `tma eval upload --mode trace_review` |
| An agent has the learn MCP and has no `tma login` | `create_tma_local_result` |
| You need to read a result back | A read tool from the tool list of your MCP client |
| You need to delete one of your results | `tma evaluations delete <evaluation id>` |

## What does not change

- The same contract applies to both paths. See [`upload-contract.md`](upload-contract.md).
- A result from either path shows with the **Self-declared** badge.
- The tool uploads numbers only. It never receives a prompt, a message or a file body.
- A key never goes in a tool argument.
