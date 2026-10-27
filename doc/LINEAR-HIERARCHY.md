# Linear / PM hierarchy on Paperclip (zer0)

## Paradigm (from `products/pm`)

> **Everything is an issue.**  
> Products, projects, features, tasks, and defects are issue kinds connected by parent links.

PM group kinds (`progress/model.py`):

```text
portfolio → product → project | epic | sprint | feature → task | defect
```

Your stated company shape:

```text
company
  └── portfolio
        └── product
              └── epoch
                    └── project / sprint
                          └── task
```

## Paperclip mapping (what we use)

Paperclip already has the pieces; we do **not** invent a second PM DB.

| Concept | Paperclip primitive | Convention |
|---------|---------------------|------------|
| Company | `companies/zer0` | one company |
| Portfolio | **Goal** titled `[Portfolio] …` | child of mission goal |
| Product | **Project** | `goalId` → portfolio goal; workspaces bind git roots |
| Epoch | **Issue** `[Epoch] …` | project-scoped, no assignee required |
| Sprint / cycle | **Issue** `[Sprint] …` | child of epoch |
| Task / defect | **Issue** (leaf) | child of sprint; may be assigned |
| Kanban execution | Hermes board | mirrored tasks hang under the product’s current sprint |

Markers in issue descriptions for idempotent automation:

```html
<!-- zer0-kind:epoch key:pokemon/twilight-route -->
```

## Filesystem → portfolio

| `/workspace/zer0/…` | Portfolio goal |
|--------------------|----------------|
| `products/` | `[Portfolio] Products` |
| `experiments/` | `[Portfolio] Experiments` |
| `clients/` | `[Portfolio] Clients` |
| `oss/` | `[Portfolio] OSS & Agent Factory` |
| `services/` | `[Portfolio] Platform Services` |
| `portfolios/` (brand, x, revops, ventures) | `[Portfolio] Brand & Growth` |
| company-wide ops | `[Portfolio] Company Ops` |

`portfolios/` is the *named brand/revops/ventures* bucket; **every top-level zer0 folder is still a portfolio lane** in the issue tree.

## Linear-style operating rules

1. **One product = one Paperclip Project** (not one per worktree).
2. **One active epoch** per hot product; nest sprints under it.
3. **Hermes Kanban board per product** for workers; Paperclip sprint holds the roadmap + mirrored stories.
4. **No dual queues** — Kanban claims work; Paperclip records structure/completion/strategy.
5. **Promote experiments** only with evidence (move Project from Experiments portfolio → Products).

## Scripts

```bash
# portfolios + epoch/sprint skeleton + roadmap attach
python3 scripts/linearize-zer0-hierarchy.py

# company heat/brand reorg (goals/projects)
python3 scripts/reorg-zer0-company.py

# Kanban stories → task issues under product
python3 scripts/hermes-kanban-mirror.py
```

## Example tree (Pokemon)

```text
[Portfolio] Products          (Goal)
  Pokemon                     (Project)
    [Epoch] Twilight Route    (Issue)
      [Sprint] Current Kanban (Issue)
        [Kanban roadmap] …    (Issue)
          ZER-xx story tasks  (Issues)
```

Same pattern for Hermes Agent, Paperclip, SFT-SVLM, boplog, zerOS.
