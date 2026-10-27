# Hermes Kanban → Paperclip strategic mirror

## Authority split

| Layer | Owns |
|-------|------|
| **Hermes Kanban** | Execution stories, workers, claims, board lanes (24/7 loops) |
| **Paperclip** | Company projects, roadmap parents, completion rollups, strategy |
| **Mirror script** | One-way idempotent Kanban → Paperclip scaffold |

Paperclip does **not** assign Kanban work into Hermes agents as the primary loop.
Kanban remains the live execution surface. Paperclip becomes the portfolio /
roadmap / completion lens so humans can think higher-level.

## Mapping

| Kanban board | Paperclip project |
|--------------|-------------------|
| `twilight-route` | Pokemon |
| `spatial-canvas` | Hermes Agent |
| `default` | Company Operations & Idea Inbox (skipped when empty) |

Each board gets:

1. A roadmap parent issue: `[Kanban roadmap] … — N/M done (P%)`
2. One child issue per Kanban task (unassigned; execution stays on Kanban)
3. A `roadmap` document on the parent with the full story table

## Run

```bash
python3 scripts/hermes-kanban-mirror.py
python3 scripts/hermes-kanban-mirror.py --dry-run
python3 scripts/hermes-kanban-mirror.py --board twilight-route
```

State file (idempotency):

`~/.paperclip/instances/default/data/hermes-kanban-mirror-state.json`

Recurring: Hermes cron `paperclip-kanban-mirror` every 15m (`--no-agent` script).

## Status mapping

Kanban `running` → Paperclip `todo` with `[RUNNING on Kanban]` title prefix.
Kanban `blocked` → Paperclip `todo` with `[BLOCKED on Kanban]` because
Paperclip rejects `blocked` without native blocker metadata. Done/ready map normally.

## Operator UX

- Open Paperclip project **Pokemon** → roadmap parent for Twilight Route
- Open **Hermes Agent** → roadmap parent for Spatial Canvas
- Drill children for story-level completion without leaving company OS
- Keep directing workers on Hermes Kanban boards / Desktop
