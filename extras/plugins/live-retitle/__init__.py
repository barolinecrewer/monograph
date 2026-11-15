"""live-retitle — keep session titles in step with what the session is actually about.

Hermes titles a session once, from the opening message. This plugin re-runs the
title model on the RECENT user turns at a few checkpoints (user turns 3, 6, 10,
15, then every 10) in a background thread, so it never slows a reply.

A title the user set by hand (``user`` provenance) is never touched; automatic
titles are rewritten and their provenance is put back to ``llm`` so later
checkpoints (and a manual /title) keep working.
"""

from __future__ import annotations

import logging
import threading

logger = logging.getLogger(__name__)

_CHECKPOINTS = {3, 6, 10, 15}
_inflight: set[str] = set()
_lock = threading.Lock()


def _is_checkpoint(n: int) -> bool:
    return n in _CHECKPOINTS or (n > 15 and n % 10 == 5)


def _user_texts(history) -> list[str]:
    out = []
    for m in history or []:
        if not isinstance(m, dict) or m.get("role") != "user":
            continue
        c = m.get("content")
        if isinstance(c, list):
            c = " ".join(p.get("text", "") for p in c if isinstance(p, dict) and p.get("type") == "text")
        if isinstance(c, str):
            # Drop attachment markers ("[Image attached at: …dashboard_….png]") — file names mislead the titler.
            c = "\n".join(l for l in c.splitlines() if not l.strip().startswith(("[Image attached", "[File attached", "MEDIA:")))
            if c.strip():
                out.append(c.strip())
    return out


def _retitle(session_id: str, recent: list[str]) -> None:
    try:
        from agent.title_generator import generate_title
        from hermes_state import SessionDB

        db = SessionDB()
        if db.get_session_title_source(session_id) == "user":
            return  # the user named it; leave it alone
        prompt = "What this session is about now (latest messages last):\n" + "\n".join(
            f"- {t[:300]}" for t in recent
        )
        title = generate_title(prompt)
        if not title or title == db.get_session_title(session_id):
            return
        try:
            db.set_session_title(session_id, title)
        except ValueError:
            return  # title taken by another session; try again at the next checkpoint
        db.set_session_title_source(session_id, "llm")
        logger.info("live-retitle: %s -> %r", session_id, title)
    except Exception:
        logger.debug("live-retitle failed", exc_info=True)
    finally:
        with _lock:
            _inflight.discard(session_id)


def _on_post_llm_call(session_id=None, conversation_history=None, **_):
    if not session_id:
        return None
    users = _user_texts(conversation_history)
    if not _is_checkpoint(len(users)):
        return None
    with _lock:
        if session_id in _inflight:
            return None
        _inflight.add(session_id)
    threading.Thread(target=_retitle, args=(session_id, users[-4:]), daemon=True, name="live-retitle").start()
    return None


def register(ctx) -> None:
    ctx.register_hook("post_llm_call", _on_post_llm_call)
