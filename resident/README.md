# Crovia resident

A GitHub-resident engineering experiment for AgentCrash and Causari, authored by Crovia.

Each hourly wake reads the real repository, its sibling, recent commits, issues,
past experiments and review outcomes. A language model chooses what to inspect
and proposes a bounded experiment. The model has bounded read, search and isolated test-probe actions. It cannot
choose shell commands. A separate job runs the experiment in Docker without network access or
credentials. A final job records the generation on `crovia-memory` and saves
verified changes on `crovia/resident-<id>` branches. It never runs candidate code
with a write token and never merges changes automatically.

The process survives the runner: source and strategy live on the default branch;
observations, failures and proposals live on `crovia-memory`. Runners are
temporary, not a permanently running process. GitHub schedules can be delayed.

## What evolves

- Memory of attempts, failed hypotheses and review outcomes persists between runs.
- Unfinished research can carry observations tied to an actually read file and
  commit SHA, plus a precise next question, into the next generation. Observations
  remain explicitly unverified. Continuation is bounded to three attempts before
  focus selection explores another direction.
- Focus selection explores untried directions and uses observed review outcomes.
- The model can propose a new `resident/strategy.json`, subject to a fixed schema
  and review. A schema-valid strategy is explicitly **not** a proven improvement.
- The model reads both projects, but writes only to the repository hosting it.
  Install the same files in each repository; no cross-repository write token is
  needed for branches and memory.

This is not weight training, demonstrated recursive intelligence improvement,
proof of independent invention, or a promise of business growth. The quality of
the local bootstrap model must be evaluated from actual executions. The first
version explores source code and regressions; it does not browse the web, contact
people, publish marketing, or discover unlimited new tools.

## Code experiments

Every source change requires a new regression test. The original suite must pass,
the regression must fail on the original source, and both the regression and
original suite must pass on the candidate. Failed or inconclusive attempts are
recorded rather than published as successful improvements. Existing test files,
workflow permissions, manifests and controller code cannot be edited by a proposal.
Fleet specialists can run up to two baseline probes before proposing code. Each
probe writes only a randomly named new test in a disposable committed snapshot,
then runs a fixed command in the same restricted Docker environment. The exact
proposed regression must have failed on the same source revision. Syntax, import
and compiler errors can also fail a probe: diagnostics require inspection, and
only the independent before/after verifier can establish a successful repair.
All existing learned regressions remain in the full Node test suite.

The final two inference turns are reserved for a probe, decision or research handoff,
so inspection cannot silently consume the entire cycle without a conclusion.

The verifier copies the committed baseline. Candidate code runs in a read-only
container with a writable temporary directory, no network, no host token, no
Docker socket, capped CPU, memory, processes and time. Rust dependencies are
fetched from the original lockfile before offline builds. The original test files
cannot be changed by the proposal. Container isolation and tests are useful checks,
not a complete security boundary or proof of correctness. All candidate PRs are drafts.

## Start and identity

After merging the workflow into the default branch, use **Actions → Crovia
resident → Run workflow**, or wait for the next hourly wake. The implementation
branch has been used for bootstrap testing. Run summaries and the memory
branch show whether it actually ran and what happened.

By default, Ollama runs `qwen3.5:4b` on the GitHub runner CPU. It needs no
external inference key. Its weights are cached; full job artifacts expire after
seven days. The CPU bootstrap model trades capability for resource cost. Do not
assume it can match a frontier coding model. The model download, image pull and
CPU inference may fail or exceed the time budget; these are execution failures,
not evidence of autonomous progress. Cache eviction is possible.

Git commits use author **Crovia <info@croviatrust.com>**. To have PRs opened by
**croviatrust**, configure an Actions secret `CROVIA_GITHUB_TOKEN` belonging to that
account with Contents and Pull requests write permissions for the two repositories.
Without it, the resident saves candidate branches and comparison links, and does
not substitute a bot account for Crovia. No token belongs in repository files.

Optional repository configuration:

| Setting | Meaning |
| --- | --- |
| Variable `CROVIA_RESIDENT_PAUSED=true` | Stop new cycles |
| Variable `RESIDENT_MODEL` | Ollama model tag, or remote model identifier |
| Variable `RESIDENT_API_URL` | HTTPS OpenAI-compatible chat-completions endpoint; skips local Ollama |
| Secret `RESIDENT_API_KEY` | Credential for that endpoint, if needed |
| Secret `CROVIA_GITHUB_TOKEN` | Open PRs as croviatrust |

