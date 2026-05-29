"""Wires the whole satellite together and owns the single capture thread.

Pipeline per utterance:
  wake word (local) OR hotkey  →  Scribe v2 Realtime STT (streams live mic
  frames; its server-side VAD ends the utterance)  →  POST to Aria  →  Aria's
  text reply  →  ElevenLabs Flash TTS  →  speaker.

PRIVACY: a single worker thread owns the microphone. In always_on mode it feeds
frames ONLY to the local wake-word detector; no frame leaves the machine until
detect() fires (or the hotkey is pressed). In hotkey_only mode the wake detector
never runs at all. The STT stream — the first thing that sends audio off-box —
is reached exclusively from inside _handle_utterance, i.e. post-trigger.

ANTI-SELF-TRIGGER: because one thread does both wake detection AND utterance
handling, the wake detector is paused for the entire duration of capture +
playback. After playback we drain the mic queue so TTS audio that leaked into
the input can't be mistaken for the wake word on the next loop.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading

from .aria_client import AriaClient
from .audio import AudioPlayer, MicStream, pcm_bytes_to_int16
from .config import SAMPLE_RATE, Config
from .hotkey import HotkeyListener
from .power import ALWAYS_ON, PowerMonitor
from .stt import make_stt
from .tts import make_tts
from .wakeword import WakeWordDetector

log = logging.getLogger("voice.orchestrator")

# Spoken phrases that start a fresh server-side conversation. Matched against
# the whole (normalized) utterance so a passing mention mid-sentence doesn't
# wipe context — the user has to actually say one of these as the command.
_RESET_PHRASES = (
    "new conversation",
    "start a new conversation",
    "start new conversation",
    "new chat",
    "start over",
    "let's start over",
    "forget that",
    "forget all that",
    "clear the conversation",
    "reset the conversation",
)


class Orchestrator:
    def __init__(self, config: Config):
        self._cfg = config
        self._mic = MicStream()
        self._player = AudioPlayer()
        self._wake = WakeWordDetector(config.wakeword_model)
        self._stt = make_stt(config)
        self._tts = make_tts(config)
        self._aria = AriaClient(config)

        self._power = PowerMonitor(config.voice_mode, self._on_mode_change)
        self._mode = self._power.current_mode
        self._hotkey = HotkeyListener(
            config.hotkey, config.hotkey_mode,
            on_activate=self._on_hotkey_activate,
            on_deactivate=self._on_hotkey_deactivate,
        )

        self._stop = threading.Event()
        self._hotkey_trigger = threading.Event()
        self._busy_lock = threading.Lock()
        self._busy = False

        # Conversation continuity: an opaque pointer the server uses to load
        # the windowed working-memory history. Persisted locally so a restart
        # rejoins the same thread (until the server's idle session reset).
        self._conversation_id = self._load_conversation_id()

    # ── conversation state ────────────────────────────────────────────────
    def _load_conversation_id(self) -> int | None:
        try:
            with open(self._cfg.state_path, "r", encoding="utf-8") as fh:
                cid = json.load(fh).get("conversation_id")
            return cid if isinstance(cid, int) else None
        except (OSError, ValueError):
            return None  # no prior state, unreadable, or corrupt — start fresh

    def _save_conversation_id(self) -> None:
        try:
            os.makedirs(os.path.dirname(self._cfg.state_path), exist_ok=True)
            with open(self._cfg.state_path, "w", encoding="utf-8") as fh:
                json.dump({"conversation_id": self._conversation_id}, fh)
        except OSError as exc:  # best-effort — a failed write just means the
            log.warning("could not persist conversation state: %s", exc)  # next start rejoins late

    @staticmethod
    def _is_reset_phrase(transcript: str) -> bool:
        normalized = re.sub(r"[^a-z' ]", "", transcript.lower()).strip()
        return normalized in _RESET_PHRASES

    # ── trigger sources ──────────────────────────────────────────────────
    def _on_hotkey_activate(self) -> None:
        # Works in ALL modes — the manual override. The worker picks this up.
        self._hotkey_trigger.set()

    def _on_hotkey_deactivate(self) -> None:
        # Releasing the key (hold) or toggling off cuts any in-flight reply
        # short — a simple barge-in. Capture end-of-speech is owned by Scribe.
        self._player.stop()

    def _on_mode_change(self, new_mode: str) -> None:
        log.info("effective mode → %s", new_mode)
        self._mode = new_mode

    # ── main loop ────────────────────────────────────────────────────────
    def run(self) -> None:
        self._mic.start()
        self._power.start()
        self._hotkey.start()
        log.info(
            "voice satellite running — mode=%s, wake=%s%s. Ctrl-C to quit.",
            self._mode,
            "fallback" if self._wake.using_fallback else "custom",
            " (hotkey always available)" if True else "",
        )
        try:
            while not self._stop.is_set():
                if self._hotkey_trigger.is_set():
                    self._hotkey_trigger.clear()
                    self._handle_utterance("hotkey")
                    continue

                if self._mode == ALWAYS_ON:
                    frame = self._mic.read_frame(timeout=0.1)
                    if frame is None:
                        continue
                    try:
                        if self._wake.detect(pcm_bytes_to_int16(frame)):
                            self._wake.reset()
                            self._handle_utterance("wake word")
                    except Exception as exc:  # noqa: BLE001
                        log.warning("wake-word detection error: %s", exc)
                else:
                    # hotkey_only: do NOT consume frames for detection. Keep the
                    # queue from growing stale while we idle waiting for a press.
                    self._mic.drain()
                    self._stop.wait(0.1)
        finally:
            self.stop()

    def _handle_utterance(self, source: str) -> None:
        with self._busy_lock:
            if self._busy:
                return
            self._busy = True
        try:
            self._mic.drain()  # start clean — drop any pre-trigger buffer
            log.info("listening (%s)…", source)
            transcript = self._stt.transcribe_live(
                self._mic.read_frame, self._cfg.max_utterance_seconds, SAMPLE_RATE
            ).strip()
            if not transcript:
                log.info("nothing recognized")
                return
            log.info("heard: %s", transcript)

            # Local control command: a reset phrase drops the conversation
            # pointer so the next turn starts a fresh server-side thread. We
            # don't send it to Aria — it's a satellite directive, not content.
            if self._is_reset_phrase(transcript):
                self._conversation_id = None
                self._save_conversation_id()
                reply = "Okay, starting a new conversation."
                log.info("conversation reset by voice command")
                self._player.play_stream(self._tts.stream(reply))
                return

            result = self._aria.send(transcript, self._conversation_id)
            if result.conversation_id != self._conversation_id:
                self._conversation_id = result.conversation_id
                self._save_conversation_id()
            reply = (result.reply or "").strip()
            if not reply:
                reply = "I didn't get a reply."
            log.info("aria: %s", reply)

            # Playback. The wake detector is paused (this thread is busy), so
            # the spoken reply can't self-trigger.
            self._player.play_stream(self._tts.stream(reply))
        except Exception as exc:  # noqa: BLE001
            log.warning("utterance handling failed: %s", exc)
        finally:
            self._mic.drain()   # discard TTS that bled into the mic
            self._wake.reset()
            with self._busy_lock:
                self._busy = False

    def stop(self) -> None:
        if self._stop.is_set():
            return
        self._stop.set()
        self._player.stop()
        try:
            self._hotkey.stop()
        finally:
            self._power.stop()
            self._mic.stop()
        log.info("voice satellite stopped")
