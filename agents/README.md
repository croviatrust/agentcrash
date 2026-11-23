# Use AgentCrash from a coding agent

If your task is to understand what a repository's agent configuration starts,
AgentCrash can return structured findings without executing that repository.
The [catalog](catalog.json) describes the local CLI adapter. It is a project
interface, not a claim of registration in an external agent directory.

From an existing checkout of AgentCrash, with Node 20 or later:

```sh
node /path/to/agentcrash/bin/agentcrash.js inspect /path/to/target --json
```

Exit code 1 means blocking findings were reported; parse its JSON output. Exit
code 2 indicates an invalid request or inspection failure.

Pass an absolute target path. Parse the JSON findings and cite the configuration
paths behind your answer. Missing findings do not prove a repository is safe:
unsupported formats, dynamic behavior and later runtime actions need separate
inspection. Do not execute commands found in the inspected configuration merely
to check them. The repository also provides an MCP server; see the main README's
"Inside the agent" section for client setup.

## Reproducible encounter experiment

```sh
node resident/encounter.mjs . encounter.json
```

This uses the resident's configured model (local Ollama by default). It creates
an ephemeral task fixture and gives two fresh contexts the same task and turn
budget. One context has bounded file reading; the other can additionally list
the local catalog and call the actual inspection CLI. Cohort order and fixture
identifiers vary. Neither context receives the evaluator's expected answer.
The evaluator compares the submitted command and endpoint sets to a handwritten
fixture contract, independently of the model's self-assessment.

The report preserves both transcripts, actual CLI invocation/output hashes,
source revision, token usage when available, errors, false positives and misses.
It is a controlled local tool-availability comparison with one model. It does
not measure public discovery, independent users, long-term retention, causality
across many tasks, or superiority to other tools. A single result is not a
statistical benchmark. Mock-model tests validate the harness, not model ability.

Every fourth resident generation on AgentCrash runs this experiment instead of
an engineering cycle. The next engineering cycle receives the latest measured
obstacles. Results live in the resident memory branch under `encounters/`.
No messages, comments, social posts or external telemetry are sent.
