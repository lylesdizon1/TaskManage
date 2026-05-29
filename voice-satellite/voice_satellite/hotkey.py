"""Global push-to-talk hotkey via pynput.

Works in EVERY mode (always_on, hotkey_only, auto) — it's the manual override
that lets you talk to Aria even when the wake word is disabled (e.g. on battery).

Two behaviours:
  - hold   : capture starts when the combo goes down and ends when it's released.
  - toggle : each full press flips capture on, then off.

pynput's listener reports modifier variants separately (alt_l vs alt_r, etc.);
we normalise those to a single canonical modifier so "<alt>+<space>" matches
either Option key on macOS.

macOS note: global key monitoring requires Accessibility permission. Grant it to
your terminal/app under System Settings → Privacy & Security → Accessibility.
"""

from __future__ import annotations

import logging
from typing import Callable

from pynput import keyboard

log = logging.getLogger("voice.hotkey")

HOLD = "hold"
TOGGLE = "toggle"

# Collapse left/right/variant modifiers onto one canonical key so a hotkey like
# "<alt>+<space>" triggers regardless of which Option/Ctrl/Shift/Cmd was used.
_MOD_ALIASES = {
    keyboard.Key.alt_l: keyboard.Key.alt,
    keyboard.Key.alt_r: keyboard.Key.alt,
    keyboard.Key.alt_gr: keyboard.Key.alt,
    keyboard.Key.ctrl_l: keyboard.Key.ctrl,
    keyboard.Key.ctrl_r: keyboard.Key.ctrl,
    keyboard.Key.shift_l: keyboard.Key.shift,
    keyboard.Key.shift_r: keyboard.Key.shift,
    keyboard.Key.cmd_l: keyboard.Key.cmd,
    keyboard.Key.cmd_r: keyboard.Key.cmd,
}


class HotkeyListener:
    def __init__(
        self,
        hotkey: str,
        mode: str,
        on_activate: Callable[[], None],
        on_deactivate: Callable[[], None],
    ):
        # parse() raises ValueError on a malformed spec — let it surface at start.
        self._combo = set(keyboard.HotKey.parse(hotkey))
        self._mode = mode if mode in (HOLD, TOGGLE) else HOLD
        self._on_activate = on_activate
        self._on_deactivate = on_deactivate
        self._pressed: set = set()
        self._active = False        # combo currently fully held
        self._toggled_on = False    # toggle-mode latch
        self._listener: keyboard.Listener | None = None

    def _norm(self, key):  # noqa: ANN001
        canon = self._listener.canonical(key) if self._listener else key
        return _MOD_ALIASES.get(canon, canon)

    def _on_press(self, key) -> None:  # noqa: ANN001
        k = self._norm(key)
        if k not in self._combo:
            return
        self._pressed.add(k)
        if self._combo.issubset(self._pressed) and not self._active:
            self._active = True
            self._fire_edge_down()

    def _on_release(self, key) -> None:  # noqa: ANN001
        k = self._norm(key)
        if k not in self._combo:
            return
        self._pressed.discard(k)
        if self._active and not self._combo.issubset(self._pressed):
            self._active = False
            self._fire_edge_up()

    def _fire_edge_down(self) -> None:
        if self._mode == TOGGLE:
            self._toggled_on = not self._toggled_on
            (self._on_activate if self._toggled_on else self._on_deactivate)()
        else:  # hold
            self._on_activate()

    def _fire_edge_up(self) -> None:
        if self._mode == HOLD:
            self._on_deactivate()
        # toggle ignores release

    def start(self) -> None:
        self._listener = keyboard.Listener(
            on_press=self._safe(self._on_press),
            on_release=self._safe(self._on_release),
        )
        self._listener.start()
        log.info("hotkey listening (%s, mode=%s)", "+".join(sorted(map(str, self._combo))), self._mode)

    @staticmethod
    def _safe(fn):
        def wrapped(key):  # noqa: ANN001
            try:
                fn(key)
            except Exception as exc:  # noqa: BLE001 — never let a callback kill the listener
                log.warning("hotkey handler error: %s", exc)
        return wrapped

    def stop(self) -> None:
        if self._listener is not None:
            self._listener.stop()
            self._listener = None
