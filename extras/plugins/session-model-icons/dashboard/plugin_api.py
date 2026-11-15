"""GET /api/plugins/session-model-icons/previews?ids=a,b -> {id: {model, preview}}.

For each stored (lineage-root) id, follow compression children to the newest
session, then return its model and the head of its last assistant text reply.
"""
from __future__ import annotations

import json
import re
import sqlite3
from contextlib import closing

from fastapi import APIRouter, Query

router = APIRouter()


def _db_path():
    try:
        from hermes_state import _default_db_path
        return str(_default_db_path())
    except Exception:
        from hermes_constants import get_hermes_home
        return str(get_hermes_home() / "state.db")


def _text(content) -> str:
    if not content:
        return ""
    s = content
    if s.lstrip().startswith("["):
        try:
            parts = json.loads(s)
            s = " ".join(p.get("text", "") for p in parts if isinstance(p, dict))
        except Exception:
            pass
    s = re.sub(r"```.*?```", " ", s, flags=re.S)
    s = re.sub(r"[#*_`>|\[\]]", "", s)
    s = re.sub(r"\(https?://[^)]+\)", "", s)
    return " ".join(s.split())[:140]


def _candidate_dbs():
    """Current profile's db first, then the root and every profile db: the
    desktop routes plugin calls to the FOCUSED profile, which may not own the
    session rows the sidebar is showing."""
    import glob, os
    seen, out = set(), []
    cur = _db_path()
    root = cur
    if "/profiles/" in cur:
        root = cur.split("/profiles/")[0] + "/state.db"
    base = os.path.dirname(root)
    for p in [cur, root, *sorted(glob.glob(os.path.join(base, "profiles", "*", "state.db")))]:
        if p not in seen and os.path.exists(p):
            seen.add(p); out.append(p)
    return out


def _lookup(con, root):
    if not con.execute("SELECT 1 FROM sessions WHERE id = ?", (root,)).fetchone():
        return None
    sid, seen = root, set()
    while sid not in seen:
        seen.add(sid)
        row = con.execute(
            "SELECT id FROM sessions WHERE parent_session_id = ? ORDER BY started_at DESC LIMIT 1", (sid,)
        ).fetchone()
        if not row:
            break
        sid = row[0]
    m = con.execute("SELECT model FROM sessions WHERE id = ?", (sid,)).fetchone()
    model = (m[0] if m else "") or ""
    t = con.execute("SELECT title FROM sessions WHERE id IN (?, ?) AND title IS NOT NULL ORDER BY started_at DESC LIMIT 1", (sid, root)).fetchone()
    title = (t[0] if t else "") or ""
    if not model and sid != root:
        m = con.execute("SELECT model FROM sessions WHERE id = ?", (root,)).fetchone()
        model = (m[0] if m else "") or ""
    preview = ""
    for (content,) in con.execute(
        "SELECT content FROM messages WHERE session_id IN (?, ?) AND role = 'assistant' "
        "AND content IS NOT NULL AND content != '' ORDER BY id DESC LIMIT 5", (sid, root)
    ):
        preview = _text(content)
        if preview:
            break
    return {"model": model, "preview": preview, "title": title}


@router.get("/previews")
def previews(ids: str = Query("")):
    want = [i for i in ids.split(",") if i][:200]
    out = {}
    if not want:
        return out
    left = list(want)
    for path in _candidate_dbs():
        if not left:
            break
        try:
            con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=2)
        except Exception:
            continue
        with closing(con):
            for root in list(left):
                try:
                    r = _lookup(con, root)
                except Exception:
                    r = None
                if r is not None:
                    out[root] = r
                    left.remove(root)
    for root in left:
        out[root] = {"model": "", "preview": "", "title": ""}
    return out


@router.get("/status")
def status():
    """Merge live-status files from the root and every profile (calls are routed
    to the focused profile, which may not be the one doing the work)."""
    import glob, os
    try:
        from hermes_constants import get_hermes_home
        home = str(get_hermes_home())
    except Exception:
        home = os.path.expanduser("~/.hermes")
    root = home.split("/profiles/")[0] if "/profiles/" in home else home
    out = {}
    for f in [os.path.join(root, "cache", "live-status.json"), *glob.glob(os.path.join(root, "profiles", "*", "cache", "live-status.json"))]:
        try:
            with open(f) as fh:
                d = json.load(fh)
            for k, v in (d or {}).items():
                if k not in out or (v or {}).get("at", 0) > (out[k] or {}).get("at", 0):
                    out[k] = v
        except Exception:
            pass
    return out
