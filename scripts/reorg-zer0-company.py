#!/usr/bin/env python3
"""Reorganize Paperclip company zer0 around real workspace + boplog + Hermes work.

Idempotent. Safe to re-run.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any

API = os.environ.get("PAPERCLIP_API_URL", "http://127.0.0.1:3100/api").rstrip("/")
CID = os.environ.get("PAPERCLIP_COMPANY_ID", "c6ad4c58-9a56-4b63-bb0f-1ab9106e3261")


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
        raise RuntimeError(f"{method} {path} → {e.code}: {err[:600]}") from e


def ensure_goal(
    existing: dict[str, dict],
    *,
    title: str,
    level: str,
    description: str,
    parent_id: str | None = None,
    status: str = "active",
) -> dict:
    # Match by exact title
    for g in existing.values():
        if g.get("title") == title:
            patch = {}
            if g.get("description") != description:
                patch["description"] = description
            if g.get("status") != status:
                patch["status"] = status
            if parent_id and g.get("parentId") != parent_id:
                patch["parentId"] = parent_id
            if patch:
                updated = http("PATCH", f"/goals/{g['id']}", patch)
                existing[updated["id"]] = updated
                print(f"updated goal: {title}")
                return updated
            print(f"goal ok: {title}")
            return g
    payload = {
        "title": title,
        "description": description,
        "level": level,
        "status": status,
    }
    if parent_id:
        payload["parentId"] = parent_id
    created = http("POST", f"/companies/{CID}/goals", payload)
    existing[created["id"]] = created
    print(f"created goal: {title}")
    return created


def ensure_project(
    by_name: dict[str, dict],
    *,
    name: str,
    description: str,
    status: str,
    goal_ids: list[str] | None = None,
) -> dict:
    key = name.strip().lower()
    if key in by_name:
        p = by_name[key]
        patch: dict[str, Any] = {}
        if description and (p.get("description") or "") != description:
            patch["description"] = description
        if status and p.get("status") != status:
            # Don't demote archived
            if p.get("status") != "archived":
                patch["status"] = status
        if goal_ids:
            # Prefer goalIds multi if supported, else goalId first
            patch["goalIds"] = goal_ids
            patch["goalId"] = goal_ids[0]
        if patch:
            try:
                updated = http("PATCH", f"/projects/{p['id']}", patch)
                by_name[key] = updated
                print(f"updated project: {name} → {updated.get('status')}")
                return updated
            except Exception as e:
                # fallback without goalIds
                print(f"warn patch {name}: {e}")
                patch.pop("goalIds", None)
                if patch:
                    updated = http("PATCH", f"/projects/{p['id']}", patch)
                    by_name[key] = updated
                    print(f"updated project (fallback): {name}")
                    return updated
        print(f"project ok: {name}")
        return p

    payload: dict[str, Any] = {
        "name": name,
        "description": description,
        "status": status,
    }
    if goal_ids:
        payload["goalIds"] = goal_ids
        payload["goalId"] = goal_ids[0]
    try:
        created = http("POST", f"/companies/{CID}/projects", payload)
    except Exception:
        payload.pop("goalIds", None)
        created = http("POST", f"/companies/{CID}/projects", payload)
    by_name[key] = created
    print(f"created project: {name}")
    return created


def find_issue_by_title(issues: list[dict], title: str) -> dict | None:
    for i in issues:
        if i.get("status") == "cancelled":
            continue
        if i.get("title") == title:
            return i
    return None


def ensure_issue(
    issues: list[dict],
    *,
    title: str,
    description: str,
    status: str,
    project_id: str | None,
    priority: str = "medium",
    parent_id: str | None = None,
) -> dict:
    found = find_issue_by_title(issues, title)
    if found:
        patch: dict[str, Any] = {"description": description}
        if project_id and found.get("projectId") != project_id:
            patch["projectId"] = project_id
        if parent_id and found.get("parentId") != parent_id:
            patch["parentId"] = parent_id
        # only move status if still open-ish
        if found.get("status") in {"backlog", "todo", "in_progress", "blocked"} and status != found.get("status"):
            # Don't force in_progress without assignee
            if status != "in_progress":
                patch["status"] = status
        updated = http("PATCH", f"/issues/{found['id']}", patch)
        print(f"updated issue {updated.get('identifier')}: {title[:60]}")
        # refresh list entry
        for idx, i in enumerate(issues):
            if i["id"] == updated["id"]:
                issues[idx] = updated
                break
        return updated

    payload: dict[str, Any] = {
        "title": title,
        "description": description,
        "status": status if status != "in_progress" else "todo",
        "priority": priority,
    }
    if project_id:
        payload["projectId"] = project_id
    if parent_id:
        payload["parentId"] = parent_id
    created = http("POST", f"/companies/{CID}/issues", payload)
    issues.append(created)
    print(f"created issue {created.get('identifier')}: {title[:60]}")
    return created


def main() -> int:
    goals = {g["id"]: g for g in http("GET", f"/companies/{CID}/goals")}
    projects_list = http("GET", f"/companies/{CID}/projects")
    by_name = {p["name"].strip().lower(): p for p in projects_list}
    issues = http("GET", f"/companies/{CID}/issues?limit=500")

    # ── Goals (mission → lanes) ──────────────────────────────────────────
    mission = ensure_goal(
        goals,
        title="Build autonomous systems that automate humanitarian causes and help more people turn ideas into working software.",
        level="company",
        description=(
            "Company mission for zer0. All product, experiment, and brand work "
            "should compound toward autonomous systems that help people ship."
        ),
    )
    g_os = ensure_goal(
        goals,
        title="Run zer0 as a Paperclip-centered company OS",
        level="company",
        parent_id=mission["id"],
        description=(
            "Paperclip owns goals/projects/issues/approvals/budgets/evidence. "
            "Hermes Kanban owns execution stories and workers. "
            "Jarvis/sft-svlm owns context intelligence only. "
            "Mirror Kanban→Paperclip for roadmap/completion; do not dual-write execution queues."
        ),
    )
    g_ship = ensure_goal(
        goals,
        title="Ship useful products",
        level="company",
        parent_id=mission["id"],
        description=(
            "Focus shipping lanes (current heat): "
            "(1) Twilight Route / Pokemon AAA fidelity, "
            "(2) Hermes Desktop Spatial + liquid-glass operator UX, "
            "(3) Paperclip company OS integration, "
            "(4) SFT-SVLM/Jarvis personal intelligence plane, "
            "(5) zerOS stealth OS migration into Paperclip-governed ops."
        ),
    )
    g_factory = ensure_goal(
        goals,
        title="Build the open-source agent factory",
        level="company",
        parent_id=mission["id"],
        description=(
            "Public/agent-tooling surface: Hermes, Paperclip fork contributions, "
            "boplog, harness adapters, tmux fleet patterns. Prefer OSS when it compounds the factory."
        ),
    )
    g_exp = ensure_goal(
        goals,
        title="Run verified experiments",
        level="company",
        parent_id=mission["id"],
        description=(
            "Bounded probes (COD/Halo/Expanse/4DPS/Harry Potter/PvZ/etc.). "
            "Experiments must produce evidence or die; promote only with proof gates."
        ),
    )
    g_brand = ensure_goal(
        goals,
        title="Build brand and multi-platform presence in public",
        level="company",
        parent_id=mission["id"],
        description=(
            "Parallel brand pipeline: boplog (source of public truth), portfolio/3D shop, "
            "X, LinkedIn, GitHub profile. Ship narrative of real builds — not vapor. "
            "Every public claim should map to a boplog entry or demo URL."
        ),
    )
    g_learn = ensure_goal(
        goals,
        title="Compound organizational learning",
        level="company",
        parent_id=mission["id"],
        description=(
            "Capture skills, guardrails, evals, and postmortems from harness runs. "
            "Promote only after evaluation; never ungoverned self-mod of company law."
        ),
    )

    # ── Projects by lane ─────────────────────────────────────────────────
    # HOT / in_progress
    ensure_project(
        by_name,
        name="Pokemon",
        status="in_progress",
        goal_ids=[g_ship["id"]],
        description=(
            "Twilight Route — AAA-fidelity Pokemon-scale product. "
            "Hermes Kanban board: twilight-route. PokéAPI facts, COD topology sacred, "
            "creature pipeline guardrail (ZER-11). Primary ship lane."
        ),
    )
    ensure_project(
        by_name,
        name="Hermes Agent",
        status="in_progress",
        goal_ids=[g_factory["id"], g_os["id"]],
        description=(
            "Hermes monorepo + Desktop. Kanban board: spatial-canvas. "
            "Spatial command center, liquid-glass theming, operator UX. "
            "Execution surface for multi-agent work."
        ),
    )
    ensure_project(
        by_name,
        name="Paperclip",
        status="in_progress",
        goal_ids=[g_os["id"], g_factory["id"]],
        description=(
            "Company control plane (managed instance ~/.paperclip + kvnloo/paperclip fork). "
            "Sole production PM authority. Kanban mirror + routines + agent governance."
        ),
    )
    ensure_project(
        by_name,
        name="SFT-SVLM",
        status="in_progress",
        goal_ids=[g_ship["id"], g_os["id"]],
        description=(
            "Jarvis personal intelligence / twin factory. Context expand+learn plane. "
            "NOT a second issue tracker. Pipeline+private data on big disk."
        ),
    )
    ensure_project(
        by_name,
        name="zerOS",
        status="in_progress",
        goal_ids=[g_os["id"], g_ship["id"]],
        description=(
            "Stealth company OS (issues/harness/cockpit/voice lineage). "
            "Migrate operational authority into Paperclip; keep Brain as evidence/import source."
        ),
    )
    ensure_project(
        by_name,
        name="Company Operations & Idea Inbox",
        status="in_progress",
        goal_ids=[g_os["id"]],
        description=(
            "Cross-cutting ops, intake routines, portfolio scoreboard, and unscoped ideas. "
            "Default landing for harness idea intake."
        ),
    )

    # Brand / public
    ensure_project(
        by_name,
        name="boplog",
        status="in_progress",
        goal_ids=[g_brand["id"], g_factory["id"]],
        description=(
            "Public build-in-public log (kvnloo/boplog). Source of public project truth. "
            "Syncs GitHub authored repos; feeds portfolio shop + llms.txt."
        ),
    )
    ensure_project(
        by_name,
        name="Portfolio & Brand",
        status="in_progress",
        goal_ids=[g_brand["id"]],
        description=(
            "kvnloo portfolio site + interactive ramen/boba 3D shop + GitHub profile. "
            "X and LinkedIn distribution pipeline. Parallel brand surfaces over boplog truth."
        ),
    )
    ensure_project(
        by_name,
        name="Hermes Liquid Glass",
        status="in_progress",
        goal_ids=[g_factory["id"], g_brand["id"]],
        description=(
            "kvnloo/hermes-liquid-glass — Linux liquid glass for Hermes Desktop "
            "(pywal + Hyprland + runtime plugin). Public agent-tooling signal."
        ),
    )

    # Blueprint tracks (planned/active quieter)
    ensure_project(
        by_name,
        name="GrowTwin",
        status="planned",
        goal_ids=[g_ship["id"]],
        description="Blueprint world-sim / farm-to-table digital twin track (boplog: farm/ace lineage).",
    )
    ensure_project(
        by_name,
        name="HomeForge",
        status="planned",
        goal_ids=[g_ship["id"]],
        description="Home/automation product track; HITL phone review donor ideas.",
    )
    ensure_project(
        by_name,
        name="FlowState",
        status="planned",
        goal_ids=[g_ship["id"]],
        description="Blueprint health track (labs/nutrition/fitness/sleep).",
    )

    # zerOS component mirrors
    for name, desc in [
        ("zer0 Cockpit", "Read-only progress TUI/dashboard mirror of zerOS cockpit."),
        ("zer0 Harness Spine", "Thin harness contracts/adapters."),
        ("zer0 Voice", "Local-first voice runtime."),
        ("PM donor lab", "PM formalization lab — donor semantics only, not live PM."),
        ("PMFE review lab", "Phone-first review UX donor; fixture backend not production."),
    ]:
        ensure_project(
            by_name,
            name=name,
            status="planned",
            goal_ids=[g_os["id"]],
            description=desc,
        )

    # Experiments — keep backlog unless hot
    for name, desc in [
        ("COD", "Browser FPS / zero-binary-assets game taste experiment. Doctrine donor for Twilight."),
        ("Halo", "Halo CE-measured FPS experiment."),
        ("Expanse", "World/space experiment."),
        ("4DPS", "Stills/photospheres/4D packs for 3D web scenes."),
        ("Harry Potter experiment", "Wizard-sol / Harry Potter probe."),
        ("PvZ experiment", "Plants vs Zombies-shaped probe."),
        ("Monument experiment", "Monument Valley-shaped probe."),
        ("Alpha", "Alpha lane placeholder."),
        ("Flowkit", "Flow/kit experiment surface."),
        ("Netplay", "Netplay experiment."),
        ("Noop", "Noop / wearable research lineage."),
        ("Taste", "Taste/design probes."),
        ("T3 Code reference", "T3 Code reference clone for Hermes Desktop inspiration."),
    ]:
        ensure_project(
            by_name,
            name=name,
            status="backlog",
            goal_ids=[g_exp["id"]],
            description=desc,
        )

    # refresh
    projects_list = http("GET", f"/companies/{CID}/projects")
    by_name = {p["name"].strip().lower(): p for p in projects_list}
    ops = by_name["company operations & idea inbox"]
    poke = by_name["pokemon"]
    brand = by_name["portfolio & brand"]
    paper = by_name["paperclip"]

    # Fix ZER-11 project binding
    for i in issues:
        if i.get("identifier") == "ZER-11" and i.get("projectId") != poke["id"]:
            http(
                "PATCH",
                f"/issues/{i['id']}",
                {
                    "projectId": poke["id"],
                    "description": (
                        (i.get("description") or "")
                        + "\n\n_Re-bound to Pokemon project during company reorg "
                        f"({now()}). Kanban twin: twilight-route/t_fd71dcce / ZER-42._"
                    ),
                },
            )
            print("bound ZER-11 → Pokemon")

    # ── Portfolio scoreboard + strategy issues ───────────────────────────
    scoreboard_body = f"""# zer0 company portfolio scoreboard

