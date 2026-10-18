# Model Routing

> Why solumbe can ask a model for a probability without becoming probabilistic.

Some questions about a coding task have no answer in repository state. How
precisely a request names what has to change, and how far the edits it implies
will reach, are properties of the sentence rather than of the code. solumbe has
never read a request as language, so it cannot answer them.

The question this document answers is whether solumbe can spend a calibrated
model on that half without giving up what makes it trustworthy.

The answer is yes, and the reason is a boundary rather than a compromise: the
model is asked **before** work starts, about how much model to spend, and
nothing it says can reach the gate that decides whether a change may merge.

The calibrated model used here is a System One model
([announcement](https://typesafe.ai/blog/introducing-system-one-models-and-jev),
[concepts](https://docs.typesafe.ai/concepts/system-one)), which takes typed
questions and returns probabilities trained against outcomes rather than prose
to be parsed. The reverse direction, grading solumbe's own signals against
history, is in the [calibration](../17-calibration-thesis/README.md) page.

## The boundary, this does not weaken the gate

solumbe's three standing promises are that the gate is a pure function of
repository state, that it needs no network, key or vendor, and that every number
it reports can be traced to a measurement. A vendor model call inside the gate
would break all three at once.

The router is not in the gate.

| | Router | Gate |
| --- | --- | --- |
| Runs | **before** work starts | **after** the diff exists |
| Decides | how much model to spend | whether the change may merge |
| Depends on | a network call that may fail | repository state only |
| Worst failure | wrong model tier, money wasted | never reached by this path |

Nothing the router says can make a change pass. If Jev is down, unreachable or
unkeyed, the router falls back to a local estimate and says so in
`jev.source`; the gate does not notice, because the gate never asks. The code
enforces the separation physically: the router lives in `scripts/`, imports
solumbe's libraries read-only, and writes nothing any gate reads.

So it does not violate solumbe. It extends it, in the direction the calibration
thesis already pointed: solumbe's signals get a second consumer, and the router's
tier becomes one more number that has to be graded against outcomes rather than
asserted. What follows is largely the record of that grading going badly at
first, which is the point.

## How we use Jev

Jev is a System One model: it takes a **state**, takes **typed questions**, and
returns typed answers with calibrated probabilities. It does not write prose and
we never ask it to. One call, `POST https://api.typesafe.ai/v1/systemone`,
answers every question in parallel against one state.

### The state is solumbe's output

The first thing we send is not the prompt. It is the prompt **plus solumbe's
resolution of it**, the files solumbe believes the request touches, and why:

```json
{
  "request": "migrate the session cookie format in the auth middleware",
  "repository": { "name": "bashbop-event-application", "agent_experience": 62, "containment": 16 },
  "likely_files": [
    { "path": "redux/slices/auth-slice.ts", "kind": "state",
      "why": ["path matches: auth", "symbol matches: session"] }
  ],
  "risk_flags": ["auth/security"]
}
```

This is the join that makes the pairing worth anything. Jev has never seen the
repository; solumbe has never read the request as language. Each supplies what the
other cannot.

### Three questions, and why each one

| Question | Type | What it reads |
| --- | --- | --- |
| `specificity` | Score, 3 levels | How precisely the request names what must change |
| `blast_radius` | Score, 3 levels | How far the implied edits reach |
| `novelty` | Noul | Whether this needs new design or an existing pattern |

They are deliberately atomic. We never ask "which model should I use?", that is
a judgement with no ground truth to calibrate against, and it would hand control
flow to the model. We ask narrow questions, take the probabilities, and combine
them in code we can read. That is the [composite scoring](https://docs.typesafe.ai/patterns/composite-scoring)
pattern, and it is the same division of labour solumbe already draws between
evidence and verdict.

Score `criteria` is an **ordered list**, not an object, index 0 is level 0.
Noul answers carry no `confidence`, only Score and Choice do, so the router
reports each Score question's own confidence (`scoring.confidences`) and the
weaker of the two (`scoring.confidence`), for a reader. It is a display
threshold only, and not a routing input: a spread answer already pays through
its own score term, and reading confidence as a second input escalated 67% of
requests on this repository (see the solumbe dogfood below). The offline estimator
reports `null`: it has a shape, not a measurement.

### The arithmetic

Deterministic, in code, every term visible:

```
penalty = 0.25 x (specificity / 2)      each term takes a SHARE of AX,
        + 0.20 x (blast_radius / 2)     never a flat number of points,
        + 0.15 x P(novelty)             so the result stays on the AX scale
bonus   = 0.10 when containment >= 40
route   = clamp(AX x (1 - penalty + bonus), 0, 100)
tier    = route >= 75 cheap | >= 45 mid | < 45 premium
```

Then two fail-safe bumps, each moving **toward the more capable model and
never the other way**: a top-severity risk flag (anything solumbe already weights
3 in `RISK_SCORE_WEIGHTS`) moves one tier, and `no evidence` (solumbe matched no
files) goes straight to premium. Confidence below 0.55 used to be a third bump;
it was removed (see the solumbe dogfood below). A router that can round *down* on
a bad read is a router that ships bad changes cheaply.

When `no evidence` fires, `solumbe route` and the route prompt hook print **no
recommendation** instead of a tier, and name premium as the fail-safe. JSON
`tier` still reads `premium`, and `scoring.evidence.sufficient` is `false`, so
a caller can tell a decision from an absence.

Both bumps read evidence that has to be about shipped code. Tests and fixture
corpora still count toward reach, because they are real files the change touches, but
they never carry a risk flag. Routing solumbe itself is the case that shows why:
the repository has no checkout and no auth controller, so `add refund handling
to checkout` ranks `evals/fixtures/shop-api/.../checkout.service.ts` first and
used to escalate to premium on evidence from a corpus that ships nothing.

### What the call carries

Every call goes out under a `user-agent` of `solumbe/<version>`, so TypeSafe can
tell Solumbe's traffic from a hand-written client. The tag holds the client name
and version only: no user, no repository, no key. The body is the state
described above and the questions; file contents never leave the machine.

### Cost and latency

Jev bills input only, at $0.042/Mtok. Measured on this repository on 2026-09-26
against `jev-1.13.0`, with the request read folded into the same call: **2,059 to
2,165 input tokens, $0.000086 to $0.000091 per decision, 291 to 323 ms.** A
`context --online` read at the 24-file cap is 2,827 tokens, $0.000119 (below).
The pre-read figure this section used to print, 728 to 845 tokens, is 2.6× lower
than the call that ships today. The money is a rounding error against one
premium turn. Latency is the budget that binds, and solumbe's
own half costs more than Jev's, about 5s, because `generateAxScore` recomputes
the impact pass the router already ran. A real `solumbe route` should compute
impact once.

## Running it, any host, one contract

```bash
solumbe route <repo> "<request>" [--json|--tier-only|--host <id>] [--offline] [--out file]
```

The router decides a **tier**. Each host turns that tier into whatever it calls
a model, so nothing about the scoring is specific to one editor:

```bash
solumbe route . "$PROMPT" --tier-only          # -> premium
solumbe route . "$PROMPT" --host claude-code   # -> claude-opus-5-5
claude --model "$(solumbe route . "$PROMPT" --host claude-code)" -p "$PROMPT"
```

Only `claude-code` ships filled in, because those are the ids this repository
can verify. Add your own in `.solumbe/model-route.json` (repo) or
`~/.solumbe/model-route.json` (user):

```json
{ "hosts": { "cursor": { "cheap": "...", "mid": "...", "premium": "..." } } }
```

Hosts with no map still work through `--tier-only`. Terminal output uses solumbe's
own renderer, so `--color`, `--no-color`, `--theme`, `NO_COLOR` and a piped
stdout behave exactly as they do everywhere else in the CLI.

Set `TYPESAFE_API_KEY` in your shell to use the model. Without it, or with
`--offline`, the run falls back to a local heuristic and labels every surface
`offline estimate, not calibrated`. That heuristic scores; it does not claim a
confidence, so the offline path reports `confidence: not measured` and the
low-confidence bump does not fire. Before that was true, `distribute(0.6)`,
the baseline for any request the keyword lists do not recognise, peaked at
0.40, and reading that shape as confidence escalated every unknown request one
tier: the offline router's default was "spend more".

### The advisory footer

`solumbe ax` and `solumbe impact` already compute everything the repository half
needs, so both print one routing line under their normal output:

```
model route: premium (score 36) - offline estimate, advisory
```

That line is **offline by construction**. An ordinary solumbe command does not
make a network call, and a failure inside the router is swallowed rather than
allowed to change the output of the command you actually ran. `--json`,
`--out` and `--mermaid` are untouched, so nothing that parses solumbe's output
sees it; `--no-route` turns it off.

Reach for `solumbe route` when you want the model's read and the full arithmetic.

### Over MCP

The `model_route` tool is the same contract for any MCP host (Cursor, VS Code,
Claude Desktop, Codex, Gemini): `{ query, path?, host?, offline? }` in, the
`solumbe route --json` payload out. It calls Jev only when `TYPESAFE_API_KEY` is
in the server's environment and `offline` is not true, and it declares
`openWorldHint: true` because it may. Host configs are in
[MCP and Agent Workflows](../02-mcp-agent-workflows/README.md#realtime-canvas-and-model-routing-opt-in).

## The request read: the same call, three more questions

The route questions ask how hard a request is. Three more questions ask what it
_is_, and they ride the same call, because System One evaluates each question
independently against one state (TypeSafe's
[speculative fan-out](https://docs.typesafe.ai/patterns/fan-out)): more
questions cost input tokens, not round trips or context.

| Question | Type | Gate before anything acts on it |
| --- | --- | --- |
| `read_intent` | Choice over `add`, `fix`, `change`, `refactor`, `test`, `debug`, `review`, `explain` | confidence ≥ 0.5 |
| `read_capability` | Choice over the MCP tool catalog, plus `none` | confidence ≥ 0.5 |
| `read_file_<n>` | Noul per ranked file: would the work need this file? | demote only under 0.2 |

The floors follow TypeSafe's [confidence guidance](https://docs.typesafe.ai/confidence):
do not act under 0.5, and scale the bar with the consequence. Relabelling an
intent is cheap to get wrong; dropping a file from an agent's context is not,
so a file leaves only on a strong no.

**In `solumbe route`** the read is reported under `model.read` and in its own
section of the output, and `scoreDecision` never sees it: a test holds that the
same route answers score identically with and without it. The Claude Code prompt
hook adds a line for any answer that cleared its floor.

**In `solumbe context --online`** (MCP: `context_pack { online: true }`) the read
is applied, and nowhere else. The same questions run over the pack's primary and
related files:

- an accepted intent replaces solumbe's action word and withdraws the
  "requested action is ambiguous" open question;
- a file under 0.2 leaves the ranked lists, and its hotspots with it, and is
  kept under `modelRead.demoted` with its score and original rank;
- the remaining files are re-ranked by relevance, each carrying its original
  `rank`;
- a read that rejects every primary file is not applied to them. It says the
  candidates are wrong, not that the agent should read nothing, which is the
  same reasoning as the router's `no evidence` floor.

A pack is still a pure function of repository state unless `online` is asked
for, and a failed or unkeyed call returns solumbe's pack unchanged with the
reason under `modelRead`. Measured on this repository against a question whose
offline pack ranked an RSVP eval fixture as related to MCP integration: intent
`unknown` → `add` at 0.60, the fixture demoted at 0.17, `src/lib/mcp.js`
re-ranked first; 2,827 input tokens, $0.000119, 361 ms.

The read is now graded on a labelled corpus, and can come from Claude instead
of Jev (`SOLUMBE_READ_PROVIDER=claude`, or an Anthropic key with no TypeSafe
key): see [Grading the request read](../17-calibration-thesis/README.md#grading-the-request-read-2026-10-18).
`solumbe route` still asks Jev only, because the route questions are System One
questions. Like the tier, the read stays advisory.

### Routing every request, without pretending to switch the model

A skill only routes when the model remembers to invoke it, which means the
request most worth routing — a quick one — is the one least likely to trigger
it. `scripts/hooks/route-prompt.mjs` is a Claude Code `UserPromptSubmit` hook
that closes that half of the gap: it scores the request and returns the tier as
context, before any work starts, every time.

It is careful about what it claims, because the honest ceiling is low:

| | possible? |
| --- | --- |
| Route every request deterministically | **yes**, this hook |
| Name the model a subagent should run on | **yes**, as context the parent session may ignore |
| Hold a subagent to that model | **yes**, but only from a `PreToolUse` hook on the Agent tool, `scripts/hooks/enforce-agent-model.mjs` |
| Change the model this session runs on | **no** |

The last row is not a missing feature. No hook output carries a model:
`PreModelSwitch` may block a switch and `PostModelSwitch` is read-only, and the
app refuses to let a session re-price its own turns. Claiming the host switched
models when it only recommended a tier is an anti-pattern the skill names.

The second and third rows are different things, and an earlier version of this
section ran them together. The `UserPromptSubmit` hook's output is text in the
parent session's context. The Agent tool does take a `model`, but the parent
decides whether to pass it and which, and nothing the prompt hook prints sees
that call. So on its own the prompt hook **advises** the session and the
subagent alike. The binding is the second hook.

#### Holding the subagent to the routed tier

`scripts/hooks/enforce-agent-model.mjs` is a `PreToolUse` hook with the matcher
`Agent|Task`. Before an Agent call runs, it reads the decision the prompt hook
logged for the same session and prompt (by the host's `prompt_id`, else the
session's latest decision, so `go ahead` continues the request routed before
it) and compares the routed tier's alias (`haiku`, `sonnet`, `opus`) with the
call's `model`. A full id counts as its family: `claude-sonnet-5` is `sonnet`.

When the call's `model` is missing or names another tier, the hook **rewrites**
it: it returns `updatedInput` with the routed alias and every other field of
the call unchanged, because `updatedInput` replaces the whole input. It does
not deny. A deny costs a full turn for the parent to read the reason and send
the same call with one field changed, and a parent that ignored the advice can
ignore the reason too. The parent is told what happened through
`additionalContext`, so it does not report the subagent's model wrongly. The
rewrite goes out with `permissionDecision: "allow"`, because the host applies
`updatedInput` with `allow` or `ask` and `ask` would put a prompt in front of
every delegated call. A hook's `allow` does not override the user's own deny
or ask rules, which the host evaluates against the rewritten input.

It enforces in the **delegate arm only**, the arm the prompt hook recorded in
the decision (`SOLUMBE_ROUTE_MODE=delegate`, with
`SOLUMBE_ROUTE_DELEGATE_SHARE` of requests in the arm). The control arm and
plain advisory mode are observed and never changed. That keeps the trial a
trial: the delegate arm is "the router binds the subagent", the control arm is
"the parent was told", and the difference between them is the thing being
measured. Set the share to `1` to bind every routed request.

It does nothing when the route had no evidence (a fail-safe premium is never
enforced), when there is no decision for the session, when the call comes from
inside a subagent, or for any other tool. Like the prompt hook it never breaks
a call: every failure exits 0 with no output, which leaves the call as made.

Every Agent call that joins a decision leaves one line in
`~/.solumbe/agent-model-decisions.jsonl` (`SOLUMBE_AGENT_MODEL_LOG` moves it,
`off` keeps nothing): the session, the prompt id and hash it joins on, the
tool-use id, the arm, the routed and the requested model, and the action
(`matched`, `diverged` or `rewrote`). It never holds the prompt or the
subagent's brief. `route-outcomes` counts these per arm beside its grade (see
below), and a delegate arm whose calls all matched anyway was not bound by
anything.

#### Wiring

The repository commits both hooks in `.claude/settings.json`, by
repo-relative path only (`"$CLAUDE_PROJECT_DIR/scripts/hooks/…"`), so a
session in this repository gets them from the checkout it is working in. That
file holds nothing else: permissions, personal hooks and absolute paths stay in
`~/.claude/settings.json`, and `.claude/settings.local.json` and the rest of
`.claude/` stay ignored.

To route every repository, register the prompt hook in
`~/.claude/settings.json` as well, and the Agent hook beside it:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "node \"/path/to/solumbe/scripts/hooks/route-prompt.mjs\"", "timeout": 10 }]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Agent|Task",
        "hooks": [{ "type": "command", "command": "node \"/path/to/solumbe/scripts/hooks/enforce-agent-model.mjs\"", "timeout": 5 }]
      }
    ]
  }
}
```

In this repository that registers each hook twice under two command strings,
and the host runs both. Each hook claims its prompt (or its tool call) before
doing anything, in a file under the temp directory keyed by session and prompt
id, and the second run to arrive stands down, so a prompt is still routed and
logged once (`SOLUMBE_HOOK_CLAIMS_DIR` moves the claims).

Three properties it has to have, and the reason for each:

**It never eats a prompt.** Every failure path — unparseable stdin, a missing
CLI, a crash, a repository it cannot score — exits 0 and writes nothing. A
router that can swallow a request is worse than no router.

**It has a deadline.** The routing call is killed at 6 seconds
(`SOLUMBE_ROUTE_TIMEOUT_MS` sets another). A slow or huge repository costs the
hint, not the turn.

**It skips what is not work.** Turn-taking prompts (`ok`, `thanks`, `ship it`)
and slash commands route nothing, because spending seconds of latency to score
the word "ok" is a cost with no answer attached. Neither does what the harness
submits through `UserPromptSubmit` on its own: a finished background task
(`<task-notification>`), the desktop app's CI monitor (`<ci-monitor-event>`)
and the record of a `!` shell command with its output (`<bash-input>`). None
of them is a request, and the work that follows belongs to one that was
already routed. A `<system-reminder>` the harness puts in front of a prompt is
looked past, and what is behind it is judged like any other prompt. The filter
is deliberately permissive in the other direction: a skipped request loses a
hint, while a spurious one loses seconds, so anything ambiguous routes. That
includes the wrappers that carry a request: pasted content, the desktop app's
Create PR command, and a message from another session.

**A subagent never routes.** It was launched on a tier its caller already chose,
so re-routing would second-guess that, and a subagent that routes could launch a
subagent.

Keying is the same as `solumbe route`: with `TYPESAFE_API_KEY` set it asks Jev,
and without one it falls back to the offline estimate, which is weaker but free
and needs no network.

**It keeps its decision.** A tier printed as context is gone when the turn
ends, and a router can only be graded against decisions that were kept. So
every routed prompt leaves one line in `~/.solumbe/route-decisions.jsonl`
(`SOLUMBE_ROUTE_LOG` moves it, `SOLUMBE_ROUTE_LOG=off` keeps nothing). The line
never holds the prompt, only its hash, and never leaves the machine.

| Field | Why it is there |
| --- | --- |
| `sessionId`, `ts`, `promptHash`, `promptChars` | joins the decision to the prompt in the session transcript, which holds everything else: the prompts in order, interruptions, the assistant's edits |
| `repo`, `root`, `branch`, `head` | the head at prompt time names the change: the next commit on that branch whose first parent is `head`, for the `repaired` join later |
| `tiers`, `routes` per variant (`deterministic`, and `offline` or `jev`) | what each half of the router said; `solumbe route --json` now reports `deterministic` beside the scored tier |
| `signals`, `answers`, `modelRouteEngineVersion` | exactly what `solumbe regret --rescore` reads, so a live corpus re-tiers under a new arithmetic the way a frozen run does |
| `hostModel` | the model the session is told to launch a subagent on; the Agent hook binds it in the delegate arm |
| `promptId`, `evidenceSufficient` | what the Agent hook joins on, and whether it may enforce the tier at all |

The caveat the log does not remove: the tier the session ran on stays
unknown, and no hook can learn it.

`node scripts/hooks/route-outcomes.mjs` joins the log to the transcripts and
grades every variant per tier on two same-session outcomes, with regret's
minimum-sample rule and intervals: `corrected` (the next prompt inside the hour
is an interruption or opens by pushing back) and `reworked` (the assistant's
next turn edits a file this turn edited). Both were audited before they were
written, on twenty days of this machine's transcripts, and the audit is the
reason they carry the caveats they print; it is in the next section. Beside
the grade it counts the Agent hook's log per arm (`--agent-log` names another
file): calls, requests, calls that asked for the routed model, calls that
asked for another and were left alone, and calls that were rewritten. Only
calls that join a logged decision count, and `--arm` filters them too.

The log is one line per routed request, and for its first day it was not.
Claude Code delivers a finished background task through `UserPromptSubmit`,
and the hook routed it like a prompt. On 2026-09-27, 22 hours after the log
began, 79 of its 146 decisions were prompts the harness wrote: 75 task
notifications, 3 shell records and 1 CI monitor event, each matched by hash to
the queue record the harness keeps in the session transcript. A notice that
`yarn test` had finished was routed premium, with `data model` and
`auth/security` as its risk paths. Each one cost a hook run and put a routing
hint in front of a prompt nobody wrote.

| Prompt opened with | logged | harness prompt | now |
| --- | --: | --- | --- |
| `<task-notification>` | 75 | yes | skipped |
| `<bash-input>` | 3 | yes | skipped |
| `<ci-monitor-event>` | 1 | yes | skipped |
| `<system-reminder>`, then the prompt | 22 | no | routes on what is behind the reminder; 3 of the 22 were `yes` or a typo of `merged` and are now skipped as turn-taking |
| `<pasted_content>` | 5 | no | routes |
| `<create-pr-command>` | 2 | no | routes |
| `<cross-session-message>` | 1 | no | routes |
| no wrapper | 37 | no | routes |

`<command-name>`, `<command-message>`, `<local-command-stdout>` and
`<local-command-caveat>` fill the same transcripts and matched no decision:
they are how the transcript files a slash command, not what the hook is
handed, so the hook has no rule for them.

The hook skips harness prompts now. The rows it already wrote stay where they
are, because the log is append-only, and `route-outcomes` leaves them out. The
log holds a hash and never the prompt, so the grader hashes every harness
prompt it finds in a session's transcript, in the user records and in the
queue records, and a decision from that session with one of those hashes is
excluded and counted in the first line of the output (`excluded` under
`--json`). The queue matters: a harness prompt that arrives in the middle of a
turn is filed as an attachment and never becomes a user record, which was 33
of the 79, and the queue held all 79. In the transcript a harness prompt is no
longer a prompt or a follow-up either, so a finished background task does not
read as the user moving on without complaint.

On the same 146 rows the grader had joined 100 decisions and graded 78, and 36
of the 78 were harness prompts. It published two rates: deterministic cheap,
1.8% corrected on 55 requests, 21 of them harness prompts, and offline mid,
0.0% on 58, 36 of them harness prompts. Another 7 requests were graded only
because a harness prompt was read as their follow-up. With harness prompts
left out, 54 decisions join, 35 have a follow-up and every lane is under the
minimum sample, so nothing is published. Two limits remain. A decision whose
transcript is gone cannot be told from a prompt that was never recorded and
counts as not found, as it did before. And 13 routed requests do not join: 8
were typed in the middle of a turn, which the transcript files as an
attachment, 4 opened with a blank line that the hook hashed and the join
trims, and 1 came from another session. Evidence, hashes and counts only, in
`.solumbe/runs/2026-09-27/route-harness-prompts/`, local only.

## Dogfood, bashbop-event-web, 2026-09-19

Five requests drawn from the repository's own recent work, run against
`bashbop-event-application` v23.15.0 with Jev 1.13.0.

| Request | AX | spec | blast | novelty | conf | route | band | tier |
| --- | --: | --: | --: | --: | --: | --: | --- | --- |
| fix the typo in the publish confirmation copy | 59 | 1.21 | 0.04 | 0.06 | 0.66 | 49 | mid | **mid** |
| show organisers what happens after they publish | 74 | 1.27 | 1.61 | 0.35 | 0.41 | 54 | mid | premium |
| add a `--json` flag to the seating export | 57 | 0.55 | 1.39 | 0.36 | 0.09 | 42 | premium | premium |
| the booking fee is wrong for free events | 57 | 1.76 | 1.60 | 0.14 | 0.41 | 34 | premium | premium |
| migrate the session cookie format in the auth middleware | 62 | 0.97 | 1.68 | 0.41 | 0.53 | 40 | premium | premium |

Run twice against the same corpus, Jev's answers moved by up to 0.05 and
confidence by up to 0.06. **No tier changed between the two runs.** The router is
not deterministic and is not claimed to be; it only has to be stable enough that
the same request does not oscillate between tiers, and across two runs it was.
Determinism is the gate's property, not the router's.

The first run of this corpus put **all five** at premium, which is the same as
having no router at all. Four defects came out of it, every one found by running
the thing rather than reasoning about it:

**1. A saturated question carries no information.** `specificity` began life as a
Noul, *"is this ambiguous enough that a wrong reading produces the wrong
change?"* Jev answered 0.57 to 0.81 for all five prompts, including the typo fix.
That is the correct answer: for any one-line request, yes. The question could
not separate the corpus, so its probabilities were noise however well
calibrated. Re-specified as a Score over levels you can point at in the text -
names the target / names an area / names a symptom, it discriminates: 0.59 for
the `--json` flag, 1.76 for the bug hunt. **Measure a question's variance before
trusting its weight.**

**2. State quality decides the answer.** The first run sent the prompt and four
numbers. Grounding the state in solumbe's ranked file evidence changed every
answer. Jev cannot tell whether "the publish confirmation copy" is specific
without seeing what the phrase resolves to.

**3. Reusing a signal double-counts it.** The offline estimator derived
`blast_radius` from `containment`, which is already inside AX at weight 0.30.
In a low-containment repository (bashbop-event-web sits at 11 to 26 throughout)
every prompt was penalised twice and pinned at blast 1.86. Keeping the model on
the request side and solumbe on the repository side is not a style preference; it
is what stops the double count.

**4. AX's bands do not belong to a non-AX quantity.** The 45/75 thresholds were
inherited from the model-router skill, where they band **AX itself**. The route
score was AX minus up to 52 flat points, a different quantity on a different
scale, so applying AX's bands to it was a category error. That is what pinned
the whole corpus below 45. The fix is not a nicer set of numbers: each term now
takes a **share of AX** rather than a flat count of points, so the route score
means "AX, after what this request costs" and stays on the scale its bands were
drawn for. Same Jev answers, rescored: 34 to 53, and the typo fix separates from
the bug hunt.

No request in this corpus reaches `cheap`. That is a true statement about
bashbop-event-web rather than a routing failure: with no CODEOWNERS file and
containment between 11 and 26, its AX tops out at 74, and `cheap` starts at 75.
The router cannot recommend a cheap model for a repository whose own shape says
changes there are not cheap.

A fifth issue, fixed in passing: classifying only the owner and supporting
buckets meant `redux/slices/auth-slice.ts`, ranked **first** for the auth
prompt, sat in the advisory bucket and the `auth/security` bump never fired.
Classifying everything instead made an unrelated billing component turn a copy
change into a money-flow change. The router now classifies owners, supporting
files, and the top three ranked predictions whatever bucket they landed in: rank
is evidence, the bucket is a label.

## Dogfood, solumbe, 2026-09-20

The corpus above was measured against `bashbop-event-web`, whose AX tops out at
74. Run against **this** repository, the same router escalated 67% of requests
and put six of nine on the premium tier.

| request | route | confidence | before | after |
| --- | --- | --- | --- | --- |
| fix a typo in the README | 54 | 0.79 | mid | mid |
| sort the imports in `src/lib/ax.js` | 61 | 0.77 | mid | mid |
| rename the variable `running` to `score` | 68 | 0.54 | **premium** | mid |
| add a `--quiet` flag to the doctor command | 50 | 0.34 | **premium** | mid |
| fix the off-by-one in the impact top-N slice | 60 | 0.39 | **premium** | mid |
| add a retry with backoff to the auth token refresh | 78 | 0.00 | **mid** | cheap |
| extract the render helpers into their own module | 50 | 0.26 | **premium** | mid |
| redesign how the gate decides merge readiness | 44 | 0.74 | premium | premium |
| add multi-tenant permissions to the whole MCP surface | 59 | 0.43 | **premium** | mid |

One defect, and it is another instance of the same lesson: **do not charge for
the same uncertainty twice.**

`confidence` was `Math.min` of both Score answers, and a value under the floor
bumped a tier. Two things were wrong with that.

It **discarded the confident answer.** Take `rename the variable running to
score in model-route.js`. Jev put the entire distribution — 1.00, confidence
1.00 — on *"the request names the exact file, symbol, flag or user-visible
string to change"*, which is exactly what that sentence does. `blast_radius`
put 0.80 on *"contained to a single file"* at confidence 0.54. Both answers say
trivial. The minimum kept 0.54, missed the floor by one hundredth, and routed a
one-file rename to the premium tier. A perfectly certain answer had no effect on
its own tier because a second question was a hundredth less sure.

It **double-counted.** `score` is the expectation over that question's own level
distribution, so a spread answer already pays through its own term — 1.56 out of
2 on blast radius, for the `--quiet` flag, is most of a −20% share. Bumping a
tier on the spread as well charged for it twice.

The fix is to leave confidence where it belongs: each answer's uncertainty is
priced into that answer's own term, and confidence is reported for a reader
rather than read by the router. Same Jev answers, rescored: escalation 67% → 0%,
premium 6/9 → 1/9.

The remaining bumps — `no evidence` and `risk path` — are solumbe's own
deterministic repository signals, which is the half of this pairing that is
entitled to overrule a model. A vendor's self-reported certainty is not.

The auth request moving to `cheap` is that division working, not a hole in it:
`risk path` did not fire because this repository has no auth code for solumbe to
match. In a repository that has some, the flag fires on repository evidence.

What this run does **not** fix: the route score still separates the corpus
poorly. An auth retry (78) reads as cheaper than sorting imports in one file
(61), and a README typo (54) reads as more expensive than both. That is question
quality and AX dominance, not the confidence defect, and it is unmeasured
against outcomes like everything else below.

## What is not true yet

The weights and the bands were chosen by judgement and have never been compared
to an outcome. That is exactly the sentence [the calibration thesis](../17-calibration-thesis/README.md)
writes about `inferRisk`, and it applies here with no discount:

> A risk level that has never been compared to an outcome is a heuristic wearing
> a number.

So the router ships **advisory**: it prints a decision and a recommended tier,
and it does not pick a model for you. Promoting it past advisory needs the same
treatment `solumbe calibrate` gives the gate: replay the repository's history,
recompute the tier from the state as it was, and join to outcomes. The metric is
not accuracy. It is **regret**: a change routed cheap that was repaired, by a
fix or a revert, within the outcome window. It is never a saving, because solumbe
does not know whether a host switched models.

`solumbe regret <repo>` runs that backtest. For each commit that is neither a
fix nor a release (a `chore(release): 2.26.5 [skip ci]`, a `chore: bump version
to 1.4.0`: tooling wrote it, so no router saw a request) it checks the
parent tree out into a temporary worktree, scores the commit subject as the
request, and grades three tiers side by side: the deterministic half alone (AX,
containment and the bumps, every model term at zero), the shipped offline
heuristic, and the Jev read when a key is present. The deterministic tier is
the cheapest the router can give a request, since a model read can only move
it toward premium. Outcomes are the same line-overlap `repaired` join calibrate
uses, with the same minimum-sample rule applied to every published rate, the
base rate included; each rate carries a Wilson 95% interval, and two rates
whose intervals overlap are not shown to differ. A commit younger than the
window is censored rather than graded as unrepaired. Offline it is a pure
function of repository state with a receipt; with a key the model's answers
are not replayable and the receipt says so.

```bash
solumbe regret . --window 30 --max 150 --offline   # keyless, replayable
solumbe regret . --window 30 --max 150             # adds the jev variant on your key
```

### Measured, solumbe, 2026-09-26

The 150 most recent gradable non-fix commits of this repository (20 of them
docs-only), replayed against their parents; 47 younger commits censored, 30-day
window, minimum sample 30, `jev-1.13.0`. Receipts: `regret_4175d2b39031`
(offline, replayable) and `regret_40d8924d473b` (with the model; 150 calls,
$0.013, not replayable). Base rate: 17.3% of commits were repaired within the
window (26 of 150; 95% interval 12.1% to 24.2%).

| Variant | cheap | mid | premium | Ordered | Contradicted |
| --- | --- | --- | --- | --- | --- |
| deterministic | 120 · 17.5% (11.7 to 25.3) | 30 · 16.7% (7.3 to 33.6) | 0 | unknown | 21 of 120 (17.5%) |
| offline | 69 · 20.3% (12.5 to 31.2) | 81 · 14.8% (8.7 to 24.1) | 0 | unknown | 14 of 69 (20.3%) |
| jev | 34 · 14.7% (6.4 to 30.1) | 112 · 17.9% (11.9 to 26.0) | 4 · withheld | unknown | 5 of 34 (14.7%) |

Each cell is commits routed to that tier, the share of them repaired, and the
Wilson 95% interval. _Ordered_ asks whether cheap < mid < premium, and is only
claimed when every tier clears the minimum sample. _Contradicted_ is the regret
count: routed cheap, then repaired.

What it says, plainly:

- **No variant is shown to order outcomes.** Every interval overlaps every
  other, and no variant routes premium often enough to grade the top tier at
  all: the deterministic and offline halves never reach it, and the model read
  reaches it four times in 150.
- **The deterministic half is the base rate.** It puts four fifths of commits
  in the cheap lane, and those are repaired as often as the rest.
- **The offline heuristic runs the wrong way, within noise.** The commits it
  routed cheap were repaired more often than the ones it routed mid; the
  intervals overlap, so this is not a finding, but it is not a reason to trust
  the keyless tier either.
- **The model read runs the right way, within noise.** Its cheap lane has the
  lowest repair rate of the three (14.7%), and its answers now separate their
  inputs: specificity ranged 0.02 to 0.88 (stdev 0.13), blast radius 0.01 to
  0.97 (0.23), novelty 0.05 to 0.68 (0.17). But the arithmetic still funnels
  three quarters of commits into `mid`, so most of that spread never reaches
  the tier, and 34 cheap commits cannot show a difference this size.

This is the number the router had been missing, and it is why `route` stays
advisory, why no host integration turns it on by default, and why no partner
claim rests on it. The next change to the router is the arithmetic that turns
spread answers into a tier, and it is graded under the bar below before it
ships. One repository is not a sample of repositories; the caveats the command
prints apply in full.

### Grading the next arithmetic

Jev's answers are not replayable: run twice against the same corpus they moved
by up to 0.05. Two versions of the arithmetic graded on two runs therefore
differ in the arithmetic **and** in however far the model drifted between the
runs, and a change to the arithmetic cannot be told apart from noise in the
model. So each row of a regret run keeps the signals and the exact answers its
tiers were scored from, and `--rescore` applies the current arithmetic to a
saved run without checking anything out or calling anything:

```bash
solumbe regret . --json > run.json          # once, with the key: the answers are frozen here
solumbe regret --rescore run.json           # any number of times: this version's arithmetic, same answers
```

The rescore carries its own receipt, names the run it read in
`method.rescoredFrom`, and keeps that run's `replayable: false`: rescoring
does not make a model's answers reproducible, it only stops them from moving.
Runs saved before the rows kept their inputs (regret 0.2.0) are refused
rather than rescored on rounded answers, since a route one rounding from a
band edge changes tier.

**The bar, written before any candidate was scored.** A new arithmetic
replaces the shipped one only if, rescored on the frozen runs below:

1. **It orders outcomes.** On both bashbop repositories, for the `jev` and
   `offline` variants, every tier clears the minimum sample, cheap < mid <
   premium, and the cheap and premium intervals do not overlap.
2. **The model earns its call.** Under the current invariant a model read can
   only move a tier toward premium, so the model's cheap lane is a subset of
   the deterministic one. On both bashbop repositories the `jev` cheap lane is
   repaired less often than the deterministic cheap lane over the same rows.
   If it is not, the model is removing commits from the cheap lane without
   making it any cleaner.
3. **Regret does not rise.** On every frozen run, for both variants, the
   cheap lane's repair rate is no higher than the shipped arithmetic's on
   that run.
4. **Tune on two, confirm on one.** Candidates are compared on bashbop-api
   and solumbe. bashbop-event-web, the run with the most outcomes, is scored
   once, on the candidate chosen, and a failure there is a failure.
5. **Nothing it does not own moves.** The `no evidence` ceiling and the
   `risk path` bump are unchanged, `modelRouteEngineVersion` is bumped, and
   the change prints the before and after tables with both receipts.

**The frozen runs.** Each repository's whole history, replayed on 2026-09-26:
30-day window, minimum sample 30, `jev-1.13.0`, 2,385 answered calls and 2
failed, $0.20 in all. The runs are kept under `.solumbe/runs/`, outside the
repository, because two of the three are private and every row carries a
commit subject; the receipts identify them.

| Run | Graded | Base rate | Receipt |
| --- | --: | --- | --- |
| solumbe | 157 | 19.7% (14.3 to 26.7) | `regret_7d94fd0a73bd` |
| bashbop-api | 1,214 | 24.7% (22.4 to 27.2) | `regret_a4499a13f0ee` |
| bashbop-event-web | 1,016 | 46.9% (43.8 to 49.9) | `regret_9582de4ba43a` |

Rescored with the shipped arithmetic, every saved tier and route comes back
unchanged, 2,387 rows of 2,387. solumbe's run is too small to grade the top tier,
as in the section above. The two bashbop runs are not:

| Run | Variant | cheap | mid | premium | Ordered |
| --- | --- | --- | --- | --- | --- |
| bashbop-api | deterministic | 474 · 10.1% (7.7 to 13.2) | 312 · 19.6% (15.5 to 24.3) | 428 · 44.6% (40.0 to 49.4) | yes |
| bashbop-api | offline | 129 · 22.5% (16.1 to 30.4) | 546 · 10.1% (7.8 to 12.9) | 539 · 40.1% (36.0 to 44.3) | **no** |
| bashbop-api | jev | 186 · 4.8% (2.6 to 8.9) | 398 · 12.1% (9.2 to 15.6) | 630 · 38.6% (34.9 to 42.4) | yes |
| bashbop-event-web | deterministic | 233 · 33.5% (27.7 to 39.8) | 463 · 51.2% (46.6 to 55.7) | 320 · 50.3% (44.9 to 55.8) | no |
| bashbop-event-web | offline | 97 · 24.7% (17.2 to 34.2) | 425 · 46.1% (41.4 to 50.9) | 494 · 51.8% (47.4 to 56.2) | yes |
| bashbop-event-web | jev | 8 · withheld | 352 · 37.5% (32.6 to 42.7) | 656 · 52.1% (48.3 to 55.9) | unknown |

The shipped arithmetic fails criterion 1 twice (the keyless tier on
bashbop-api, the model tier on bashbop-event-web) and criterion 2 once
(bashbop-event-web). What that looks like:

- **The keyless tier runs the wrong way on bashbop-api, and it is not
  noise.** _Superseded the same day: the lane it moved out of `cheap` was
  release commits, see "Re-graded without release commits" below._ Its cheap lane is repaired 22.5% of the time and its mid lane
  10.1%, and the intervals do not overlap. Split the deterministic cheap lane
  by what the heuristic did with it: the 345 commits it moved out were
  repaired 5.5% (3.6 to 8.4) of the time, the 129 it kept 22.5%. It escalates
  the safe commits and keeps the risky ones cheap.
- **The model read orders bashbop-api, and its escalations are right.** Split
  the same way, the 288 commits it moved out of the cheap lane were repaired
  13.5% (10.1 to 18.0) of the time, the 186 it kept 4.8% (2.6 to 8.9). No
  model term in this document had been shown to separate outcomes before.
- **On bashbop-event-web the model read cannot be graded, because it almost
  never says cheap:** 8 commits of 1,016, against 656 premium. Its AX runs
  lower than bashbop-api's (median 66 against 80) and a typical read costs a
  little more of it (a median 31% of AX against 28%), so almost nothing
  clears the cheap band.
- **A shorter window hid the inversion.** Replayed over about the last year
  only (440 and 398 commits, since late September 2025), the keyless tier was
  ordered on both repositories. A tier that is ordered over one window and
  inverted over another is not yet a tier.

Neither split is printed by the command; both come from the rows the frozen
runs saved. The next arithmetic therefore has two jobs the bar can see: stop
the keyless terms inverting bashbop-api's cheap lane, and let a read that
separates outcomes reach the cheap band in a repository like
bashbop-event-web, without giving back what it does on bashbop-api.

### Graded, 2026-09-26: a centre for the model terms

The shipped arithmetic charges every model term from zero: a read that names
the target costs nothing, and no read can put a request above AX. The first
candidate under the bar lets it. Each Score term is charged from a **centre**
instead of from zero, so a read at the easy end of a question earns a share
of AX back and a read past the centre costs one. Shares, bands, the
containment bonus and both bumps are exactly as shipped:

```
route = clamp(AX x (1 - 0.25 x (specificity/2  - c)
                    - 0.20 x (blast_radius/2 - c)
                    - 0.15 x novelty
                    + bonus), 0, 100)
```

`c = 0` is the shipped arithmetic. Novelty keeps its zero, because a request
that needs no new design is the default rather than a discount. The
deterministic variant sits at the centre, so its tiers do not move and the
tables stay comparable. "Confident" is not a separate gate: a read earns the
whole of the cheap-ward share only when its distribution puts most of its
mass on the easiest level, which is what the expectation already measures.

Swept on the tuning runs, bashbop-api and solumbe, rescored on the frozen
answers. Cheap lanes only, as commits · repaired; every centre above zero
orders both variants on bashbop-api with cheap and premium apart:

| c | bashbop-api · offline | bashbop-api · jev | solumbe · offline | solumbe · jev | Bar, tuning runs |
| --- | --- | --- | --- | --- | --- |
| 0, shipped | 129 · 22.5% | 186 · 4.8% | 72 · 22.2% | 35 · 14.3% | fails 1: keyless inverted |
| 0.1 | 326 · 11.3% | 332 · 4.2% | 103 · 21.4% | 53 · 15.1% | fails 3: solumbe jev |
| 0.2 | 424 · 10.8% | 384 · 4.7% | 115 · 19.1% | 73 · 12.3% | **passes** |
| 0.25 | 449 · 10.5% | 396 · 5.3% | 121 · 20.7% | 83 · 15.7% | fails 3: both jev |
| 0.5, symmetric | 509 · 11.2% | 469 · 9.8% | 151 · 19.9% | 124 · 18.5% | fails 3: both jev |

Two things the sweep says on its own. **Every centre above zero fixes the
keyless inversion on bashbop-api**: the offline cheap lane goes from 129
commits at 22.5% to 424 at 10.8%, ordered, cheap and premium apart. The term
that inverted it was blast radius, which the heuristic derives from how many
top-level areas the candidate files span, and on this repository the commits
that span several are the clean ones (the 345 it moved out of the cheap lane
were repaired 5.5% of the time). **The symmetric centre makes the model read
worth nothing at the tier level.** At `c = 0.5` the Jev cheap lane on
bashbop-api is 469 commits at 9.8%, against 474 at 10.1% with no model at
all: the lane the read carves out is the deterministic lane. The read's value
is in the other direction. Of the 312 commits the deterministic half puts in
`mid` on bashbop-api, Jev puts most of the mass on "names the target" for
three and on "one file" for three, so there is almost nothing for a
cheap-ward push to lift. What a centre does on this corpus is stop charging
for reads that are only mildly unspecific, and those are clean: the 59
deterministic-cheap commits Jev read below level 1 on both Score questions
were repaired once.

`c = 0.2`, the one centre that passes, is a knife edge. Its neighbours fail
criterion 3 by amounts inside every interval, 15.1% against 14.3% over 53
solumbe commits and 5.3% against 4.8% on bashbop-api. That is the shape of a fit
to noise, and it is why the bar keeps a run back.

**Confirmed once on bashbop-event-web, and failed.**

| Variant | cheap | mid | premium | Ordered | Criterion 3 |
| --- | --- | --- | --- | --- | --- |
| offline, shipped | 97 · 24.7% (17.2 to 34.2) | 425 · 46.1% | 494 · 51.8% | yes | |
| offline, c = 0.2 | 177 · 28.8% (22.6 to 35.9) | 463 · 50.1% | 376 · 51.3% | yes | 28.8% > 24.7%, **fails** |
| jev, shipped | 8 · withheld | 352 · 37.5% | 656 · 52.1% | unknown | |
| jev, c = 0.2 | 44 · 31.8% (20.0 to 46.6) | 478 · 40.8% | 494 · 54.0% | yes | 31.8% > 25.0%, **fails** |

Criteria 1 and 2 pass: for the first time on this repository the model tier
is gradable and ordered, cheap and premium apart, and its cheap lane (31.8%)
is cleaner than the deterministic one (33.5%). Criterion 3 fails for both
variants. Both failures are inside the intervals, and the model's reference
is a rate over 8 commits that the command itself would withhold, which is a
defect in how the criterion was written rather than a finding. The bar stands
as written and the candidate does not ship. It also could not have done what
it was built for: the keyless variant lifted no commit out of the
deterministic `mid` lane and the model lifted one. At `c = 0.2` a read earns
back at most 9% of AX, and all of it only when both Score answers sit at the
easy end, which on these runs almost none do.

What this leaves:

- The shipped one-sided arithmetic stays. Its keyless variant is inverted on
  bashbop-api, and the change that fixes it cannot be told from noise on the
  confirmation run under the bar as written.
- A cheap-ward push has nothing to act on in this backtest. Whether that is a
  property of the router or of commit subjects as request proxies is
  unmeasured: a subject is written after the change and rarely names the file
  it changed, where a live request often does.
- Any further candidate needs a confirmation run this one has not seen.
  bashbop-event-web has been scored and cannot confirm again.
- On bashbop-api, 9 of the 16 dependency bumps count as repaired, against
  24.3% of everything else, which is consistent with a later bump touching
  the same lockfile lines and the join reading it as a repair. That is the
  calibration thesis's `configuration` finding on the outcome side, and how
  much of any tier's rate it carries is unmeasured.

The sweep, the buckets and the confirmation are reproducible from the frozen
runs with `rescoreRegret(saved, { score })`; the harness and its output are
kept beside the runs.

### Re-graded, 2026-09-26: without release commits

The keyless inversion above was chased to its rows and turned out not to be
about blast radius. Split bashbop-api's deterministic cheap lane by the
heuristic's blast score and the lane falls into two pieces: 353 of its 474
commits have exactly five candidate files, a blast score of 1.2 or 1.6, and
were repaired 0.9% of the time; the other 121 were repaired 36%. The 353
are `chore(release): N [skip ci]`, written by semantic-release after every
merge. Across the run, 504 of 1,214 graded commits were written by tooling
(463 of those, and 37 `chore: Update schema snapshot after merge [skip ci]`),
4 of them repaired. No one asks a model for a release commit, and the join almost
never reads one as repaired, so they flattered whichever tier they landed in:
the deterministic half put 365 of them in `cheap`, which is the whole of
that lane's 10.1%, and the keyless heuristic moved them to `mid`
because their candidates (a lockfile, a changelog, a manifest) span areas,
which is the whole of the "inversion". bashbop-event-web has 82
`chore: bump version to N` commits with the same shape, and solumbe 28 release
commits of its own.

`solumbe regret` 0.4.0 leaves release commits out of the corpus the way it
already leaves fix commits out: a subject marked `[skip ci]`, a bare version,
or a chore, build, ci or release subject that names a version
(`RELEASE_SUBJECT` in `regret.js`). A subject that merely mentions a release
(`release: issue (#277)`) is a request and stays. The count is printed on the
corpus line, and `--rescore` applies the rule to a run saved before it, so the
frozen runs re-grade without a model call. Rescored, shipped arithmetic:

| Run | Graded | Base rate | Variant | cheap | mid | premium | Ordered |
| --- | --: | --- | --- | --- | --- | --- | --- |
| bashbop-api | 710 | 41.7% (38.1 to 45.4) | deterministic | 109 · 40.4% (31.6 to 49.8) | 173 · 35.3% (28.5 to 42.6) | 428 · 44.6% (40.0 to 49.4) | no |
| bashbop-api | | | offline | 59 · 45.8% (33.7 to 58.3) | 156 · 34.0% (27.0 to 41.7) | 495 · 43.6% (39.3 to 48.0) | no |
| bashbop-api | | | jev | 20 · withheld | 121 · 38.0% (29.9 to 46.9) | 569 · 42.7% (38.7 to 46.8) | unknown |
| bashbop-event-web | 934 | 50.5% (47.3 to 53.7) | deterministic | 168 · 45.2% (37.9 to 52.8) | 446 · 52.7% (48.1 to 57.3) | 320 · 50.3% (44.9 to 55.8) | no |
| bashbop-event-web | | | offline | 52 · 44.2% (31.6 to 57.7) | 390 · 49.5% (44.6 to 54.4) | 492 · 52.0% (47.6 to 56.4) | yes, overlapping |
| bashbop-event-web | | | jev | 8 · withheld | 273 · 46.9% (41.1 to 52.8) | 653 · 52.4% (48.5 to 56.2) | unknown |
| solumbe | 129 | 18.6% (12.8 to 26.2) | deterministic | 98 · 18.4% (11.9 to 27.2) | 30 · 16.7% (7.3 to 33.6) | 1 · withheld | unknown |
| solumbe | | | offline | 63 · 17.5% (10.0 to 28.6) | 65 · 18.5% (10.9 to 29.6) | 1 · withheld | unknown |
| solumbe | | | jev | 29 · withheld | 94 · 20.2% (13.3 to 29.4) | 4 · withheld | unknown |

What the corrected corpus says:

- **Nothing orders outcomes on either bashbop repository.** Every cheap lane
  sits inside its base rate's interval, and the deterministic half is not
  ordered on bashbop-api after all: the "yes" in the earlier table was the
  release commits. The model's cheap lane on bashbop-api shrinks from 186
  commits to 20, so the finding that "the model read orders bashbop-api and
  its escalations are right" was 166 release commits too, and is withdrawn.
- **The base rates are not what the earlier tables said.** bashbop-api's
  human commits are repaired 41.7% of the time within 30 days, not 24.7%, and
  bashbop-event-web's 50.5%. At those rates the `repaired` proxy is close to a
  coin flip, and a tier would need a large lane to show a difference through
  it.
- **The centre candidate's pass does not survive.** Re-swept on the corrected
  tuning runs, no centre from 0.1 to 0.5 clears criterion 1 or 2 on
  bashbop-api, and `c = 0.2` fails criterion 3 on solumbe and on
  bashbop-event-web. Its confirmation failure stands for a further reason.
- **One lane moves the right way, on the run too small to grade it.** On
  solumbe the model's cheap lane under a centre is repaired 4.9% (41 commits,
  `c = 0.1`) to 5.8% (52, `c = 0.2`) against 23 to 26% for its mid lane; the
  intervals separate at `c = 0.2`. solumbe's premium lane is one commit, so the
  bar cannot see this, and it is one repository.

The bar as written cannot currently be met on these runs: criterion 1 needs
the model's cheap lane to clear the minimum sample on both bashbop
repositories, and under the shipped arithmetic it is 20 and 8 commits. The
next candidate therefore has a prior question to answer before any arithmetic:
whether the `repaired` join, at 42 to 50% of human commits, is an outcome a
tier can be graded against on these repositories at all. Dependency bumps
(the calibration thesis's `configuration` finding), squash merges titled
`Develop (#451)` that match no file and route `premium` on the no-evidence
ceiling, and a 30-day line-overlap window on a busy monorepo are the three
places to look. Until then `route` stays advisory, and the earlier sections
stand as the record of what was measured on the corpus that included release
commits.

### Audited, 2026-09-26: the join

The prior question was put to the frozen runs offline, on the rows plus git,
with no model call: is `repaired` an outcome a tier can be graded against on
these repositories, or is the join itself what the tables are measuring?
Four cuts, all on the corpus without release commits, under the shipped
arithmetic. The scripts, the per-fix blame tables and every output are beside
the frozen runs in `.solumbe/runs/2026-09-26/tier-arithmetic/join-audit/`
(local only, like the runs).

- **The join reproduces.** A fresh blame pass at each repository's frozen head
  gives the frozen `repairedAfter` on every row of all three runs.
- **Shorter windows.** Rescored at 7 and 14 days from the stored
  `repairedAfter`, the base rates fall as they must (bashbop-api 41.7% at 30
  days, 34.6% at 14, 26.6% at 7) and the order of the tiers does not move. On
  bashbop-api the keyless cheap lane is the most-repaired tier at every
  window. The 30-day window was not counting churn a shorter one removes.
- **A stricter join.** Eight rules: at least 2 or 3 overlapping lines instead
  of 1, fix commits capped at 10 or 5 files or 200 changed lines, and their
  combinations. The strictest halves the base rate (bashbop-api 41.7% to
  15.8%, bashbop-event-web 50.5% to 17.1%) and orders nothing new. One cell
  of 81 per repository separates: bashbop-event-web, 14 days, fixes of at most
  5 files, the deterministic half, cheap 14.9% (10.3 to 21.0) against premium
  25.9% (21.4 to 31.0). The keyless heuristic at the same cut is inverted
  (cheap 17.3%, mid 16.7%), and the bar grades the model variants, not the
  deterministic half. It is noise.
- **Who repairs whom.** On the bashbop repositories repairs are not a few
  sweeping fixes: bashbop-api's 296 repairs come from 204 distinct earliest
  fixes and bashbop-event-web's 472 from 284, a median of one row each. The
  ten largest fixes by files touched account for 6% and 11% of repairs, and
  dropping them leaves every tier where it was (bashbop-api cheap 36.7%, mid
  35.3%, premium 41.1%). solumbe is the opposite case: 21 of its 24 repairs are
  ten sweeping fixes, and a fix of at most 5 files with at least 2 overlapping
  lines repairs nothing, so its proxy measures those sweeps. solumbe was already
  ungradable, with one premium commit.
- **Fixes the rule did not label.** `FIX_SUBJECT` matched `fix`, `hotfix`,
  `bugfix` and `revert`, and the bashbop histories write `hot-fix(...)`,
  `hot-fit`, `bug(...)`, `patch` and `fixes`: 79 rows on bashbop-api and 40 on
  bashbop-event-web were fixes graded as requests and invisible as repairs.
  Blamed as outcomes they join 6 and 9 more repairs and move no tier. The rule
  is widened in 0.4.1 because it was wrong, not because it changes the answer;
  `--rescore` drops the rows it now reads as fixes and says that their own
  repairs need a replay to join.
- **The two remaining suspects.** There are no dependency bumps on either
  bashbop repository in this corpus. `Develop (#N)` squash merges are 24 and 7
  rows, almost all routed `premium`, and leaving them out changes nothing. On
  solumbe the 17 dependency bumps do what the release commits did (16 of 17
  routed cheap, 1 repaired; the keyless cheap lane goes from 17.5% to 21.3%
  without them), but there is no ordering on solumbe for a corpus rule to
  rescue.

Rescored under 0.4.1 (release commits and the newly labelled fixes out):

| Run | Graded | Base rate | Variant | cheap | mid | premium | Ordered |
| --- | --: | --- | --- | --- | --- | --- | --- |
| bashbop-api | 631 | 41.2% (37.4 to 45.1) | deterministic | 99 · 39.4% (30.3 to 49.2) | 148 · 35.1% (27.9 to 43.1) | 384 · 44.0% (39.1 to 49.0) | no |
| bashbop-api | | | offline | 53 · 43.4% (31.0 to 56.7) | 140 · 34.3% (26.9 to 42.5) | 438 · 43.2% (38.6 to 47.8) | no |
| bashbop-api | | | jev | 17 · withheld | 112 · 39.3% (30.7 to 48.5) | 502 · 42.2% (38.0 to 46.6) | unknown |
| bashbop-event-web | 894 | 50.0% (46.7 to 53.3) | deterministic | 165 · 44.8% (37.5 to 52.5) | 438 · 52.3% (47.6 to 56.9) | 291 · 49.5% (43.8 to 55.2) | no |
| bashbop-event-web | | | offline | 50 · 44.0% (31.2 to 57.7) | 383 · 48.8% (43.9 to 53.8) | 461 · 51.6% (47.1 to 56.2) | yes, overlapping |
| bashbop-event-web | | | jev | 8 · withheld | 268 · 46.6% (40.8 to 52.6) | 618 · 51.8% (47.8 to 55.7) | unknown |
| solumbe | 129 | 18.6% (12.8 to 26.2) | unchanged | | | | |

The conclusion is the one worth having before anyone touches the arithmetic
again: **commit history cannot grade the router on these repositories.** The
outcome is real, the join is faithful and not dominated by a few fixes, and
the tiers do not order it at any window, under any stricter join, with or
without the suspect commits. The exclusions do not earn a corpus rule on this
evidence. The next evidence has to come from live requests.

What a live request fixes, and what it does not. Every graded row above
carries two caveats history can never remove: the request is a commit subject
written after the change, and the corpus is whatever landed, not what a router
was asked. A decision recorded at prompt time removes both, which is why the
`route-prompt` hook now keeps one (the section above). It does not remove the
third: the tier the session ran on stays unknown. And it does not make the
evidence arrive faster.

### Audited, 2026-09-26: a same-session outcome

The same day, the shorter road was tried: a request routed cheap whose next
prompt in the session is a correction, an outcome available minutes after the
request instead of thirty days after the commit. It was audited before the log
existed, on the corpus that already did: every Claude Code transcript on this
machine (twenty days, one user, 1,122 prompt records) and the tiers the canvas
had recorded when the hook ran (376 routed prompts, solumbe only, since the hook
was wired in one repository). Evidence beside the frozen runs in
`.solumbe/runs/2026-09-26/session-correction/`, local only.

| | count |
| --- | --: |
| real requests (not notifications, shell output, slash commands, interruptions, duplicate copies) | 755 |
| with a follow-up prompt inside the hour | 616 |
| whose turn edited any file | 143 |
| with a tier recorded at the time | 84, of which 20 edited a file |

**Pushback**, the next prompt opening with a negation, a complaint, still or
again, an interruption, or a re-ask: 8.2% of follow-ups. Read one by one they
are mostly the user fixing their own typo ("i meant commercial"), reporting a
deploy or environment failure ("DB not working", "not reflecting in
production"), interrupting to add information, or turn-taking. A handful are
the model being wrong. **Rework**, the next turn's assistant edits touching a
file this turn's edits touched: 24 of the 143 editing requests, 16.8%, and
the samples are a plan file or a migration worked on across consecutive
prompts. Iteration, not repair. The two labels barely overlap (21 of the 24
reworked requests read as "moved on"). A **git undo** in the next turn (45
turns) is stash-and-test workflow, staging fixes, and discards the user asked
for, not a repair signal either.

With 84 tiered requests every lane is below the minimum sample, so nothing is
graded. The rate matters more than the count: about seven editing requests a
day across every repository, about one of them routed cheap, so thirty per
tier is weeks away and separating two rates at a 10 to 17% base rate is
months. The outcome arrives in minutes; the corpus that carries it grows no
faster than commits do. That was the wrong half of the earlier claim that this
road was fast.

So the hook keeps its decision and `route-outcomes` grades it, with both
proxies' failure modes printed as caveats, and no number from either is
published until a lane clears the minimum sample. Neither the commit join nor
the session read grades the router today. What would: the tier the session
actually ran on, recorded by the host; an outcome that reads the assistant's
turn rather than the user's words (tests failing after the turn, an edit
rejected at the permission prompt), each audited before it counts; and more
than one user's sessions.

## References

- TypeSafe AI, _System One_: <https://docs.typesafe.ai/concepts/system-one>
- TypeSafe AI, _Composite scoring_: <https://docs.typesafe.ai/patterns/composite-scoring>
- TypeSafe AI, _Confidence_: <https://docs.typesafe.ai/confidence>
- solumbe, [Calibration Thesis](../17-calibration-thesis/README.md)
- solumbe, [Deterministic Verification](../07-deterministic-verification/README.md)
- Implementation: `src/lib/model-route.js` and `src/lib/render/route.js`, reachable as `solumbe route`
- `scripts/model-route.mjs` is a thin wrapper kept for the 1.12.0 prototype invocation
- Host-agnostic skill: `codex/skills/model-router/`
