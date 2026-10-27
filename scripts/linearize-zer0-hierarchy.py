#!/usr/bin/env python3
"""Linearize zer0 onto Paperclip using the PM everything-is-an-issue paradigm.

Hierarchy (PM model + Linear practice):

  Company (Paperclip company)
    └── Portfolio          → Goal titled "[Portfolio] …"
          └── Product      → Paperclip Project (workspace-bound)
                └── Epoch  → Issue "[Epoch] …"
                      └── Sprint / cycle → Issue "[Sprint] …"  (Kanban roadmap lives here)
                            └── Task / defect → Issue (leaf; Kanban stories mirror here)

GROUP_KINDS from products/pm/progress/model.py:
  portfolio | product | project | epic | sprint | feature
LEAF_KINDS:
  task | defect

Paperclip mapping:
  - company     = company record
  - portfolio   = Goal (parented under mission)
  - product     = Project (goalId → portfolio goal)
  - epoch       = Issue with parent=null at project scope, title prefix [Epoch]
  - sprint      = Issue child of epoch, title prefix [Sprint] (Kanban roadmaps qualify)
  - task        = Issue child of sprint (Kanban story mirrors)

Idempotent via description markers:
  <!-- zer0-kind:portfolio|product|epoch|sprint|task key:... -->
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

API = os.environ.get("PAPERCLIP_API_URL", "http://127.0.0.1:3100/api").rstrip("/")
CID = os.environ.get("PAPERCLIP_COMPANY_ID", "c6ad4c58-9a56-4b63-bb0f-1ab9106e3261")
MARKER_RE = re.compile(
    r"<!--\s*zer0-kind:(?P<kind>[a-z]+)\s+key:(?P<key>[^\s]+)\s*-->", re.I
)


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def http(method: str, path: str, payload: dict | None = None) -> Any:
    data = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(f"{API}{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = resp.read().decode()
            return json.loads(body) if body else None
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", "replace")
        raise RuntimeError(f"{method} {path} → {e.code}: {err[:700]}") from e


def marker(kind: str, key: str) -> str:
    return f"<!-- zer0-kind:{kind} key:{key} -->"


def find_by_marker(issues: list[dict], kind: str, key: str) -> dict | None:
    needle = marker(kind, key)
    for i in issues:
        if i.get("status") == "cancelled":
            continue
        if needle in (i.get("description") or ""):
            return i
    return None


def find_goal(goals: list[dict], title: str) -> dict | None:
    for g in goals:
        if g.get("title") == title:
            return g
    return None


def ensure_goal(goals: list[dict], *, title: str, description: str, parent_id: str | None) -> dict:
    g = find_goal(goals, title)
    if g:
        patch = {}
        if (g.get("description") or "") != description:
            patch["description"] = description
        if parent_id and g.get("parentId") != parent_id:
            patch["parentId"] = parent_id
        if patch:
            g = http("PATCH", f"/goals/{g['id']}", patch)
            print(f"updated goal {title}")
        else:
            print(f"goal ok {title}")
        # refresh list
        for idx, x in enumerate(goals):
            if x["id"] == g["id"]:
                goals[idx] = g
                break
        return g
    payload = {
        "title": title,
        "description": description,
        "level": "company",
        "status": "active",
    }
    if parent_id:
        payload["parentId"] = parent_id
    g = http("POST", f"/companies/{CID}/goals", payload)
    goals.append(g)
    print(f"created goal {title}")
    return g


def ensure_project(
    projects: dict[str, dict],
    *,
    name: str,
    description: str,
    status: str,
    portfolio_goal_id: str,
) -> dict:
    key = name.lower()
    if key in projects:
        p = projects[key]
        patch: dict[str, Any] = {
            "description": description,
            "goalId": portfolio_goal_id,
            "goalIds": [portfolio_goal_id],
        }
        if p.get("status") != status and p.get("status") != "archived":
            # keep hotter status if already in_progress and target is planned
            order = {"backlog": 0, "planned": 1, "in_progress": 2, "completed": 3}
            if order.get(status, 0) >= order.get(p.get("status") or "backlog", 0):
                patch["status"] = status
        try:
            p = http("PATCH", f"/projects/{p['id']}", patch)
        except Exception as e:
            patch.pop("goalIds", None)
            p = http("PATCH", f"/projects/{p['id']}", patch)
            print(f"warn project patch {name}: {e}")
        projects[key] = p
        print(f"project {name} → portfolio linked ({p.get('status')})")
        return p
    payload = {
        "name": name,
        "description": description,
        "status": status,
        "goalId": portfolio_goal_id,
        "goalIds": [portfolio_goal_id],
    }
    try:
        p = http("POST", f"/companies/{CID}/projects", payload)
    except Exception:
        payload.pop("goalIds", None)
        p = http("POST", f"/companies/{CID}/projects", payload)
    projects[key] = p
    print(f"created project {name}")
    return p


def ensure_issue(
    issues: list[dict],
    *,
    kind: str,
    key: str,
    title: str,
    description_body: str,
    project_id: str,
    parent_id: str | None,
    status: str = "todo",
    priority: str = "medium",
) -> dict:
    m = marker(kind, key)
    desc = f"{m}\n\n{description_body}\n\n_kind=`{kind}` key=`{key}` · updated {now()}_"
    found = find_by_marker(issues, kind, key)
    # also match exact title if marker missing
    if not found:
        for i in issues:
            if i.get("status") == "cancelled":
                continue
            if i.get("title") == title and i.get("projectId") == project_id:
                found = i
                break
    if found:
        patch: dict[str, Any] = {"title": title, "description": desc, "projectId": project_id}
        if parent_id and found.get("parentId") != parent_id:
            patch["parentId"] = parent_id
        if found.get("status") in {"backlog", "todo"} and status in {"todo", "backlog", "done"}:
            if status != "in_progress":
                patch["status"] = status
        updated = http("PATCH", f"/issues/{found['id']}", patch)
        for idx, i in enumerate(issues):
            if i["id"] == updated["id"]:
                issues[idx] = updated
                break
        print(f"updated {updated.get('identifier')} [{kind}] {title[:50]}")
        return updated

    payload: dict[str, Any] = {
        "title": title,
        "description": desc,
        "status": "todo" if status == "in_progress" else status,
        "priority": priority,
        "projectId": project_id,
    }
    if parent_id:
        payload["parentId"] = parent_id
    created = http("POST", f"/companies/{CID}/issues", payload)
    issues.append(created)
    print(f"created {created.get('identifier')} [{kind}] {title[:50]}")
    return created


# ── Portfolio taxonomy from zer0 filesystem + boplog ──────────────────────
PORTFOLIOS = [
    {
        "key": "products",
        "title": "[Portfolio] Products",
        "fs": "products",
        "description": (
            "Ship-facing product surface under /workspace/zer0/products. "
            "Each durable product is a Paperclip Project; execution epochs/sprints/tasks are nested issues."
        ),
    },
    {
        "key": "experiments",
        "title": "[Portfolio] Experiments",
        "fs": "experiments",
        "description": (
            "Probes and taste tests under /workspace/zer0/experiments (+ experimental product folders). "
            "Promote to Products only with evidence gates."
        ),
    },
    {
        "key": "clients",
        "title": "[Portfolio] Clients",
        "fs": "clients",
        "description": "Client/engagement work under /workspace/zer0/clients.",
    },
    {
        "key": "oss",
        "title": "[Portfolio] OSS & Agent Factory",
        "fs": "oss",
        "description": (
            "Open-source and agent-runtime factory under /workspace/zer0/oss "
            "(Hermes, Paperclip fork, liquid-glass, t3code)."
        ),
    },
    {
        "key": "services",
        "title": "[Portfolio] Platform Services",
        "fs": "services",
        "description": (
            "Publishable platform nanoservices under /workspace/zer0/services "
            "(zer0-pm, cockpit, voice, harness-spine)."
        ),
    },
    {
        "key": "brand",
        "title": "[Portfolio] Brand & Growth",
        "fs": "portfolios",
        "description": (
            "Brand, X, revops, ventures under /workspace/zer0/portfolios plus boplog/portfolio public surfaces."
        ),
    },
    {
        "key": "ops",
        "title": "[Portfolio] Company Ops",
        "fs": None,
        "description": "Cross-cutting company operating system, intake, scoreboards, governance.",
    },
]

# product name → portfolio key
PRODUCT_PORTFOLIO: dict[str, str] = {
    # Products portfolio
    "Pokemon": "products",
    "SFT-SVLM": "products",
    "zerOS": "products",
    "GrowTwin": "products",
    "HomeForge": "products",
    "FlowState": "products",
    "zer0 Cockpit": "services",
    "zer0 Harness Spine": "services",
    "zer0 Voice": "services",
    "PM donor lab": "services",
    "PMFE review lab": "services",
    # OSS
    "Hermes Agent": "oss",
    "Paperclip": "oss",
    "Hermes Liquid Glass": "oss",
    "T3 Code reference": "oss",
    # Brand
    "boplog": "brand",
    "Portfolio & Brand": "brand",
    # Ops
    "Company Operations & Idea Inbox": "ops",
    # Experiments
    "COD": "experiments",
    "Halo": "experiments",
    "Expanse": "experiments",
    "4DPS": "experiments",
    "Harry Potter experiment": "experiments",
    "PvZ experiment": "experiments",
    "Monument experiment": "experiments",
    "Alpha": "experiments",
    "Flowkit": "experiments",
    "Netplay": "experiments",
    "Noop": "experiments",
    "Taste": "experiments",
}

# Hot products get an Epoch + current Sprint skeleton
HOT_EPOCHS: dict[str, dict[str, str]] = {
    "Pokemon": {
        "epoch_key": "pokemon/twilight-route",
        "epoch_title": "[Epoch] Twilight Route — AAA fidelity foundation",
        "sprint_key": "pokemon/twilight-route/current",
        "sprint_title": "[Sprint] Current Kanban cycle (twilight-route board)",
        "board": "twilight-route",
    },
    "Hermes Agent": {
        "epoch_key": "hermes/spatial-canvas",
        "epoch_title": "[Epoch] Spatial command center",
        "sprint_key": "hermes/spatial-canvas/current",
        "sprint_title": "[Sprint] Current Kanban cycle (spatial-canvas board)",
        "board": "spatial-canvas",
    },
    "Paperclip": {
        "epoch_key": "paperclip/company-os",
        "epoch_title": "[Epoch] Paperclip company OS v1",
        "sprint_key": "paperclip/company-os/current",
        "sprint_title": "[Sprint] Current Kanban cycle (paperclip-os board)",
        "board": "paperclip-os",
    },
    "SFT-SVLM": {
        "epoch_key": "sft-svlm/jarvis",
        "epoch_title": "[Epoch] Jarvis intelligence plane",
        "sprint_key": "sft-svlm/jarvis/current",
        "sprint_title": "[Sprint] Current Kanban cycle (jarvis-sft-svlm board)",
        "board": "jarvis-sft-svlm",
    },
    "boplog": {
        "epoch_key": "boplog/public-log",
        "epoch_title": "[Epoch] Public build log + brand feed",
        "sprint_key": "boplog/public-log/current",
        "sprint_title": "[Sprint] Current Kanban cycle (boplog-brand board)",
        "board": "boplog-brand",
    },
    "zerOS": {
        "epoch_key": "zeros/migration",
        "epoch_title": "[Epoch] zerOS → Paperclip migration",
        "sprint_key": "zeros/migration/current",
        "sprint_title": "[Sprint] Current Kanban cycle (zeros-migration board)",
        "board": "zeros-migration",
    },
}


def attach_kanban_roadmap_to_sprint(issues: list[dict], project_id: str, sprint_id: str, board: str) -> None:
    """Re-parent existing [Kanban roadmap] issue under the sprint."""
    for i in issues:
        if i.get("status") == "cancelled":
            continue
        if i.get("projectId") != project_id:
            continue
        title = i.get("title") or ""
        if not title.startswith("[Kanban roadmap]"):
            continue
        # also match board name loosely
        desc = i.get("description") or ""
        if board and board not in desc and board not in title.lower().replace(" ", "-"):
            # still allow if only one roadmap in project
            pass
        patch = {
            "parentId": sprint_id,
            "description": (
                desc
                + f"\n\n{marker('sprint', f'kanban:{board}')}\n"
                + f"_Attached under epoch sprint as Linear-style cycle container ({now()})._"
            ),
        }
        try:
            updated = http("PATCH", f"/issues/{i['id']}", patch)
            print(f"  linked roadmap {updated.get('identifier')} → sprint")
            # reparent children already under roadmap stay
        except Exception as e:
            print(f"  warn link roadmap {i.get('identifier')}: {e}")


def main() -> int:
    goals = http("GET", f"/companies/{CID}/goals")
    projects_list = http("GET", f"/companies/{CID}/projects")
    issues = http("GET", f"/companies/{CID}/issues?limit=500")
    projects = {p["name"].lower(): p for p in projects_list}

    mission = find_goal(
        goals,
        "Build autonomous systems that automate humanitarian causes and help more people turn ideas into working software.",
    )
    if not mission:
        raise SystemExit("mission goal missing — run reorg-zer0-company.py first")

    # 1) Portfolio goals
    portfolio_goals: dict[str, dict] = {}
    for p in PORTFOLIOS:
        g = ensure_goal(
            goals,
            title=p["title"],
            description=p["description"]
            + f"\n\n{marker('portfolio', p['key'])}\n"
            + "Linear/PM mapping: this Goal is a **portfolio** group-issue analogue.",
            parent_id=mission["id"],
        )
        portfolio_goals[p["key"]] = g

    # 2) Assign every project to a portfolio
    for pname, pkey in PRODUCT_PORTFOLIO.items():
        if pname.lower() not in projects:
            continue
        pg = portfolio_goals[pkey]
        # keep existing status
        cur = projects[pname.lower()].get("status") or "backlog"
        ensure_project(
            projects,
            name=pname,
            description=(projects[pname.lower()].get("description") or "")
            + f"\n\nPortfolio: {pg['title']} (`{pkey}`).",
            status=cur,
            portfolio_goal_id=pg["id"],
        )

    # Refresh
    projects_list = http("GET", f"/companies/{CID}/projects")
    projects = {p["name"].lower(): p for p in projects_list}
    issues = http("GET", f"/companies/{CID}/issues?limit=500")

    # 3) Epoch + Sprint for hot products
    for product_name, meta in HOT_EPOCHS.items():
        proj = projects.get(product_name.lower())
        if not proj:
            print(f"skip missing product {product_name}")
            continue
        epoch = ensure_issue(
            issues,
            kind="epoch",
            key=meta["epoch_key"],
            title=meta["epoch_title"],
            description_body=(
                f"Epoch container for **{product_name}**.\n\n"
                "Everything below is a sub-issue (Linear-style). "
                "Sprints/cycles hold executable work; Kanban board is the worker surface.\n\n"
                f"Kanban board: `{meta['board']}`"
            ),
            project_id=proj["id"],
            parent_id=None,
            status="todo",
            priority="high",
        )
        sprint = ensure_issue(
            issues,
            kind="sprint",
            key=meta["sprint_key"],
            title=meta["sprint_title"],
            description_body=(
                f"Current sprint/cycle under epoch `{meta['epoch_key']}`.\n\n"
                f"Hermes Kanban board `{meta['board']}` stories mirror as child tasks "
                "(via hermes-kanban-mirror). Do not treat Paperclip as the claim lock."
            ),
            project_id=proj["id"],
            parent_id=epoch["id"],
            status="todo",
            priority="high",
        )
        attach_kanban_roadmap_to_sprint(issues, proj["id"], sprint["id"], meta["board"])

        # Re-parent kanban mirrored story issues (children of old roadmap) stay;
        # also re-parent any loose mirrored stories under sprint if parent is roadmap
        issues = http("GET", f"/companies/{CID}/issues?limit=500")
        roadmap_ids = {
            i["id"]
            for i in issues
            if i.get("projectId") == proj["id"]
            and str(i.get("title", "")).startswith("[Kanban roadmap]")
        }
        for i in issues:
            if i.get("status") == "cancelled":
                continue
            if i.get("projectId") != proj["id"]:
                continue
            if i.get("parentId") in roadmap_ids:
                continue  # already under roadmap which is under sprint
            # mirrored tasks with kanban markers but wrong parent
            desc = i.get("description") or ""
            if "Kanban task:" in desc or "hermes-kanban-mirror:" in desc:
                if i.get("parentId") not in roadmap_ids and i.get("parentId") != sprint["id"]:
                    if str(i.get("title", "")).startswith("[Kanban roadmap]"):
                        continue
                    if str(i.get("title", "")).startswith("[Epoch]") or str(i.get("title", "")).startswith("[Sprint]"):
                        continue
                    try:
                        http(
                            "PATCH",
                            f"/issues/{i['id']}",
                            {"parentId": sprint["id"]},
                        )
                        print(f"  reparented {i.get('identifier')} → sprint")
                    except Exception as e:
                        print(f"  warn reparent {i.get('identifier')}: {e}")

    # 4) Charter issue under ops
    ops_proj = projects.get("company operations & idea inbox")
    if ops_proj:
        ensure_issue(
            issues,
            kind="task",
            key="ops/linear-hierarchy-charter",
            title="[Charter] Linear/PM hierarchy on Paperclip",
            description_body=(
                "# Everything is an issue\n\n"
                "Adopted from `products/pm` GROUP_KINDS + Linear practice.\n\n"
                "## Tree\n\n"
                "```text\n"
                "Company zer0\n"
                "└── [Portfolio] Goal\n"
                "    └── Product (Paperclip Project + workspace)\n"
                "        └── [Epoch] Issue\n"
                "            └── [Sprint] Issue  ← Kanban roadmap attaches here\n"
                "                └── Task Issues ← Kanban stories / human tasks\n"
                "```\n\n"
                "## Filesystem portfolios (`/workspace/zer0`)\n\n"
                "| Folder | Portfolio goal |\n"
                "|--------|----------------|\n"
                "| `products/` | [Portfolio] Products |\n"
                "| `experiments/` | [Portfolio] Experiments |\n"
                "| `clients/` | [Portfolio] Clients |\n"
                "| `oss/` | [Portfolio] OSS & Agent Factory |\n"
                "| `services/` | [Portfolio] Platform Services |\n"
                "| `portfolios/` | [Portfolio] Brand & Growth |\n"
                "| (ops) | [Portfolio] Company Ops |\n\n"
                "## Rules\n\n"
                "1. No second task graph — Paperclip issues are the company record; Hermes Kanban is execution.\n"
                "2. New work: create/find Product → current Epoch → current Sprint → Task.\n"
                "3. Group issues (epoch/sprint) stay unassigned; leaf tasks may be assigned.\n"
                "4. Experiments stay in Experiments portfolio until promote evidence lands.\n"
                f"\nApplied {now()}."
            ),
            project_id=ops_proj["id"],
            parent_id=None,
            status="todo",
            priority="high",
        )

    # Snapshot
    goals = http("GET", f"/companies/{CID}/goals")
    projects_list = http("GET", f"/companies/{CID}/projects")
    issues = http("GET", f"/companies/{CID}/issues?limit=500")
    print("\n=== SNAPSHOT ===")
    print("goals", len(goals))
    print("portfolio goals", sum(1 for g in goals if str(g.get("title", "")).startswith("[Portfolio]")))
    print("projects", len(projects_list))
    print(
        "epochs",
        sum(1 for i in issues if i.get("status") != "cancelled" and str(i.get("title", "")).startswith("[Epoch]")),
    )
    print(
        "sprints",
        sum(1 for i in issues if i.get("status") != "cancelled" and str(i.get("title", "")).startswith("[Sprint]")),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
