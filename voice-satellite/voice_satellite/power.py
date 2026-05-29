"""Power-state detection and mode resolution.

`auto` mode picks behaviour from power:
  - no battery (desktop: Mac Studio/Mini)  → always_on
  - battery + on AC                         → always_on
  - battery + on battery                    → hotkey_only

FAIL-SAFE: if power state can't be read, or anything in the logic errors, we
resolve to hotkey_only — we never accidentally leave a mic always-listening.

psutil is cross-platform, so this file stays OS-portable; the only macOS-
specific artifact in the project is the launchd template (not code).
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Callable

log = logging.getLogger("voice.power")

ALWAYS_ON = "always_on"
HOTKEY_ONLY = "hotkey_only"
AUTO = "auto"


def _read_power_plugged() -> bool | None:
    """Return True (AC), False (battery), or None (no battery / desktop).
    Raises on read failure so callers can fail safe."""
    import psutil
    batt = psutil.sensors_battery()
    if batt is None:
        return None  # desktop — treat as AC/desktop, NOT an error
    return bool(batt.power_plugged)


def resolve_effective_mode(configured_mode: str) -> str:
    """Map a configured mode to the effective runtime mode."""
    if configured_mode == ALWAYS_ON:
        return ALWAYS_ON
    if configured_mode == HOTKEY_ONLY:
        return HOTKEY_ONLY

    # auto
    try:
        plugged = _read_power_plugged()
    except Exception as exc:  # noqa: BLE001
        log.warning("could not read power state (%s) — failing safe to hotkey_only", exc)
        return HOTKEY_ONLY

    if plugged is None:
        log.info("no battery detected (desktop) — always_on")
        return ALWAYS_ON
    if plugged:
        log.info("on AC power — always_on")
        return ALWAYS_ON
    log.info("on battery — hotkey_only")
    return HOTKEY_ONLY


class PowerMonitor:
    """Polls power state in `auto` mode and invokes on_change(new_mode) when the
    effective mode flips (e.g. unplugging a MacBook). No-op for fixed modes."""

    def __init__(self, configured_mode: str, on_change: Callable[[str], None],
                 poll_seconds: float = 5.0):
        self._configured = configured_mode
        self._on_change = on_change
        self._poll = poll_seconds
        self._current = resolve_effective_mode(configured_mode)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    @property
    def current_mode(self) -> str:
        return self._current

    def start(self) -> None:
        if self._configured != AUTO:
            return  # nothing to watch for fixed modes
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def _loop(self) -> None:
        while not self._stop.wait(self._poll):
            new_mode = resolve_effective_mode(self._configured)
            if new_mode != self._current:
                log.info("power-state change: %s → %s", self._current, new_mode)
                self._current = new_mode
                try:
                    self._on_change(new_mode)
                except Exception as exc:  # noqa: BLE001
                    log.warning("on_change handler errored: %s", exc)

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