_Generated {now()}_

## Operating law

1. **Paperclip** = sole production PM/control plane (goals, projects, issues, approvals, budgets, evidence).
2. **Hermes Kanban** = execution surface (per-product boards, workers, 24/7 loops).
3. **Jarvis / sft-svlm** = context intelligence only (expand/learn) — never a second issue graph.
4. **boplog** = public authored-work truth for brand; portfolio/X/LinkedIn amplify it.
5. AI speed creates scatter — **one board of record per product (Kanban)** + **one company scaffold (Paperclip)**.

## Focus heat (current)

| Priority | Project | Why | Hermes board / signal |
|---:|---|---|---|
| P0 | Pokemon / Twilight Route | AAA ship lane, active Kanban | `twilight-route` (15/17 done) |
| P0 | Hermes Agent + Spatial | Operator OS / desktop | `spatial-canvas` (2/4) |
| P0 | Paperclip | Company OS | managed `127.0.0.1:3100` |
| P1 | SFT-SVLM / Jarvis | Context twin | gateway + contract |
| P1 | boplog + Portfolio & Brand | Public narrative + X/LinkedIn | github.com/kvnloo/boplog |
| P1 | Hermes Liquid Glass | Public agent-tooling craft | recent GH pushes |
| P2 | zerOS family | Stealth OS → Paperclip migration | dirty long-lived tree |
| P3 | Experiments (COD/Halo/…) | Taste probes | promote only with proof |

