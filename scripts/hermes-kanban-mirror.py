#!/usr/bin/env python3
"""Mirror Hermes Kanban boards into Paperclip as a strategic scaffold.

Authority split (locked):
  - Hermes Kanban = execution surface (stories, workers, lanes)
  - Paperclip     = company OS (projects, roadmap, completion, strategy)
  - This script   = one-way idempotent mirror Kanban → Paperclip

Does NOT:
  - assign Paperclip agents to do Kanban work
  - claim/checkout Kanban tasks
  - create a second execution queue

Does:
  - map each Kanban board → Paperclip project
  - upsert one Paperclip issue per Kanban task with origin provenance
  - upsert one roadmap parent issue per board with completion rollup
  - keep statuses aligned so strategy view tracks 24/7 loops
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_API = os.environ.get("PAPERCLIP_API_URL", "http://127.0.0.1:3100/api").rstrip("/")
DEFAULT_COMPANY = os.environ.get(
    "PAPERCLIP_COMPANY_ID", "c6ad4c58-9a56-4b63-bb0f-1ab9106e3261"
)
HERMES_HOME = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
STATE_PATH = Path(
    os.environ.get(
        "PAPERCLIP_KANBAN_MIRROR_STATE",
        str(Path.home() / ".paperclip/instances/default/data/hermes-kanban-mirror-state.json"),
    )
)

# Board slug → Paperclip project name (resolved at runtime by name).
BOARD_PROJECT_MAP: dict[str, str] = {
    "twilight-route": "Pokemon",
    "spatial-canvas": "Hermes Agent",
    "paperclip-os": "Paperclip",
    "jarvis-sft-svlm": "SFT-SVLM",
    "boplog-brand": "boplog",
    "zeros-migration": "zerOS",
    "default": "Company Operations & Idea Inbox",
}

# Kanban status → Paperclip issue status
# Note: Paperclip requires an assignee for `in_progress`. Mirrored scaffold
# issues stay unassigned (execution lives on Kanban), so "running" maps to
# `todo` and the description/title carry live Kanban state.
STATUS_MAP = {
    "done": "done",
    "running": "todo",
    "ready": "todo",
    # Paperclip only accepts `blocked` when its own blocker/approval metadata
    # exists. Kanban is authoritative for execution blockers, so mirrored
    # issues remain actionable `todo` rows and carry the state in their title.
    "blocked": "todo",
    "todo": "backlog",
    "scheduled": "backlog",
    "archived": "cancelled",
}

ORIGIN_KIND = "hermes_kanban"
MIRROR_MARKER = "<!-- hermes-kanban-mirror:"
MIRROR_RE = re.compile(
    r"<!--\s*hermes-kanban-mirror:(?P<board>[^/]+)/(?P<task>[^\s]+)\s*-->",
    re.I,
)
KANBAN_TASK_RE = re.compile(
    r"\*\*Kanban task:\*\*\s*`(?P<task>[^`]+)`",
    re.I,
)
KANBAN_BOARD_RE = re.compile(
    r"Hermes Kanban board\s+`(?P<board>[^`]+)`",
    re.I,
)
ROADMAP_TASK_ID = "__roadmap__"


@dataclass
class KanbanTask:
    board: str
    board_name: str
    task_id: str
    title: str
    body: str
    status: str
    priority: int | None
    workspace_path: str | None
    project_id: str | None
    session_id: str | None
    created_at: str | None
    completed_at: str | None
    result: str | None


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def fp_for(board: str, task_id: str) -> str:
    raw = f"{ORIGIN_KIND}:{board}:{task_id}"
    return hashlib.sha256(raw.encode()).hexdigest()[:32]


def origin_id_for(board: str, task_id: str) -> str:
    return f"{board}/{task_id}"


def http_json(
    method: str,
    url: str,
    payload: dict[str, Any] | None = None,
    api_key: str | None = None,
) -> Any:
    data = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = resp.read().decode()
            return json.loads(body) if body else None
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", "replace")
        raise RuntimeError(f"{method} {url} → {e.code}: {err[:800]}") from e


def discover_board_dbs() -> list[tuple[str, str, Path]]:
    """Return list of (slug, display_name, db_path)."""
    out: list[tuple[str, str, Path]] = []
    default_db = HERMES_HOME / "kanban.db"
    if default_db.exists():
        out.append(("default", "Default", default_db))
    boards_root = HERMES_HOME / "kanban" / "boards"
    if boards_root.is_dir():
        for child in sorted(boards_root.iterdir()):
            db = child / "kanban.db"
            if db.exists():
                slug = child.name
                # Prefer a nicer name from slug
                name = slug.replace("-", " ").title()
                out.append((slug, name, db))
    return out


def read_tasks(board: str, board_name: str, db: Path) -> list[KanbanTask]:
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        rows = con.execute(
            """
            SELECT id, title, body, status, priority, workspace_path, project_id,
                   session_id, created_at, completed_at, result
            FROM tasks
            WHERE COALESCE(status, '') != 'archived'
            ORDER BY created_at ASC
            """
        ).fetchall()
    except sqlite3.Error:
        # older/empty schema
        return []
    finally:
        con.close()

    tasks: list[KanbanTask] = []
    for r in rows:
        tasks.append(
            KanbanTask(
                board=board,
                board_name=board_name,
                task_id=str(r["id"]),
                title=(r["title"] or "").strip() or f"Untitled {r['id']}",
                body=(r["body"] or "").strip(),
                status=(r["status"] or "todo").strip().lower(),
                priority=r["priority"],
                workspace_path=r["workspace_path"],
                project_id=r["project_id"],
                session_id=r["session_id"],
                created_at=str(r["created_at"]) if r["created_at"] is not None else None,
                completed_at=str(r["completed_at"]) if r["completed_at"] is not None else None,
                result=(r["result"] or None),
            )
        )
    return tasks


def priority_to_paperclip(p: int | None) -> str:
    # Paperclip issue priority is an enum, not an int.
    if p is None:
        return "medium"
    try:
        n = int(p)
    except Exception:
        return "medium"
    if n <= 0:
        return "critical"
    if n == 1:
        return "high"
    if n == 2:
        return "medium"
    return "low"


def map_status(kanban_status: str) -> str:
    return STATUS_MAP.get(kanban_status, "backlog")


def issue_description(task: KanbanTask) -> str:
    marker = f"{MIRROR_MARKER}{task.board}/{task.task_id} -->"
    lines = [
        marker,
        f"Mirrored from Hermes Kanban board `{task.board}` (`{task.board_name}`).",
        "",
        f"- **Kanban task:** `{task.task_id}`",
        f"- **Kanban status:** `{task.status}`",
        f"- **Mirror key:** `{origin_id_for(task.board, task.task_id)}`",
        "",
        "Execution authority stays on the Hermes Kanban board / workers.",
        "This Paperclip issue is strategic tracking only — do not treat it as a second claim lock.",
        "",
    ]
    if task.workspace_path:
        lines.append(f"- **Workspace:** `{task.workspace_path}`")
    if task.session_id:
        lines.append(f"- **Hermes session:** `{task.session_id}`")
    if task.created_at:
        lines.append(f"- **Created (kanban):** {task.created_at}")
    if task.completed_at:
        lines.append(f"- **Completed (kanban):** {task.completed_at}")
    if task.body:
        lines.extend(["", "## Kanban body", "", task.body[:6000]])
    if task.result:
        lines.extend(["", "## Kanban result", "", str(task.result)[:4000]])
    lines.extend(
        [
            "",
            f"_Last mirrored: {utc_now()}_",
        ]
    )
    return "\n".join(lines)


def load_state() -> dict[str, Any]:
    if not STATE_PATH.exists():
        return {"version": 1, "byKey": {}}
    try:
        data = json.loads(STATE_PATH.read_text())
        if not isinstance(data, dict):
            return {"version": 1, "byKey": {}}
        data.setdefault("version", 1)
        data.setdefault("byKey", {})
        return data
    except Exception:
        return {"version": 1, "byKey": {}}


def save_state(state: dict[str, Any]) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n")
    tmp.replace(STATE_PATH)


def parse_mirror_key(issue: dict[str, Any]) -> str | None:
    desc = issue.get("description") or ""
    m = MIRROR_RE.search(desc)
    if m:
        return origin_id_for(m.group("board"), m.group("task"))
    # legacy first-pass descriptions without HTML marker
    tm = KANBAN_TASK_RE.search(desc)
    bm = KANBAN_BOARD_RE.search(desc)
    if tm and bm:
        return origin_id_for(bm.group("board"), tm.group("task"))
    title = issue.get("title") or ""
    if title.startswith("[Kanban roadmap]"):
        # recover board from description
        bm = KANBAN_BOARD_RE.search(desc)
        if bm:
            return origin_id_for(bm.group("board"), ROADMAP_TASK_ID)
    return None


def index_existing_issues(
    api: str,
    company_id: str,
    api_key: str | None,
    state: dict[str, Any],
) -> dict[str, dict[str, Any]]:
    """Map mirror key board/task -> newest surviving issue."""
    issues = http_json("GET", f"{api}/companies/{company_id}/issues?limit=500", api_key=api_key)
    if not isinstance(issues, list):
        raise RuntimeError(f"unexpected issues payload: {type(issues)}")

    by_id = {str(i.get("id")): i for i in issues if i.get("id")}
    by_key: dict[str, dict[str, Any]] = {}

    # 1) state file
    for key, meta in list((state.get("byKey") or {}).items()):
        issue_id = str((meta or {}).get("issueId") or "")
        issue = by_id.get(issue_id)
        if issue and issue.get("status") != "cancelled":
            by_key[key] = issue

    # 2) recover from description markers
    for issue in issues:
        if issue.get("status") == "cancelled":
            continue
        key = parse_mirror_key(issue)
        if not key:
            continue
        prev = by_key.get(key)
        if not prev:
            by_key[key] = issue
            continue
        # keep oldest created (stable canonical), prefer non-cancelled
        prev_c = str(prev.get("createdAt") or "")
        cur_c = str(issue.get("createdAt") or "")
        if cur_c and (not prev_c or cur_c < prev_c):
            by_key[key] = issue

    return by_key


def cancel_duplicate_mirrors(
    api: str,
    company_id: str,
    api_key: str | None,
    canonical: dict[str, dict[str, Any]],
    dry_run: bool,
) -> int:
    """Cancel non-canonical mirrored issues so the board stays clean."""
    issues = http_json("GET", f"{api}/companies/{company_id}/issues?limit=500", api_key=api_key)
    if not isinstance(issues, list):
        return 0
    cancelled = 0
    canon_ids = {str(v.get("id")) for v in canonical.values() if v.get("id")}
    for issue in issues:
        if issue.get("status") == "cancelled":
            continue
        key = parse_mirror_key(issue)
        if not key:
            continue
        if str(issue.get("id")) in canon_ids:
            continue
        # duplicate of a known key, or orphan mirror without canonical yet
        if key in canonical or MIRROR_RE.search(issue.get("description") or "") or KANBAN_TASK_RE.search(issue.get("description") or ""):
            if dry_run:
                print(f"dry-run cancel dup {issue.get('identifier')} key={key}")
            else:
                http_json(
                    "PATCH",
                    f"{api}/issues/{issue['id']}",
                    {
                        "status": "cancelled",
                        "description": (
                            (issue.get("description") or "")
                            + f"\n\n_Cancelled as duplicate Kanban mirror of `{key}` at {utc_now()}_"
                        ),
                    },
                    api_key=api_key,
                )
                print(f"cancelled duplicate {issue.get('identifier')} ({key})")
            cancelled += 1
    return cancelled


def remember_issue(state: dict[str, Any], key: str, issue: dict[str, Any]) -> None:
    state.setdefault("byKey", {})[key] = {
        "issueId": issue.get("id"),
        "identifier": issue.get("identifier"),
        "updatedAt": utc_now(),
    }


def roadmap_markdown(
    board: str, board_name: str, tasks: list[KanbanTask], mapped: list[dict[str, Any]]
) -> str:
    total = len(tasks)
    by: dict[str, int] = {}
    for t in tasks:
        by[t.status] = by.get(t.status, 0) + 1
    done = by.get("done", 0)
    running = by.get("running", 0)
    ready = by.get("ready", 0)
    blocked = by.get("blocked", 0)
    pct = int(round((done / total) * 100)) if total else 0

    lines = [
        f"# {board_name} — Kanban roadmap mirror",
        "",
        f"Board slug: `{board}`  ",
        f"Mirrored at: {utc_now()}  ",
        f"Completion: **{done}/{total} done ({pct}%)**  ",
        f"Live: running={running}, ready={ready}, blocked={blocked}",
        "",
        "## Status breakdown",
        "",
        "| Kanban status | Count |",
        "|---|---:|",
    ]
    for k in sorted(by, key=lambda x: (-by[x], x)):
        lines.append(f"| `{k}` | {by[k]} |")

    lines.extend(["", "## Stories", ""])
    order = {"running": 0, "ready": 1, "blocked": 2, "todo": 3, "scheduled": 4, "done": 5}
    for t, m in sorted(
        zip(tasks, mapped),
        key=lambda pair: (order.get(pair[0].status, 9), pair[0].title.lower()),
    ):
        ident = m.get("identifier") or m.get("id", "?")
        lines.append(f"- [{t.status}] **{ident}** — {t.title} (`{t.task_id}`)")

    lines.extend(
        [
            "",
            "## Operating contract",
            "",
            "1. Hermes Kanban workers execute and complete stories on this board.",
            "2. Paperclip mirrors those stories for portfolio / roadmap / strategy.",
            "3. Do not re-assign these mirrored issues to harnesses unless promoting a strategic initiative.",
            "4. Human strategy edits belong on Paperclip goals/projects; execution edits belong on Kanban.",
            "",
        ]
    )
    return "\n".join(lines)


def index_projects(api: str, company_id: str, api_key: str | None) -> dict[str, dict[str, Any]]:
    projects = http_json("GET", f"{api}/companies/{company_id}/projects", api_key=api_key)
    if not isinstance(projects, list):
        raise RuntimeError("unexpected projects payload")
    by_name = {str(p.get("name", "")).strip().lower(): p for p in projects}
    return by_name


def ensure_project(
    api: str,
    company_id: str,
    api_key: str | None,
    by_name: dict[str, dict[str, Any]],
    board: str,
    board_name: str,
    dry_run: bool,
) -> dict[str, Any]:
    wanted = BOARD_PROJECT_MAP.get(board, board_name)
    key = wanted.strip().lower()
    if key in by_name:
        proj = by_name[key]
        # Promote backlog projects that now have live kanban activity
        if proj.get("status") == "backlog" and not dry_run:
            try:
                updated = http_json(
                    "PATCH",
                    f"{api}/projects/{proj['id']}",
                    {"status": "in_progress"},
                    api_key=api_key,
                )
                if isinstance(updated, dict):
                    by_name[key] = updated
                    return updated
            except Exception as e:
                print(f"warn: could not promote project {wanted}: {e}", file=sys.stderr)
        return proj

    payload = {
        "name": wanted,
        "description": (
            f"Auto-scaffolded from Hermes Kanban board `{board}`. "
            "Execution remains on Kanban; Paperclip holds roadmap/completion."
        ),
        "status": "in_progress",
    }
    if dry_run:
        print(f"dry-run create project {wanted}")
        fake = {"id": f"dry-{board}", "name": wanted, "status": "in_progress"}
        by_name[key] = fake
        return fake
    created = http_json("POST", f"{api}/companies/{company_id}/projects", payload, api_key=api_key)
    if not isinstance(created, dict):
        raise RuntimeError(f"project create failed for {wanted}")
    by_name[key] = created
    print(f"created project {created.get('name')} ({created.get('id')})")
    return created


def upsert_issue(
    api: str,
    company_id: str,
    api_key: str | None,
    existing: dict[str, dict[str, Any]],
    state: dict[str, Any],
    project_id: str,
    task: KanbanTask,
    parent_id: str | None,
    dry_run: bool,
) -> dict[str, Any]:
    key = origin_id_for(task.board, task.task_id)
    desired_status = map_status(task.status)
    title = task.title[:200]
    if task.status in {"running", "blocked"}:
        prefix = f"[{task.status.upper()} on Kanban]"
        if not title.lower().startswith(prefix.lower()):
            title = f"{prefix} {title}"[:200]
    description = issue_description(task)

    found = existing.get(key)
    if found:
        patch: dict[str, Any] = {}
        if found.get("title") != title:
            patch["title"] = title
        if found.get("status") != desired_status:
            if not (found.get("status") == "cancelled" and task.status != "archived"):
                patch["status"] = desired_status
        if found.get("projectId") != project_id:
            patch["projectId"] = project_id
        if parent_id and found.get("parentId") != parent_id:
            patch["parentId"] = parent_id
        patch["description"] = description
        if dry_run:
            print(f"dry-run patch {found.get('identifier')} {list(patch)}")
            remember_issue(state, key, {**found, **patch})
            return {**found, **patch}
        updated = http_json("PATCH", f"{api}/issues/{found['id']}", patch, api_key=api_key)
        if isinstance(updated, dict):
            existing[key] = updated
            remember_issue(state, key, updated)
            print(
                f"updated {updated.get('identifier')} ← {task.task_id} "
                f"[{task.status}→{desired_status}]"
            )
            return updated
        remember_issue(state, key, found)
        return found

    payload = {
        "title": title,
        "description": description,
        "status": desired_status,
        "priority": priority_to_paperclip(task.priority),
        "projectId": project_id,
    }
    if parent_id:
        payload["parentId"] = parent_id
    if dry_run:
        print(f"dry-run create issue {title} ({key})")
        fake = {
            "id": f"dry-{key}",
            "identifier": f"DRY-{task.task_id[-4:]}",
            "title": title,
            "status": desired_status,
        }
        existing[key] = fake
        remember_issue(state, key, fake)
        return fake
    created = http_json("POST", f"{api}/companies/{company_id}/issues", payload, api_key=api_key)
    if not isinstance(created, dict):
        raise RuntimeError(f"issue create failed for {key}")
    existing[key] = created
    remember_issue(state, key, created)
    print(f"created {created.get('identifier')} ← {task.task_id} [{desired_status}]")
    return created


def upsert_roadmap_parent(
    api: str,
    company_id: str,
    api_key: str | None,
    existing: dict[str, dict[str, Any]],
    state: dict[str, Any],
    project_id: str,
    board: str,
    board_name: str,
    tasks: list[KanbanTask],
    dry_run: bool,
) -> dict[str, Any]:
    key = origin_id_for(board, ROADMAP_TASK_ID)
    done = sum(1 for t in tasks if t.status == "done")
    total = len(tasks)
    pct = int(round((done / total) * 100)) if total else 0
    running = sum(1 for t in tasks if t.status == "running")
    title = f"[Kanban roadmap] {board_name} — {done}/{total} done ({pct}%)"
    status = "done" if total and done == total and running == 0 else "todo"
    description = (
        f"{MIRROR_MARKER}{board}/{ROADMAP_TASK_ID} -->\n"
        f"Strategic parent for Hermes Kanban board `{board}`.\n\n"
        f"Completion **{done}/{total} ({pct}%)**. "
        f"Running={running}.\n\n"
        "Child issues are mirrored Kanban stories. Execution remains on Hermes Kanban.\n"
        f"\n_Last mirrored: {utc_now()}_"
    )

    found = existing.get(key)
    if found:
        patch = {
            "title": title,
            "description": description,
            "status": status,
            "projectId": project_id,
        }
        if dry_run:
            print(f"dry-run patch roadmap {found.get('identifier')}")
            remember_issue(state, key, {**found, **patch})
            return {**found, **patch}
        updated = http_json("PATCH", f"{api}/issues/{found['id']}", patch, api_key=api_key)
        if isinstance(updated, dict):
            existing[key] = updated
            remember_issue(state, key, updated)
            print(f"updated roadmap {updated.get('identifier')} ({pct}%)")
            return updated
        remember_issue(state, key, found)
        return found

    payload = {
        "title": title,
        "description": description,
        "status": status,
        "priority": "high",
        "projectId": project_id,
    }
    if dry_run:
        fake = {
            "id": f"dry-roadmap-{board}",
            "identifier": f"DRY-RM-{board[:4]}",
            "title": title,
            "status": status,
        }
        existing[key] = fake
        remember_issue(state, key, fake)
        return fake
    created = http_json("POST", f"{api}/companies/{company_id}/issues", payload, api_key=api_key)
    if not isinstance(created, dict):
        raise RuntimeError("roadmap create failed")
    existing[key] = created
    remember_issue(state, key, created)
    print(f"created roadmap {created.get('identifier')} ({pct}%)")
    return created


def write_roadmap_document(
    api: str,
    api_key: str | None,
    roadmap_issue: dict[str, Any],
    board: str,
    board_name: str,
    tasks: list[KanbanTask],
    children: list[dict[str, Any]],
    dry_run: bool,
) -> None:
    body = roadmap_markdown(board, board_name, tasks, children)
    if dry_run:
        print(f"dry-run roadmap doc {len(body)} chars")
        return
    issue_id = roadmap_issue.get("id")
    if not issue_id or str(issue_id).startswith("dry-"):
        return
    try:
        # Fetch current revision for optimistic update when doc exists
        payload: dict[str, Any] = {
            "title": f"{board_name} Kanban roadmap",
            "format": "markdown",
            "body": body,
        }
        try:
            existing_doc = http_json(
                "GET", f"{api}/issues/{issue_id}/documents/roadmap", api_key=api_key
            )
            if isinstance(existing_doc, dict):
                rev = existing_doc.get("latestRevisionId") or existing_doc.get("revisionId")
                if not rev and isinstance(existing_doc.get("latestRevision"), dict):
                    rev = existing_doc["latestRevision"].get("id")
                if rev:
                    payload["baseRevisionId"] = rev
        except Exception:
            pass
        http_json(
            "PUT",
            f"{api}/issues/{issue_id}/documents/roadmap",
            payload,
            api_key=api_key,
        )
        print(f"wrote roadmap document on {roadmap_issue.get('identifier')}")
    except Exception as e:
        print(f"warn: roadmap document write failed: {e}", file=sys.stderr)


def mirror_board(
    api: str,
    company_id: str,
    api_key: str | None,
    projects_by_name: dict[str, dict[str, Any]],
    existing: dict[str, dict[str, Any]],
    state: dict[str, Any],
    board: str,
    board_name: str,
    db: Path,
    dry_run: bool,
) -> dict[str, Any]:
    tasks = read_tasks(board, board_name, db)
    if board == "default" and not tasks:
        return {"board": board, "skipped": True, "reason": "empty default board"}

    project = ensure_project(
        api, company_id, api_key, projects_by_name, board, board_name, dry_run
    )
    roadmap = upsert_roadmap_parent(
        api,
        company_id,
        api_key,
        existing,
        state,
        project["id"],
        board,
        board_name,
        tasks,
        dry_run,
    )
    children: list[dict[str, Any]] = []
    for task in tasks:
        child = upsert_issue(
            api,
            company_id,
            api_key,
            existing,
            state,
            project["id"],
            task,
            roadmap.get("id"),
            dry_run,
        )
        children.append(child)

    write_roadmap_document(
        api, api_key, roadmap, board, board_name, tasks, children, dry_run
    )

    done = sum(1 for t in tasks if t.status == "done")
    return {
        "board": board,
        "project": project.get("name"),
        "projectId": project.get("id"),
        "tasks": len(tasks),
        "done": done,
        "roadmap": roadmap.get("identifier"),
        "skipped": False,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--api", default=DEFAULT_API)
    ap.add_argument("--company-id", default=DEFAULT_COMPANY)
    ap.add_argument("--api-key", default=os.environ.get("PAPERCLIP_API_KEY"))
    ap.add_argument("--board", action="append", help="Only mirror these board slugs")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--cleanup-dupes", action="store_true", default=True)
    ap.add_argument("--no-cleanup-dupes", action="store_false", dest="cleanup_dupes")
    ap.add_argument("--json", action="store_true", help="Print machine-readable summary")
    args = ap.parse_args()

    boards = discover_board_dbs()
    if args.board:
        wanted = set(args.board)
        boards = [b for b in boards if b[0] in wanted]

    if not boards:
        print("no kanban boards found", file=sys.stderr)
        return 2

    state = load_state()
    projects = index_projects(args.api, args.company_id, args.api_key)
    existing = index_existing_issues(args.api, args.company_id, args.api_key, state)

    if args.cleanup_dupes:
        n = cancel_duplicate_mirrors(
            args.api, args.company_id, args.api_key, existing, args.dry_run
        )
        if n:
            print(f"cleanup: cancelled {n} duplicate mirror issue(s)")
            # refresh after cleanup
            existing = index_existing_issues(
                args.api, args.company_id, args.api_key, state
            )

    results = []
    for slug, name, db in boards:
        print(f"\n=== board {slug} ({db}) ===")
        try:
            results.append(
                mirror_board(
                    args.api,
                    args.company_id,
                    args.api_key,
                    projects,
                    existing,
                    state,
                    slug,
                    name,
                    db,
                    args.dry_run,
                )
            )
        except Exception as e:
            print(f"error mirroring {slug}: {e}", file=sys.stderr)
            results.append({"board": slug, "error": str(e)})

    if not args.dry_run:
        save_state(state)

    summary = {
        "mirroredAt": utc_now(),
        "api": args.api,
        "companyId": args.company_id,
        "dryRun": args.dry_run,
        "statePath": str(STATE_PATH),
        "boards": results,
    }
    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        print("\n=== summary ===")
        print(json.dumps(summary, indent=2))
    return 0 if all("error" not in r for r in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
