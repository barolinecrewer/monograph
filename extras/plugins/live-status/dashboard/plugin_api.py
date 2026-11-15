"""GET /api/plugins/live-status/status -> contents of $HERMES_HOME/cache/live-status.json."""
from __future__ import annotations

import json
import os

from fastapi import APIRouter

router = APIRouter()


@router.get("/status")
def status():
    try:
        from hermes_constants import get_hermes_home
        home = str(get_hermes_home())
    except Exception:
        home = os.path.expanduser("~/.hermes")
    try:
        with open(os.path.join(home, "cache", "live-status.json")) as f:
            return json.load(f)
    except Exception:
        return {}
