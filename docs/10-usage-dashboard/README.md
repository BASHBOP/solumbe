# Usage & Performance Dashboard

`solumbe dashboard` turns a local, opt-in usage log into a single self-contained
HTML page that answers two questions: **how is solumbe being used**, and **how
well is it performing**. The dashboard needs no server or account. Its local
capture remains separate from optional anonymous usage sharing.

It is the observability companion to the trust layer: the same local-first,
deterministic discipline applied to solumbe's own usage.

## Quick start

```bash
solumbe telemetry on          # opt in (off by default)
solumbe context "add a tool" --path .
solumbe gate .
solumbe dashboard             # writes .solumbe/dashboard.html
```

To help improve Solumbe, a developer can make a second, explicit choice:

```bash
solumbe telemetry share on    # enables local capture and anonymous sharing
```

This is never enabled by installation, `init`, local telemetry consent, or an
upgrade.

Open `.solumbe/dashboard.html` in any browser. It works straight off disk
(`file://`), offline.

## What it shows

| Panel | Reads |
| --- | --- |
| Invocations / latency tiles | run counts and wall-clock duration per command and MCP tool |
| Token savings vs naive | the latest `solumbe eval` byte-ratio delta against a whole-file baseline |
| Gate pass rate / verdict mix | `PASS` / `WARN` / `FAIL` outcomes from `gate`, `pass`, and `review` |
| Convergence over time | `solumbe converge` scores (intent vs diff) as a trend |
| Recent artifacts / commits | existing `.solumbe/*.json` reports and recent git history |

Every tile and chart carries an interpretation tooltip, and a **"what this can't
show"** panel keeps the coverage gaps explicit (latency only for runs after
telemetry was enabled; signals only for commands that emit them; the
naive-savings number is a relative cross-build delta, not an absolute guarantee).

## Privacy & determinism

- **Off by default.** Capture is gated by the `telemetry` config key or the
  `SOLUMBE_TELEMETRY` env var, and is forced off under CI unless explicitly
  opted in. There is no `init`-time nudge: you turn it on manually.
- **Local by default.** Events append to `~/.solumbe/usage.jsonl`. The derived
  HTML lives under the repo's gitignored `.solumbe/`. This local log is not sent.
- **Sharing is separate.** `solumbe telemetry share on` sends a smaller event
  through Solumbe's public relay. Existing `telemetry: true` configurations remain
  local-only.
- **Shape, not content.** Each event records the command name, the *shape* of its
  arguments (key names only, never flag values, paths, or queries), latency,
  outcome, and the value signals the command already produced. Error text is
  reduced to a code/class (e.g. `ENOENT`), never the raw message.
- **Gate runs carry what a follow-up join needs.** A gate verdict or convergence
  score also records each check's status under its name, whether the gate was
  local or a pull request, and three 12-character hashes: of the repository
  root, of the changed-file set, and of the request. `solumbe calibrate
  --follow-through` reads them to say how often a warning had cleared on the
  next run. They stay in the local log and are not part of what sharing sends.
- **Never on a deterministic channel.** Telemetry is a side file. It is never
  written to stdout or the MCP JSON-RPC stream, and wall-clock timestamps never
  feed a token estimate or a convergence receipt, enforced by a test that
  asserts `--json` and MCP output are byte-identical with telemetry on vs off.

### What anonymous sharing sends

Shared events contain only a random installation ID, CLI or MCP surface,
command name, outcome, coarse duration bucket, Solumbe version, Node major
version, operating-system family, and schema version. The random ID is created
only after opt-in and stored at `~/.solumbe/anonymous-id`.

Shared events never contain prompts, argument values or shapes, paths,
repository names or hashes, source content, errors, receipt IDs, result data,
Git metadata, usernames, or email addresses. The relay is rate-limited and
reconstructs the OpenPanel event from an allowlisted DTO. Its server credential
is not present in the public npm package.

## Commands

```bash
solumbe telemetry status        # show state, log location, size, event count
solumbe telemetry on | off      # toggle capture (writes the config key)
solumbe telemetry share on | off # toggle anonymous sharing separately
solumbe telemetry clear         # delete the local usage log
solumbe dashboard [<repo>] [--out file] [--json] [--clear] [--no-artifacts] [--no-git]
```

The repo grouping key in each event is a one-way hash of the repository root: it
is non-reversible, but **confirmable** against a candidate path: it groups runs,
it is not anonymity.
