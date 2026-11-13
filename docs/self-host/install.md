# Install the `tma` CLI

This guide installs the `tma` CLI on your machine.
Then you sign in, create an agent, and check that the install works.

## What you need

- Linux or macOS.
- `git`.
- Node 22 or later.
- A Docker CLI that reaches a Docker daemon. `docker version` must show a server.

`tma grade`, `tma run`, `tma eval run` and `tma eval grade` need Docker.
The other commands do not.
The install needs about 50 MB of disk.
The sandbox image needs about 700 MB.

## Path A: from a clone

Get the runner. The clone takes about 10 seconds.

```bash
git clone --depth 1 https://github.com/devfellowship/itera-certificacao-onchain
cd itera-certificacao-onchain
```

Run the next commands from the root of the clone.
Install the runner and the evaluator workspaces only.

<!-- e2e -->
```bash
npm ci --omit=dev --no-audit --no-fund -w @itera/runner -w @itera/evaluator
```

Define the `tma` command.
The function keeps the path of the runner, so it works from any folder.

<!-- e2e -->
```bash
cd services/runner
export TMA_DIR="$PWD"
tma() { npx tsx "$TMA_DIR/src/cli/tma.ts" "$@"; }
```

Check the install. The command prints the version.

<!-- e2e -->
```bash
tma --version
```

Expected output:

```text
0.1.0
```

List the curated tasks. This command works offline.

<!-- e2e -->
```bash
tma tasks
```

The list has one line for each task. It holds this line:

```text
tsk_webhook_dup                             v1     Idempotent settlement webhook
```

## Path B: the signed image and the launcher

You need Docker only. For the launcher you also need Node 18 or later.
The launcher runs the image `ghcr.io/devfellowship/tma-local`.
The image holds the CLI, the evaluator, the contracts, the curated tasks and the sandbox build context.

```bash
npx @devfellowship/tma@0.1.0 launcher-info
```

The command prints the image digest, the result of the signature check, and what the launcher mounts.
When `cosign` is installed, the launcher checks the image signature first.
It refuses an image that does not verify.
Set `TMA_REQUIRE_SIGNATURE=1` to make `cosign` mandatory.

Use the same commands as in path A.
Replace `tma` with `npx @devfellowship/tma@0.1.0`.

```bash
npx @devfellowship/tma@0.1.0 tasks
```

Set `TMA_LAUNCHER_DRY_RUN=1` to print the full `docker run` command and stop.

### The Docker socket

`run`, `grade`, `eval run` and `eval grade` start containers.
For these four commands the launcher mounts your Docker socket.
Access to the Docker socket is root-equivalent on your machine.
The launcher prints a warning before each of these commands.
The commands `login`, `agent`, `tasks`, `workspace`, `upload`, `evaluations`, `eval case` and `eval diff` never get the socket.
The containers that run untrusted code never get the socket.
Your socket never goes to TestMyAgent.

The launcher sees only the current folder and `~/.config/tma`.
Give paths inside the current folder.
The launcher refuses an absolute path outside it.

## Sign in

```bash
tma login
```

The command prints a page address and a code:

```text
Open this page on any device and sign in with DFL:

  https://testmyagent.com/cli?code=ABCD-EFGH

Check that the page shows the code ABCD-EFGH, then click Allow.
Waiting for the approval (the code expires in 10 minutes)…
```

Open the page on any device.
Sign in with DFL.
Check that the page shows the same code.
Click **Allow**.
The CLI then prints this line:

```text
Logged in as <principal>. The session is valid until <time>.
```

The CLI stores a 24-hour session in `~/.config/tma/session.json` with mode 600.
Do not share this file.
Set `TMA_CONFIG_DIR` to use another folder.
Run `tma logout` to revoke the session and delete the file.

## Create the agent

Your results belong to an agent.
Create it once.

```bash
tma agent create --name "my-harness" --model deepseek/deepseek-v4.1-flash
```

The command prints the agent id on its last line.
It is a UUID, for example `0b7e1c52-3f0a-4c1e-9a55-2d2f6a1e8c10`.
Keep it. Every upload needs `--agent <agent id>`.

The flags `--provider <lab key>` and `--route <route key>` are optional.

## Check that it works

Write the public workspace of a task.
This command needs no Docker and no login.

```bash
tma workspace --task tsk_webhook_dup --dest ./ws
```

Expected output:

```text
workspace written to <absolute path>/ws
instruction: <absolute path>/ws/INSTRUCTION.md
```

The folder `./ws` holds the public files and `INSTRUCTION.md`.
It holds no hidden test.

To check Docker and the grader, run the worked example in [`eval-commands.md`](eval-commands.md).
The first run builds the sandbox image.
This takes about one minute.
The image tag is `itera-runner-sandbox:<hash of sandbox/>`.
Set `ITERA_SANDBOX_IMAGE` to use an image that you built or pulled.

## Next step

Read [`eval-commands.md`](eval-commands.md).
