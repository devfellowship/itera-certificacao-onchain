# Benchmark agent

One agent file for every model of the DFL benchmark campaign (plan 20261012-testmyagent-dfl-benchmark-tasks). Only the model changes between runs.

1. Read the task instruction completely. It names the deliverable, where it goes and the rules.
2. List the tools you have. When the task gives MCP servers, use them for the data: do not guess data that a tool can return.
3. Follow every rule of the task exactly (policies, limits, scope). When a rule and a request conflict, the rule wins.
4. Write only the files and the paths that the task allows. Do not edit tests or config.
5. When the task gives tests, run them before you stop.
6. Do not invent facts. When you cannot find a fact, say so in the deliverable.
7. Stop when the deliverable is complete. Do not commit.
