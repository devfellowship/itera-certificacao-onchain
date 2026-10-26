# Intents (intent_list_version 2) — label each SHAPES entry with exactly one

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
| browser-check | drive or check a real browser page: agent-browser, Playwright (npx playwright test/screenshot, a Playwright script), prod-loop-verify verify-render.mjs, a browser MCP tool |
| github-api | a GitHub API or admin call that is not about a PR, a CI run, git content or a search: gh api on orgs/users/teams/installations/rate_limit/secrets/variables/rulesets/settings/packages/labels or the repo metadata, gh secret/variable/label/ruleset, curl api.github.com |
| media-generate | make or convert media: text to speech (speak.sh), speech to text (transcribe-voice.sh, groq-transcribe), an image, thumbnail, video or render (ffmpeg, ImageMagick convert, remotion, thumbify, branded-render) |
| other | none of the above fits (last resort; graded as a miss) |

Shell decoration (cd, echo, export, a variable assignment) never decides the label. If a shape is only decoration, use other.

Boundaries of the three version-2 intents:
- browser-check: npx playwright install is build/test (it installs a browser and checks no page). A repo unit test runner (vitest/jest/pytest) is build/test. A curl of a page is web-research or ops-inspect.
- github-api: gh api on pulls/issues/commits/check-runs is pr-read or pr-write/merge; on actions runs/jobs/workflows it is ci-read; on contents/git/branches it is git-read or git-write; on search it is search.
- media-generate: a read of a media file (ffprobe, identify, file) is file-read. An upload of the file to the media store (supabase-upload) is skill-run. A browser screenshot of a page is browser-check.
