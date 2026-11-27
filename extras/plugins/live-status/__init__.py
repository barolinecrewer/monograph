"""live-status — one short, plain sentence describing what the agent is doing right now.

Tool calls and failures are summarised by the title-generation model (Haiku) in a
background worker, coalesced so only the latest event per session is summarised.
State lands in $HERMES_HOME/cache/live-status.json; the desktop reads it through
the session-model-icons backend route (/status).
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_latest: dict[str, dict] = {}      # session -> newest pending event
_workers: set[str] = set()

_PROMPT = (
    "You write the one-line live status shown under a coding assistant while it works. "
    "Given the assistant's latest action, reply with ONE short present-progressive sentence "
    "(max 9 words, no period, no quotes, no file paths, no jargon), e.g. 'Reading the sidebar styles' "
    "or 'Restarting the plugin after an error'. If the action FAILED, say so plainly, e.g. "
    "'Hit an error loading the plugin, retrying'. Reply with the sentence only."
)


def _path() -> str:
    try:
        from hermes_constants import get_hermes_home
        home = str(get_hermes_home())
    except Exception:
        home = os.path.expanduser("~/.hermes")
    os.makedirs(os.path.join(home, "cache"), exist_ok=True)
    return os.path.join(home, "cache", "live-status.json")


def _write(session_id: str, text: str, kind: str = "work") -> None:
    p = _path()
    with _lock:
        try:
            data = json.load(open(p))
        except Exception:
            data = {}
        now = time.time()
        data = {k: v for k, v in data.items() if now - v.get("at", 0) < 3600}
        data[session_id] = {"text": text, "kind": kind, "at": now}
        tmp = p + ".tmp"
        with open(tmp, "w") as f:
            json.dump(data, f)
        os.replace(tmp, p)


def _summarise(ev: dict) -> str | None:
    from agent.auxiliary_client import call_llm
    # Only the tool's name and any error reach the model: tool arguments can
    # carry tokens and passwords, and a title does not need them.
    desc = f"Tool: {ev.get('tool')}"
    if ev.get("error"):
        desc += f"\nFAILED with: {str(ev['error'])[:300]}"
    resp = call_llm(
        task="title_generation",
        messages=[{"role": "system", "content": _PROMPT}, {"role": "user", "content": desc}],
        max_tokens=400, temperature=None, timeout=20, reasoning_config={"enabled": False},
    )
    msg = resp.choices[0].message
    text = (getattr(msg, "content", None) or "").strip().splitlines()
    text = text[0].strip(" .\"'`") if text else ""
    return text[:90] or None


def _worker(session_id: str) -> None:
    try:
        while True:
            with _lock:
                ev = _latest.pop(session_id, None)
                if ev is None:
                    _workers.discard(session_id)
                    return
            try:
                text = _summarise(ev)
                if text:
                    _write(session_id, text, "error" if ev.get("error") else "work")
            except Exception:
                logger.debug("live-status summarise failed", exc_info=True)
                if ev.get("error"):
                    _write(session_id, "Hit an error, working around it", "error")
    except Exception:
        with _lock:
            _workers.discard(session_id)


def _queue(session_id: str | None, ev: dict) -> None:
    if not session_id:
        return
    with _lock:
        _latest[session_id] = ev
        if session_id in _workers:
            return
        _workers.add(session_id)
    threading.Thread(target=_worker, args=(session_id,), daemon=True, name="live-status").start()


def _pre_llm(session_id=None, **_):
    if session_id:
        try:
            _write(session_id, "Thinking about your request")
        except Exception:
            pass
    return None


def _pre_tool(tool_name=None, args=None, session_id=None, **_):
    _queue(session_id, {"tool": tool_name, "args": args})
    return None


def _post_tool(tool_name=None, args=None, session_id=None, status=None, error_message=None, **_):
    if status == "error" or error_message:
        _queue(session_id, {"tool": tool_name, "args": args, "error": error_message or "failed"})
    return None


def _post_llm(session_id=None, **_):
    if session_id:
        with _lock:
            _latest.pop(session_id, None)
        try:
            _write(session_id, "", "done")
        except Exception:
            pass
    return None


def register(ctx) -> None:
    ctx.register_hook("pre_llm_call", _pre_llm)
    ctx.register_hook("pre_tool_call", _pre_tool)
    ctx.register_hook("post_tool_call", _post_tool)
    ctx.register_hook("post_llm_call", _post_llm)
