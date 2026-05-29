"""Single entrypoint for the voice satellite.

Run either as `python -m voice_satellite` or via the repo-root `run.py` shim.
Loads + validates config, builds the orchestrator, and blocks until Ctrl-C.
"""

from __future__ import annotations

import logging
import os
import signal

from .config import ConfigError, load_config
from .orchestrator import Orchestrator


def _setup_logging() -> None:
    level = os.environ.get("VOICE_LOG_LEVEL", "INFO").upper()
    logging.basicConfig(
        level=getattr(logging, level, logging.INFO),
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )


def main() -> int:
    _setup_logging()
    log = logging.getLogger("voice")

    try:
        config = load_config()
    except ConfigError as exc:
        log.error("configuration error: %s", exc)
        return 2

    orch = Orchestrator(config)

    # Translate SIGTERM (launchd stop) into a clean shutdown.
    signal.signal(signal.SIGTERM, lambda *_: orch.stop())

    try:
        orch.run()
    except KeyboardInterrupt:
        log.info("interrupted — shutting down")
        orch.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