## Brand pipeline (parallel)

| Surface | Role | URL / path |
|---|---|---|
| boplog | Public build log SoT | https://kvnloo.github.io/boplog/ |
| Portfolio site | Professional packaging | https://kvnloo.github.io/portfolio/ |
| 3D shop | Interactive brand demo | portfolio/demos/room |
| GitHub profile | Developer identity | github.com/kvnloo |
| X | Fast public shipping narrative | (operator) |
| LinkedIn | Professional narrative | (operator) |

Rule: **no public claim without a boplog/GitHub artifact**.

## Workspace reality check

- ~227 git checkouts under `/workspace` (many worktrees).
- Only a handful are **hot**. Everything else is donor/archive/experiment unless promoted.
- Do not open a new worktree when main is dirty and no other agent is active — commit on main.

## How to use this company daily

1. Pick **one P0 product** focus block.
2. Execute on **Hermes Kanban** for that product.
3. Let the 15m Kanban→Paperclip mirror update roadmaps.
4. Once/day: scan Paperclip roadmaps + boplog for brand posts.
5. Once/week: kill or archive cold experiments; promote only proven lanes.

## Gaps still open

- Most Paperclip projects still lack Kanban boards (only twilight + spatial mirrored).
- Agents mostly paused — intentional until dual-service gates are green.
- Brand posting is not yet automated (needs human taste gate).
- SFT-SVLM corpus path still empty (datasets/exports/raw).
"""

    scoreboard = ensure_issue(
        issues,
        title="[Scoreboard] zer0 company portfolio & operating map",
        description=scoreboard_body,
        status="todo",
        project_id=ops["id"],
        priority="high",
    )
    try:
        payload: dict[str, Any] = {
            "title": "zer0 portfolio scoreboard",
            "format": "markdown",
            "body": scoreboard_body,
        }
        try:
            existing_doc = http("GET", f"/issues/{scoreboard['id']}/documents/scoreboard")
            if isinstance(existing_doc, dict):
                rev = existing_doc.get("latestRevisionId") or existing_doc.get("revisionId")
                if not rev and isinstance(existing_doc.get("latestRevision"), dict):
                    rev = existing_doc["latestRevision"].get("id")
                if rev:
                    payload["baseRevisionId"] = rev
        except Exception:
            pass
        http(
            "PUT",
            f"/issues/{scoreboard['id']}/documents/scoreboard",
            payload,
        )
    except Exception as e:
        print(f"warn scoreboard doc: {e}")

    ensure_issue(
        issues,
        title="Brand lane: weekly X + LinkedIn shipping narrative from boplog",
        description=(
            "Operator brand pipeline.\n\n"
            "## Goal\n"
            "Post real shipping narrative on X and LinkedIn in parallel with product work — "
            "sourced only from boplog entries, demos, and verified commits.\n\n"
            "## Cadence\n"
            "- 3–5 X posts/week from actual builds (Twilight, Hermes Spatial, Paperclip, liquid-glass, boplog itself)\n"
            "- 1–2 LinkedIn posts/week (deeper craft / systems narrative)\n"
            "- Never invent progress; link boplog/GitHub/demo\n\n"
            "## Acceptance\n"
            "- Checklist of next 4 posts drafted from last 14 days of boplog/GH activity\n"
            "- Tracking comment after each post with URL\n"
            "- No secrets/paths from private machines\n\n"
            f"_Created during company reorg {now()}_"
        ),
        status="todo",
        project_id=brand["id"],
        priority="high",
    )

    ensure_issue(
        issues,
        title="Create Hermes Kanban boards for remaining P0/P1 Paperclip projects",
        description=(
            "Execution boards exist only for `twilight-route` and `spatial-canvas`.\n\n"
            "Create product boards + wire `scripts/hermes-kanban-mirror.py` BOARD_PROJECT_MAP for:\n"
            "- paperclip-os (Paperclip)\n"
            "- jarvis-sft-svlm (SFT-SVLM)\n"
            "- boplog-brand (boplog + Portfolio & Brand)\n"
            "- zeros-migration (zerOS)\n\n"
            "Keep one board per durable product. Do not create boards for cold experiments.\n\n"
            f"_Created during company reorg {now()}_"
        ),
        status="todo",
        project_id=paper["id"],
        priority="high",
    )

    ensure_issue(
        issues,
        title="Freeze experiment promotions: COD/Halo/etc require evidence gate before P0 time",
        description=(
            "Scatter control.\n\n"
            "Experiments stay backlog unless they produce:\n"
            "1. playable demo or measurable eval,\n"
            "2. written promote/kill decision,\n"
            "3. explicit Paperclip status change to planned/in_progress.\n\n"
            "Default: Twilight + Hermes + Paperclip + brand eat calendar first.\n\n"
            f"_Created during company reorg {now()}_"
        ),
        status="todo",
        project_id=ops["id"],
        priority="medium",
    )

    # Comment on ZER-2
    http(
        "POST",
        f"/issues/{next(i['id'] for i in issues if i.get('identifier')=='ZER-2')}/comments",
        {
            "body": (
                "## Company reorg applied (workspace + boplog + Hermes audit)\n\n"
                f"At {now()} Paperclip zer0 was reorganized from live evidence:\n\n"
                "- **227** workspace git checkouts audited (most are worktrees/cold)\n"
                "- **boplog hierarchy** used as public taxonomy SoT\n"
                "- **Hermes Kanban** remains execution SoT (`twilight-route`, `spatial-canvas`)\n"
                "- Goals expanded with parent mission + OS / ship / factory / experiments / **brand** / learning\n"
                "- Projects restated with accurate descriptions + heat statuses\n"
                "- New projects: **boplog**, **Portfolio & Brand**, **Hermes Liquid Glass**, **FlowState**\n"
                "- Scoreboard issue: **[Scoreboard] zer0 company portfolio & operating map**\n"
                "- Brand pipeline issue for X+LinkedIn from boplog truth\n"
                "- Board coverage issue for remaining P0/P1 Kanban boards\n\n"
                "Paperclip is now the strategic scaffold; Hermes Kanban stays the worker surface."
            )
        },
    )
    print("commented ZER-2")

    # Final snapshot
    projects_list = http("GET", f"/companies/{CID}/projects")
    goals = http("GET", f"/companies/{CID}/goals")
    issues = http("GET", f"/companies/{CID}/issues?limit=500")
    active = [i for i in issues if i.get("status") != "cancelled"]
    print("\n=== FINAL SNAPSHOT ===")
    print("goals", len(goals))
    print("projects", len(projects_list))
    print("active issues", len(active))
    from collections import Counter

    print("projects by status", Counter(p["status"] for p in projects_list))
    print("issues by status", Counter(i["status"] for i in active))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
