# Intents (intent_list_version 1) — label each SHAPES entry with exactly one

A shape is a Bash command reduced to program + subcommand (arguments stripped, up to 3 parts joined by " + "), or a non-Bash tool name. Label the MAIN purpose of the whole shape. When parts disagree, the write wins over the read (git-write over git-read, pr-write/merge over pr-read).

| intent | use for |
|---|---|
| pr-read | read a PR: gh pr list/view/diff/checks/status, fleet-ci-check |
| pr-write/merge | gh pr create/merge/comment/edit/review/close/ready, safe-admin-merge |
| ci-read | read CI runs and logs: gh run view/list/watch/rerun |
| ci-watch/poll | a wait loop on CI or a PR (Monitor, until/while loops over gh) |
| git-read | git fetch/log/status/diff/show/rev-parse/branch, gh repo clone |
| git-write | git commit/push/checkout/worktree/merge/rebase/reset/clone |
| build/test | npm/pnpm/npx/tsc/vitest/jest/pytest/make, a repo test or build script, a local validator run |
| deploy | dokploy-deploy, redeploy-app, a deploy trigger |
| credential-fetch | credentials-lookup, any vault read |
| plan-mcp | plans-mcp, read-plan, plan-tasks, a plans-app call |
| skill-run | run of any other skill script (bash <skill:...>) |
| mcp-read | an MCP tool that reads (get_/list_/search_/read_) |
| mcp-write | an MCP tool that writes (create_/update_/set_/publish_/delete_/answer_) |
| file-read | read local files: cat/head/tail/sed -n/ls/wc/jq/python3 or node one-liners that only read |
| file-edit | write local files: cp/mv/rm/tee/touch/chmod/ln, mkdir, a heredoc to a file, a script that writes files |
| search | grep/rg/find, git grep, ToolSearch |
| web-research | an external web read: WebFetch, WebSearch, curl/wget to an outside host |
| ops-inspect | read a host or service: ssh/docker/systemctl status/journalctl/ps/df/free/curl to an internal health URL |
| ops-change | change a host or service: restart, service update, compose up, a write under /etc, a timer or unit change |
| spawn-subagent | Agent, Task |
| message-agent | SendMessage to another agent |
| reply-human | a reply to a human channel (Telegram reply, react, edit_message) |
| wait/sleep | sleep |
| other | none of the above fits (last resort; graded as a miss) |

Shell decoration (cd, echo, export, a variable assignment) never decides the label. If a shape is only decoration, use other.
