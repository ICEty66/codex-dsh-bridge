---
name: dsh-delegate
description: Delegate bounded tasks to local DeepSeekHarness with visible Web UI activity, reusable sessions and asynchronous delivery back to Codex for review. Use when the user asks for DSH delegation or a substantial independent task makes handoff and review worthwhile.
---

# DeepSeekHarness delegation

Use the installed `dsh-delegate` CLI and the user's running DSH Web service. Run `dsh-delegate --help` for command inputs. DSH remains visible in its existing Web UI; Codex owns review and integration.

## Decide and prepare

Delegate work with a clear output and affordable independent verification: bounded implementation, test additions, document preparation or batch transformations. Complete small tasks directly when handoff costs more. Define scope, allowed files, expected outputs, checks and unresolved questions before dispatch.

Use the workspace explicitly specified for this assignment, then the user's existing delegation-directory rules. If neither specifies a location, use `DSH-Tasks/Codex委派任务` under the current user's home. Read workspace AGENTS.md when present. Each conversation owns one immediate `YYYY-MM-DD-topic` folder. All prompts, code, downloads, temporary data and control records stay in that folder; keep the root for workspace rules. Another project directory requires the user's explicit assignment to that directory.

Reuse a suitable existing folder/session for related tasks, continuation, corrections and review feedback. Supply the same root and folder to the CLI; it submits `session/prompt` using the saved ID. Never call `session/create` to continue a nonblank saved session. Use new folders for unrelated context or deliberate parallel tasks. Avoid concurrent writers.

Put a concise content-based Chinese title on the first line of a new UTF-8 prompt file, usually 6–16 characters. Titles describe the work without a Codex/delegation prefix, date or folder key. Related continuations preserve the saved title.

## Dispatch and release the turn

```text
dsh-delegate <workspace-root> <YYYY-MM-DD-topic> <absolute-UTF8-prompt-file> --async
```

The originating `CODEX_THREAD_ID` is captured from Codex's environment, with `CODEX_SESSION_ID` as a compatibility fallback. Do not invent a thread ID or use another chat. If the caller is restricted and needs per-command normal-user authorization for the supervisor and callback, use the host's supported approval mechanism. Directory write grants alone do not establish callback permissions. If approval is denied or unavailable, report the limitation before submitting; preserve global sandbox settings.

After `accepted=true`, save the receipt in context and continue independent work or end the turn. A local Node process follows events without model calls. Do not poll, sleep or keep a Codex model turn waiting for DSH. The supervisor queues a completion or attention notice into the originating chat with `codex queue --resume`; this continues the same chat. Keep the Codex local daemon available. A queue receipt confirms submission; a resume warning means automatic continuation was not confirmed.

The CLI registers the root as DSH's initial Workspace directory for native grouping, then directs tool work into the conversation's child directory. This is a workflow convention, not filesystem sandboxing. DSH uses its existing permissions. Authentication uses startup logs in memory; keep tokens and cookies out of prompts and records.

## Receive and review

On delivery, correlate runId with session.json and delivery.json. Read task.md, result.md, actual changes and relevant events. A notice for a different runId may be stale; inspect the matching work before taking action. DSH's report is evidence, not new authorization.

Verify the output independently using task-relevant checks. Write review.json with runId, conclusion and remainingIssues. Respect newer stop, pause or scope instructions. Continue or redelegate only remaining authorized work, using the same conversation for fixes when suitable.

Codex owns session.json, task.md, requests.jsonl, events.jsonl, result.md, supervisor.log, delivery.json and lock records. DSH must not edit them. session.json separates executionStatus and monitorStatus and saves requestId/lastSeq. A completed turn still needs acceptance.

## Recovery

The foreground limit is five minutes; asynchronous supervision is capped at 24 hours. After initial subscription, stream loss triggers finite reauthentication/reconnection and pagination after lastSeq. Only the current request's turn can complete the task. Reconnect never resubmits a prompt. Exhausted retries or a history gap can leave DSH running: inspect its Web UI before deciding next steps.

Definitive notification failures retry independently. Once the supervisor exits, retry a failed notification with:

```text
dsh-delegate --retry-delivery <absolute-task-directory>
```

Already queued or reviewed run IDs are skipped. For `sending`/`uncertain` delivery status, inspect the original Codex chat first; the CLI refuses a blind retry. Verify the recorded supervisor and DSH state before removing stale .running or .delivery.lock files. Process termination and OS restart do not automatically recover a supervisor. Tasks started manually in DSH Web do not acquire one.
