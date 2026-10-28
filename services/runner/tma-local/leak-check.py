#!/usr/bin/env python3
"""Leak check of the tma-local image (plan 20261026-tma-local-runner-and-self-declared-results, L10).

Reads `docker export <container>` as a tar stream on stdin (nothing is written to disk) and fails when:
- a forbidden path is in the image (apps/, db/, scripts/, the DB CA bundle, a .env file, a keypair, a
  private SSH key), or
- a file under /app or /home holds a secret shape (OpenRouter / GitHub / AWS / Slack token, a private
  key block, a JWT, a postgres URL with a password).

Usage:
  docker export "$cid" | python3 leak-check.py          # the final file system
  docker save "$image" | python3 leak-check.py --layers # EVERY layer (a file deleted by a later layer still counts)
  python3 leak-check.py --self-test      # mutation proof: a planted key and a planted path must fail
"""
import io
import re
import sys
import tarfile

FORBIDDEN_PATHS = [
    re.compile(r"^app/(apps|db|scripts|tools|mcp|graders|\.github)(/|$)"),
    re.compile(r"(^|/)\.env(\.(?!example$)[^/]*)?$"),
    re.compile(r"keypair[^/]*\.json$"),
    re.compile(r"(^|/)id_(rsa|ed25519|ecdsa)$"),
    re.compile(r"supabase-pooler-ca-bundle\.pem$"),
    re.compile(r"^home/[^/]+/\.config/tma/session\.json$"),
]

SECRET_SHAPES = [
    ("openrouter key", re.compile(rb"sk-or-v1-[0-9a-f]{32,}")),
    ("anthropic/openai key", re.compile(rb"sk-(ant|proj)-[A-Za-z0-9_-]{20,}")),
    ("github token", re.compile(rb"(ghp|gho|ghs|ghu)_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,}")),
    ("aws key", re.compile(rb"AKIA[0-9A-Z]{16}")),
    ("slack token", re.compile(rb"xox[abps]-[0-9A-Za-z-]{10,}")),
    ("private key block", re.compile(rb"-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----")),
    ("jwt", re.compile(rb"eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}")),
    ("postgres url with password", re.compile(rb"postgres(ql)?://[^:/\s'\"]+:[^@\s'\"$<{]{6,}@")),
]

# Content scan roots. /usr and /etc are the Debian and Node base layers (pinned by digest), not ours.
SCAN_ROOTS = ("app/", "home/", "root/", "tmp/")
MAX_BYTES = 4 * 1024 * 1024

# Third-party test fixtures with fake key shapes, matched by path. Keep this list short, with a reason.
ALLOWED_FINDINGS = [
    # (path regex, shape name)
    # The README of the `pg` packages shows example connection strings (user:password@host).
    (r"^app/node_modules/pg[a-z-]*/README\.md$", "postgres url with password"),
]


def allowed(path, shape):
    return any(re.search(p, path) and s == shape for p, s in ALLOWED_FINDINGS)


def scan(fileobj):
    findings = []
    with tarfile.open(fileobj=fileobj, mode="r|*") as tar:
        for m in tar:
            path = m.name.lstrip("./")
            for rx in FORBIDDEN_PATHS:
                if rx.search(path):
                    findings.append(f"forbidden path: /{path}")
            if not m.isfile() or not path.startswith(SCAN_ROOTS) or m.size > MAX_BYTES:
                continue
            data = tar.extractfile(m).read()
            for name, rx in SECRET_SHAPES:
                if rx.search(data) and not allowed(path, name):
                    findings.append(f"{name}: /{path}")
    return findings


def scan_layers(fileobj):
    """`docker save` output: scan each layer tar on its own, so a file removed by a later layer is still seen."""
    findings, layers = [], 0
    with tarfile.open(fileobj=fileobj, mode="r|*") as outer:
        for m in outer:
            if not m.isfile() or m.size < 1024:
                continue
            data = outer.extractfile(m).read()
            try:
                inner = scan(io.BytesIO(data))
            except tarfile.TarError:
                continue  # a manifest or a config blob, not a layer
            layers += 1
            findings += [f"layer {m.name}: {f}" for f in inner]
    return findings, layers


def tar_of(files):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        for name, content in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(content)
            tar.addfile(info, io.BytesIO(content))
    buf.seek(0)
    return buf


def self_test():
    clean = tar_of({"app/services/runner/src/a.ts": b"export const x = 1;\n", "app/.env.example": b"A=\n"})
    assert scan(clean) == [], scan(clean)
    planted = {
        "app/services/runner/src/k.ts": b"const k = 'sk-or-v1-" + b"0" * 64 + b"';\n",
        "app/apps/api/certs/supabase-pooler-ca-bundle.pem": b"x",
        "app/.env": b"A=1\n",
        "home/tma/.config/tma/session.json": b"{}",
        "app/db/url.txt": b"postgresql://postgres:hunter2hunter2@db.example.com:5432/postgres",
    }
    got = scan(tar_of(planted))
    for needle in ("openrouter key", "certs", "/app/.env", "session.json", "postgres url"):
        assert any(needle in f for f in got), (needle, got)
    print(f"self-test ok: clean tar passes, planted tar gives {len(got)} findings")


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        self_test()
        sys.exit(0)
    if "--layers" in sys.argv:
        found, n = scan_layers(sys.stdin.buffer)
        print(f"scanned {n} layers")
    else:
        found = scan(sys.stdin.buffer)
    if found:
        print("LEAK CHECK FAILED:", file=sys.stderr)
        for f in found:
            print(f"  {f}", file=sys.stderr)
        sys.exit(1)
    print("leak check ok: no forbidden path, no secret shape under /app /home /root /tmp")
