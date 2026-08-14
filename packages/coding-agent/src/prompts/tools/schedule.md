Schedule prompts that run later in this session. Each fire spawns a FRESH subagent (blank context, same cwd/tools) with the stored task; its result auto-delivers into this conversation like a background task finishing.

# Operations
- `add` — register a schedule. Requires `task` plus exactly one of `every` / `at`.
- `list` — show active schedules with cadence, next fire time, and run counts.
- `cancel` — remove one schedule by `name`.

# Fields
- `task`: The work each run performs. MUST be fully self-contained — the subagent starts blank and knows nothing about this conversation. Name exact paths, commands, and the expected output shape.
- `every`: Recurring cadence as a duration: `"20m"`, `"2h"`, `"1h30m"`, `"45s"`. Minimum 30s. Fixed cadence from registration time; a fire that lands while the previous run is still going is skipped, not stacked.
- `at`: One-shot local time `"HH:MM"` (24h; next occurrence) or an ISO datetime. Convert user phrasing yourself: "9pm" → `"21:00"`.
- `name`: Stable identifier (`[A-Za-z0-9_-]`, ≤32 chars) used for `cancel` and result headers. Generated if omitted.
- `agent`: Agent type for each run (e.g. `scout` for read-only checks). Defaults to the standard worker.
- `model`: Force a model for each run; same selectors as the task tool.

# Lifetime
Schedules live in this session's memory only: they die with the process, on `/new`, and are never persisted or re-armed. Requires background job delivery (`async.enabled`).
