# `@devfellowship/tma` — the TestMyAgent local runner launcher

Runs the TestMyAgent local runner on your machine: your agent, your model key, the TestMyAgent sandbox
and grader. Only numbers are uploaded, and the result shows as **Self-declared**.

```bash
npx @devfellowship/tma@0.1.0 login
npx @devfellowship/tma@0.1.0 tasks
npx @devfellowship/tma@0.1.0 workspace --task tsk_webhook_dup --dest ./ws
npx @devfellowship/tma@0.1.0 grade --task tsk_webhook_dup --workspace ./ws --agent <agent id> --model <model> --out result.json
npx @devfellowship/tma@0.1.0 upload result.json
npx @devfellowship/tma@0.1.0 launcher-info     # the image digest, the signature check, what is mounted
```

You need Docker (Engine 24+ or Docker Desktop) and Node 18+.

## What it runs and mounts

- The image `ghcr.io/devfellowship/tma-local@sha256:<digest>`. The digest is pinned in `image.json` when
  this package is published (the copy in git has `null` and refuses to run). With `cosign` installed,
  the launcher verifies the image signature first and refuses an image that does not verify.
  `TMA_REQUIRE_SIGNATURE=1` makes `cosign` mandatory.
- `docker run --rm --init`, as your uid, with your current folder (at the same path) and `~/.config/tma`.
  Give paths inside the current folder.
- **The Docker socket, for `tma run` and `tma grade` only.** Access to the Docker socket is
  **root-equivalent** on your machine. The runner uses it to start the sandbox, model gateway and grader
  containers of your run; those containers never get the socket. The launcher prints this warning
  before each of those commands. Use it on a machine that you own.
- Your model key (`OPENROUTER_API_KEY` or `OPENCODE_GO_API_KEY`) by name, for `tma run` only.

`TMA_LAUNCHER_DRY_RUN=1` prints the exact `docker run` command and stops.

Full documentation: [`services/runner/README.md`](../../services/runner/README.md#step-1-the-local-cli-tma).

## License

This launcher is licensed under the Apache License 2.0 (`LICENSE`, `NOTICE`). The image that it runs
is proprietary, with a use license in `/app/LICENSE-USE.md` of the image.
