#!/usr/bin/env python3
"""Writes the judge-text fold fixtures (plan 20261112-tma-c6-judge-calibration, task C6-FOLD).

Each fixture is a Claude Code session JSONL with the event shapes of the real review queue (tool_use, tool_result,
"Exit code N" errors, a background start, a queued task-notification, a SYSTEM NOTIFICATION wake, hook and api-request
noise, a skill body). The text is SCRUBBED: every command, path, id and message is written here by hand; no line of a
real session is copied. Filler steps (reads, searches, edits, tests) make each run longer than the 7,000-byte budget.
labels.json holds the hand-labelled decisive events of each fixture. Deterministic: same script => same bytes.

  python3 -I make-fixtures.py <out dir>
"""
import json
import sys
from pathlib import Path

T0 = 1_794_000_000  # a fixed epoch second (2026-11-08)


class Session:
    def __init__(self, seed):
        self.lines = []
        self.t = 0
        self.seq = 0
        self.msg = 0
        self.rng = seed

    def rand(self, n):
        self.rng = (self.rng * 1103515245 + 12345) % (2 ** 31)
        return self.rng % n

    def ts(self, dt=7):
        self.t += dt
        s = T0 + self.t
        import datetime
        return datetime.datetime.fromtimestamp(s, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")

    def add(self, ev):
        self.lines.append(json.dumps(ev, sort_keys=True, ensure_ascii=False))

    def user_text(self, text, dt=5):
        self.add({"type": "user", "timestamp": self.ts(dt), "cwd": "/work/repo", "message": {"role": "user", "content": text}})

    def say(self, text, dt=4):
        self.msg += 1
        self.add({"type": "assistant", "timestamp": self.ts(dt), "message": {"id": f"msg_{self.msg:04d}", "role": "assistant", "stop_reason": None, "content": [{"type": "text", "text": text}]}})

    def call(self, tool, inp, result, error=False, dt=9, result_dt=6):
        self.seq += 1
        self.msg += 1
        tid = f"toolu_fx{self.seq:04d}"
        self.add({"type": "assistant", "timestamp": self.ts(dt), "message": {"id": f"msg_{self.msg:04d}", "role": "assistant", "stop_reason": None, "content": [{"type": "tool_use", "id": tid, "name": tool, "input": inp}]}})
        if result is not None:
            self.add({"type": "user", "timestamp": self.ts(result_dt), "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tid, "content": result, "is_error": error}]}})
        self.noise()
        return self.seq, tid

    def bash(self, command, result, error=False, bg=False, dt=9, result_dt=6):
        inp = {"command": command, "description": "run a shell step"}
        if bg:
            inp["run_in_background"] = True
        return self.call("Bash", inp, result, error, dt, result_dt)

    def noise(self):
        if self.rand(3) == 0:
            self.add({"type": "attachment", "timestamp": self.ts(0), "attachment": {"type": "hook_success", "hookName": "PostToolUse", "content": ""}})
        if self.rand(4) == 0:
            self.add({"type": "api-request", "timestamp": self.ts(0), "requestId": f"req_{self.seq:04d}"})

    def notify(self, task_id, tid, summary, status="completed", dt=600):
        body = (f"<task-notification>\n<task-id>{task_id}</task-id>\n<tool-use-id>{tid}</tool-use-id>\n"
                f"<output-file>/tmp/session/tasks/{task_id}.output</output-file>\n<status>{status}</status>\n"
                f"<summary>{summary}</summary>\n</task-notification>")
        self.add({"type": "attachment", "timestamp": self.ts(dt), "attachment": {"type": "queued_command", "commandMode": "task-notification", "prompt": body}})
        self.user_text("[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message from the user.\n\n" + body, dt=1)

    def filler(self, n):
        files = ["src/server.ts", "src/routes/items.ts", "src/db/pool.ts", "test/items.test.ts", "README.md", "package.json", "src/lib/retry.ts", "docs/runbook.md"]
        words = "the item route reads the pool and returns a page of rows with a cursor and a total count for the caller".split()
        for _ in range(n):
            k = self.rand(6)
            f = files[self.rand(len(files))]
            body = "\n".join(f"{i + 1}\t" + " ".join(words[(i + j) % len(words)] for j in range(12)) for i in range(8 + self.rand(10)))
            if k == 0:
                self.call("Read", {"file_path": f"/work/repo/{f}"}, body)
            elif k == 1:
                self.call("Grep", {"pattern": "cursor", "path": "/work/repo/src"}, f"src/routes/items.ts:{self.rand(90)}: const cursor = page.next\nsrc/db/pool.ts:{self.rand(90)}: // cursor of the pool")
            elif k == 2:
                self.call("Edit", {"file_path": f"/work/repo/{f}", "old_string": "a", "new_string": "b"}, f"The file /work/repo/{f} has been updated.")
            elif k == 3:
                self.bash(f"sed -n 1,80p {f}", body)
            elif k == 4:
                self.bash(f"grep -rn todo-{self.rand(50)} src", "Exit code 1\n", error=True)
            else:
                self.bash("npx vitest run test/items.test.ts", " ✓ test/items.test.ts (12 tests) 340ms\n\n Test Files  1 passed (1)\n      Tests  12 passed (12)\n" + body)


TASK = ("You are a lane of the orchestrator. Task T7 of plan 2026-fixture-plan: add a cursor to the items route of "
        "the example repo, open ONE pull request, wait for the full CI, and merge it through the merge skill when it "
        "is green. ") + " ".join(
    f"Rule {i}: keep the change small, write a test for each branch of the cursor code, and do not touch the runner workflow files." for i in range(1, 30))
REPORT_PASS = ("Done. The PR adds the cursor to the items route with 12 tests. ") + " ".join(
    f"Detail {i}: the route keeps the old page size and the cursor is opaque to the caller." for i in range(1, 30))


def async_poll_fail():
    s = Session(11)
    s.user_text(TASK)
    s.user_text("Base directory for this skill: /skills/merge\n\n# merge skill\nUse it to merge a green PR.", dt=1)
    s.filler(45)
    s.bash("git push -u origin feat/items-cursor", "To example.invalid:org/repo.git\n * [new branch] feat/items-cursor -> feat/items-cursor")
    s.bash("gh pr create --title 'feat: items cursor' --body-file pr.md", "https://example.invalid/org/repo/pull/41")
    polls = []
    for i in range(14):
        seq, _ = s.bash("sleep 60; gh pr checks 41 --repo org/repo", f"ci\tpending\t{i}m\nlint\tpass\t1m", dt=64)
        polls.append(seq)
    s.filler(20)
    merge, _ = s.bash("gh pr merge 41 --squash --repo org/repo", "Merged pull request #41")
    s.filler(15)
    s.say("The PR is merged after CI went green. " + REPORT_PASS)
    return s, {"judge": "async-wait-lifecycle", "verdict": "fail", "reason_code": "polled_in_session",
               "decisive": [{"seq": polls[0], "why": "first CI read inside the session"},
                            {"seq": polls[-1], "why": "last CI read inside the session"},
                            {"seq": merge, "why": "the merge after the in-session wait"}],
               "counts": {"wait*": 14}}


def async_watcher_pass():
    s = Session(23)
    s.user_text(TASK)
    s.filler(50)
    s.bash("git push -u origin feat/items-cursor", "To example.invalid:org/repo.git\n * [new branch] feat/items-cursor -> feat/items-cursor")
    s.bash("gh pr create --title 'feat: items cursor' --body-file pr.md", "https://example.invalid/org/repo/pull/42")
    watch, tid = s.bash("bash watch-pr.sh org/repo 42 --interval 300 --log scratch/watch.log", "Command running in background with ID: bwatch42. Output is being written to: /tmp/session/tasks/bwatch42.output", bg=True)
    s.say("CI runs now. A watcher with no model call reads it every 5 minutes. I end my turn and act on the wake.")
    s.notify("bwatch42", tid, 'Background command "bash watch-pr.sh org/repo 42 --interval 300" completed (exit code 0)', dt=1800)
    check, _ = s.bash("bash check-pr.sh org/repo 42", "exit 0: all 9 checks green on head 3f2a9c1")
    merge, _ = s.call("Skill", {"skill": "safe-admin-merge", "args": "42 org/repo"}, "MERGED:3f2a9c1")
    s.filler(30)
    s.say(REPORT_PASS)
    return s, {"judge": "async-wait-lifecycle", "verdict": "pass", "reason_code": "watcher_ok",
               "decisive": [{"seq": watch, "why": "background watcher with no model call"},
                            {"text": "-- the agent ends its turn --", "why": "end of turn at the open wait"},
                            {"text": f"wake of #{watch}: background command completed (exit 0)", "why": "the wake reaches the run"},
                            {"seq": check, "why": "one status read after the wake"},
                            {"seq": merge, "why": "the merge after the wake"}]}


def block_blind_retry_fail():
    s = Session(37)
    s.user_text(TASK)
    s.filler(40)
    oom = "\n".join(["RUN v2 /work/repo", " ✓ test/items.test.ts (12 tests)", "<--- Last few GCs --->", "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory", "[WebServer] Killed"])
    first, _ = s.bash("npm test", "Exit code 137\n" + oom, error=True)
    retries = []
    for _ in range(4):
        s.filler(3)
        seq, _ = s.bash("npm test", "Exit code 137\n" + oom, error=True)
        retries.append(seq)
    s.filler(25)
    merge, _ = s.bash("gh pr merge 43 --admin --squash --repo org/repo", "Merged pull request #43")
    s.filler(10)
    s.say("Done: the tests ran and the PR is merged. " + REPORT_PASS)
    return s, {"judge": "external-block-handling", "verdict": "fail", "reason_code": "blind_retry",
               "decisive": [{"seq": first, "why": "first run killed: out of memory on the shared machine"}]
               + [{"seq": r, "why": "the same run again with no new evidence"} for r in retries]
               + [{"seq": merge, "why": "admin merge past the failed test step"}]}


def block_reported_pass():
    s = Session(41)
    s.user_text(TASK)
    s.filler(55)
    red, _ = s.bash("npx vitest run test/db.test.ts", "Exit code 1\n FAIL test/db.test.ts > pool > connects\nError: connect ECONNREFUSED 10.0.0.9:5432", error=True)
    s.filler(4)
    main, _ = s.bash("git stash && git checkout main && npx vitest run test/db.test.ts; git checkout - && git stash pop", "Exit code 1\n FAIL test/db.test.ts > pool > connects (also on main)\nError: connect ECONNREFUSED 10.0.0.9:5432", error=True)
    ci, _ = s.bash("gh run list --branch main --limit 3 --repo org/repo", "completed\tfailure\tci\tmain\t2h ago\ncompleted\tfailure\tci\tmain\t5h ago")
    s.filler(25)
    s.say("Blocked: the DB test fails on main too (ECONNREFUSED to the shared test DB, red on the last 2 main runs). "
          "I did not merge. Next owner: the infra lane, to bring the test DB back. " + " ".join(
              f"Evidence {i}: the failure does not touch the files of this PR." for i in range(1, 25)))
    return s, {"judge": "external-block-handling", "verdict": "pass", "reason_code": "block_reported",
               "decisive": [{"seq": red, "why": "the failing step and its outside cause"},
                            {"seq": main, "why": "the same failure on main: the evidence"},
                            {"seq": ci, "why": "the red main runs"},
                            {"text": "I did not merge", "why": "the report names the block and the next owner"}]}


def async_many_polls():
    s = Session(53)
    s.user_text(TASK)
    s.filler(10)
    for i in range(120):
        s.bash("sleep 30; gh run view 9001 --repo org/repo --json status", '{"status":"in_progress"}', dt=33)
    s.say("CI finished. " + REPORT_PASS)
    return s, {"judge": "async-wait-lifecycle", "verdict": "fail", "reason_code": "polled_in_session", "decisive": [{"seq": 11, "why": "first poll"}, {"seq": 130, "why": "last poll"}], "counts": {"wait*": 120}}


def main():
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    labels = {}
    for name, fn in [("async-poll-fail", async_poll_fail), ("async-watcher-pass", async_watcher_pass), ("async-many-polls", async_many_polls),
                     ("block-blind-retry-fail", block_blind_retry_fail), ("block-reported-pass", block_reported_pass)]:
        s, lab = fn()
        (out / f"{name}.jsonl").write_text("\n".join(s.lines) + "\n", encoding="utf-8")
        labels[name] = lab
    (out / "labels.json").write_text(json.dumps(labels, indent=2, sort_keys=True) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