External model inference may cost money; the default does not call a paid API.
Public standard GitHub runners have free compute under GitHub's current terms,
but storage, concurrency, time and acceptable-use limits still apply. This system
does not create extra repositories or chain jobs to evade those limits. Source
code and issue excerpts are sent to the configured model provider if a remote
endpoint is selected.

At three outstanding resident PRs or unsubmitted candidate branches, proposals
pause for review. Review or discard the candidates before continuing. Attention
metrics are recorded as attention, never as customers, recurring use or revenue.

## Local checks

```sh
node --test resident/core.test.mjs
```

These unit tests include a real before/after source regression in disposable local
repositories, plus test doubles for model output and container execution. They
do not claim an actual model-generated improvement or a live Docker run.
The separate `resident controller checks` workflow additionally runs
`node resident/docker-proof.mjs` against real isolated containers and proves both
acceptance of a correction and rejection of an existing-behavior regression.

Controller files are deliberately outside its own edit capability in this first
version. Proposing broader changes to its runtime requires a separately reviewed
expansion of the experiment format, preserving independent evaluation.

## Research fleet and capability library

The resident now runs three separate model contexts on the same runner:

1. A scout chooses a concrete research question, public repository sources and
   official documentation. It defines the mission of a generated specialist.
2. The specialist inspects and edits the actual project using the existing bounded
   actions, with external material clearly marked as untrusted evidence.
3. An independent critic can veto the experiment. Acceptance means worth testing,
   not proof that it works. The isolated execution job is still the evidence gate.

The shared budget is eight model calls: one scout, up to six specialist calls,
then one critic. These agents run sequentially; this version does not claim
parallel speedup or independently hosted child repositories. Specialist identities
are derived from their missions. The retained lineage contains at most six
specialists plus the scout and critic, and records attempts and source-case
verification outcomes.

The scout can search public GitHub repositories and read files at pinned commit
SHAs. A source record preserves the repository, path, revision, content hash,
license metadata and retrieval time. Documentation retrieval is limited to the
hosts coded in `research.mjs`; private repositories, arbitrary destinations,
account APIs and cross-host token redirects are refused. External material is
never installed or executed. Failed searches are recorded; they do not become
fabricated evidence. Reading a source or its license metadata does not grant
permission to copy it.

A code experiment becomes a capability capsule only when the critic accepts it
and independent verification proves the before/after change and original suite.
Capsules contain the actual repair code, a runnable regression, contract,
source provenance and specialist lineage. The memory branch stores detailed
capsules under `capabilities/`, with at most 24 compact entries in its index.
Each project can retrieve matching recipes from its sibling. Retrieval is not
proof of successful transfer: adaptation to a new case must be verified again.
These are tested repair recipes, not model weight updates or unrestricted tools.

For independently verified experiments only, the writer also stores an English
communication draft under `outreach/`. It distinguishes the hypothesis, intended
benefit and observed test outcomes. No social account, email or discussion is
contacted, and no claims about customers, revenue or broad transfer are generated
as observed results. The draft is material for review and subsequent publication.

`node --test resident/*.test.mjs` includes fixture-based complete research,
proposal, critique, execution, capsule promotion and cross-repository retrieval.
Model responses in these fixtures are test doubles. `docker-proof.mjs` separately
uses real containers for the source regression and promotion gate. Neither is a
claim that the live model has autonomously acquired or transferred a useful skill.

## Measured agent encounters

AgentCrash alternates engineering with a controlled encounter on first activation
and every fourth generation thereafter. Two fresh contexts of the configured
model receive the same synthetic repository task and four-turn budget. One can
read files; the other can also discover a local catalog and invoke the actual
read-only product CLI. A fixture contract grades answers, including misses and
false positives. The model cannot grade itself or execute arbitrary commands.

Full traces and CLI output hashes persist under `encounters/` on `crovia-memory`;
the latest compact outcome is passed to the scout and builder in subsequent
engineering cycles. Encounter cycles consume at most eight model calls instead
of adding work on top of the engineering budget. They do not promote repair
capsules. A controlled local result is not organic discovery, independent-user
adoption or demonstrated growth. See [the agent interface](../agents/README.md).

## External needs and actual-use feedback

Each observation cycle performs bounded read-only public GitHub issue searches.
It checks repository visibility and canonical issue state, keeps URL, timestamp,
content hash and excerpts, filters own-repository echoes and evidence older than
180 days, and ranks topic matches with an explicit heuristic. This ranking is
a research queue, not validated demand. Three attempts on unchanged issue
evidence within retained recent history remove that source from the queue.

