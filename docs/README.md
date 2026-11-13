# Documentation

| Folder | What it holds |
|---|---|
| [`architecture/`](architecture/) | How the platform is built. Start with [`mcp-sandbox.md`](architecture/mcp-sandbox.md). |
| [`contracts/`](contracts/) | The names of the contracts. Start with [`GLOSSARY.md`](contracts/GLOSSARY.md). |
| [`self-host/`](self-host/) | Run the `tma` CLI and the `tma eval` kit on your own machine. |

## Self-host guides

Read them in this order.

1. [`self-host/install.md`](self-host/install.md): install `tma`, sign in, create an agent.
2. [`self-host/eval-commands.md`](self-host/eval-commands.md): the eval kit, with one worked example.
3. [`self-host/case-format.md`](self-host/case-format.md): the `tma-case/1` file.
4. [`self-host/upload-contract.md`](self-host/upload-contract.md): what leaves your host.
5. [`self-host/mcp.md`](self-host/mcp.md): upload through the learn MCP.

## The runner

The CLI code and its full reference are in [`services/runner/README.md`](../services/runner/README.md).
The worked example is in [`services/runner/examples/eval/tsk_webhook_dup/`](../services/runner/examples/eval/tsk_webhook_dup/README.md).

## Two paths, one result

You can run an evaluation on the hosted service or on your own host.
Both paths write the same result contract.
The hosted path is not covered here.