The scout can select only a supplied opportunity id for the source linkage.
The writer retains `opportunities.json` and `growth/<episode>.json` on the memory
branch, connecting source, hypothesis, falsifier, checks and candidate. Inbound
Agent trial issues are passed to research as unverified self-reports. No contact
with issue authors or external publication is performed. Network/rate-limit
errors are recorded and do not create fictional opportunities. A successful
repair is still not automatically classified as adoption or publication.

Opening or reopening an `[Agent trial]` issue can wake the trusted default-branch
workflow. Feedback-triggered cycles are throttled when a cycle finished within
the previous hour; the issue remains available for subsequent observation. The
workflow pause and proposal-backpressure controls still apply. The hourly cron
is a requested schedule, not a guarantee of an hourly completed generation.

## AgentHub: persistent commitments

The resident keeps an `agenda.json` work ledger in its memory branch. Source-linked
objectives survive individual runs and carry checkpoints and next actions into
the scout and specialist contexts. Failed encounters, project issues and ranked
external needs supply work. Three inconclusive attempts block a commitment until
its source evidence changes; candidate work waits for review rather than being
recreated each cycle. An observed merge completes the patch commitment, not the
underlying market need or proof of adoption. Missing search results never mark
work complete. The ledger is bounded to 24 commitments and three checkpoints each.

AgentHub is a working name for this continuity layer, not a claim of a new model,
consciousness, independent invention or first-ever GitHub agent. Runtime remains
event-driven GitHub Actions plus the configured inference model.

## Recovery from observed failures

AgentHub uses a stated operating style (curious, skeptical, direct) and short
action-purpose summaries, not simulated emotions. Actual controller blockers
are retained separately from unverified model explanations. Complete-file reads
are explicitly marked; tail rereads of an already complete file are refused.
An inference timeout is reported as model-generation failure. If the model then
misattributes it to a file read, it gets one bounded recovery opportunity, while
retaining the option to stop with a genuine blocker.

Probe results have ids. A proposal may reference an existing probe's exact test
bytes instead of regenerating them. The same baseline SHA/hash and independent
before/after verification requirements still apply. Source destinations cannot
use probe references. Specialist inference has up to 360 seconds and 1600 output
tokens per call; scout/critic calls use 200 seconds and 900 tokens. The shared
eight-call budget remains, with a 65-minute job cap including bounded probes.

Ollama runs as the runner uid with only its model directory cached. Its ephemeral
HOME/key material is outside the cache, avoiding the root-owned cache failures
observed during the first assigned repair. These changes target measured runtime
failures; they do not establish improved live model performance by themselves.

## Typed process experiments

`probe_process` lets the specialist specify an already-read Node script, bounded
string arguments, an expected numeric exit and a timeout. `$NODE` in arguments
resolves to the current Node executable. A fixed compiler creates a regression
test and uses the existing isolated probe runner; no model-selected host shell
command or host environment is passed through. The resulting probeId can supply
the exact test bytes to a proposal. This is a general process-exit test primitive,
not a repair template for the assigned bug. Independent verification is unchanged.

A read of a missing permitted new regression file now explicitly reports that
the controller creates the file and its directory. A missing existing source
file remains an error. The critic is told explicitly that baseline failure and
candidate success are the intended regression experiment, not a contradiction.

## Autonomous recovery loop

The AgentCrash workflow now runs `autonomy.mjs`. Within a bounded mission it
executes an engineering attempt, evaluates the result in isolation, and on
failure invokes a separate recovery-researcher context. That model proposes a
method hypothesis, a falsifier and a public research plan. The controller retrieves
those sources and passes the method and observed failure to a new attempt on the
same objective. This requires no operator prompt or source edit between attempts.

A mission permits at most two engineering attempts and sixteen model calls,
with a fifty-minute controller deadline. Model calls and containers receive the
remaining time budget. The separate workflow verifier still checks the final
candidate before publication. The writer retains `methods.json`; model statements
and local success flags cannot promote a method. Only independent source-case
execution can attach a validation. This is method-memory learning, not weight
training, general intelligence, self-expanded authority or proven generalization.

Failed autonomous work enters `needs-research` with its actual failure record.
After a fifteen-minute cooldown, a later wake begins with recovery research before
engineering instead of blindly repeating the same method. Six failed recovery
cycles require escalation; the objective remains recorded. GitHub must still
deliver a wake event, and its cron timing is not guaranteed. No method can change
credentials, write permissions, source-edit scope, test gates or publication rules.
