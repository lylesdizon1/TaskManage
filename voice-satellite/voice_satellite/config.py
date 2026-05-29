"""Configuration loading + validation for the voice satellite.

All config comes from environment variables (loaded from a local .env that is
gitignored). Nothing here is machine-specific beyond what the env provides, so
the same code clones and runs on any Mac. See .env.example for every key.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:  # python-dotenv is in requirements; degrade gracefully
    pass

log = logging.getLogger("voice.config")

# Audio format is fixed end-to-end: 16 kHz, mono, signed 16-bit PCM. openWakeWord
# expects 16 kHz; ElevenLabs Scribe (STT) and Flash (TTS) both use 16 kHz. We resample
# ONCE at capture (the input device may run at 48 kHz) and every consumer reads
# this single canonical stream — never re-resample per consumer.
SAMPLE_RATE = 16000
CHANNELS = 1
SAMPLE_WIDTH = 2  # bytes (int16)
# openWakeWord consumes 80 ms frames (1280 samples) of int16 audio.
FRAME_SAMPLES = 1280


class ConfigError(RuntimeError):
    """Raised on missing/invalid required configuration. Fail fast, fail clear."""


def _get(name: str, default: str | None = None) -> str | None:
    val = os.environ.get(name)
    if val is None or val.strip() == "":
        return default
    return val.strip()


def _get_float(name: str, default: float) -> float:
    raw = _get(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        log.warning("Invalid float for %s=%r; using default %s", name, raw, default)
        return default


VALID_MODES = ("auto", "always_on", "hotkey_only")
VALID_HOTKEY_MODES = ("hold", "toggle")
# Low-latency TTS model for the live conversational path. Higher-fidelity models
# (eleven_multilingual_v2, eleven_turbo_v2_5, etc.) add first-audio latency.
FLASH_MODEL = "eleven_flash_v2_5"
# Realtime STT model — Scribe v2 Realtime (~150 ms latency).
SCRIBE_REALTIME_MODEL = "scribe_v2_realtime"


@dataclass
class Config:
    # ── Aria backend ──────────────────────────────────────────────────────
    aria_api_base: str
    aria_jwt: str

    # ── ElevenLabs — single vendor for BOTH STT (Scribe v2 Realtime) and
    #    TTS (Flash v2.5), sharing one API key. ──────────────────────────────
    tts_provider: str
    elevenlabs_api_key: str
    elevenlabs_voice_id: str
    elevenlabs_model: str       # TTS model
    elevenlabs_stt_model: str   # STT (Scribe realtime) model

    # ── Behaviour ─────────────────────────────────────────────────────────
    voice_mode: str
    hotkey: str
    hotkey_mode: str
    wakeword_model: str | None
    # Local file where the satellite persists the active conversation_id so
    # multi-turn continuity survives a restart (the server holds the actual
    # history; this is just the pointer into it).
    state_path: str
    max_utterance_seconds: float = 15.0

    @property
    def voice_message_url(self) -> str:
        return self.aria_api_base.rstrip("/") + "/api/voice/message"


def load_config() -> Config:
    """Load + validate config from the environment. Raises ConfigError on any
    missing required value so the satellite never starts half-configured."""

    missing: list[str] = []

    aria_api_base = _get("ARIA_API_BASE")
    if not aria_api_base:
        missing.append("ARIA_API_BASE")
    aria_jwt = _get("ARIA_JWT")
    if not aria_jwt:
        missing.append("ARIA_JWT")

    tts_provider = (_get("TTS_PROVIDER", "elevenlabs") or "elevenlabs").lower()
    if tts_provider != "elevenlabs":
        # The interface supports adding providers later, but ElevenLabs is the
        # only wired implementation today. Don't silently use a stranger.
        raise ConfigError(
            f"TTS_PROVIDER={tts_provider!r} is not wired. Only 'elevenlabs' is "
            f"supported. Remove TTS_PROVIDER or set it to 'elevenlabs'."
        )

    elevenlabs_api_key = _get("ELEVENLABS_API_KEY")
    if not elevenlabs_api_key:
        missing.append("ELEVENLABS_API_KEY")
    # Voice identity is required — a wrong/stock voice breaks the "sounds like
    # Aria" guarantee, so we fail fast rather than fall back.
    elevenlabs_voice_id = _get("ELEVENLABS_VOICE_ID")
    if not elevenlabs_voice_id:
        missing.append("ELEVENLABS_VOICE_ID")

    if missing:
        raise ConfigError(
            "Missing required config: "
            + ", ".join(missing)
            + ". Copy .env.example to .env and fill these in."
        )

    elevenlabs_model = _get("ELEVENLABS_MODEL", FLASH_MODEL) or FLASH_MODEL
    if elevenlabs_model != FLASH_MODEL:
        log.warning(
            "ELEVENLABS_MODEL=%s is not the low-latency flash model (%s); "
            "this adds latency to the live voice path.",
            elevenlabs_model, FLASH_MODEL,
        )

    voice_mode = (_get("VOICE_MODE", "auto") or "auto").lower()
    if voice_mode not in VALID_MODES:
        log.warning("VOICE_MODE=%s invalid; defaulting to 'auto'.", voice_mode)
        voice_mode = "auto"

    hotkey = _get("VOICE_HOTKEY", "<alt>+<space>") or "<alt>+<space>"

    hotkey_mode = (_get("VOICE_HOTKEY_MODE", "hold") or "hold").lower()
    if hotkey_mode not in VALID_HOTKEY_MODES:
        log.warning("VOICE_HOTKEY_MODE=%s invalid; defaulting to 'hold'.", hotkey_mode)
        hotkey_mode = "hold"

    wakeword_model = _get("VOICE_WAKEWORD_MODEL")  # None → bundled fallback

    max_utterance_seconds = _get_float("MAX_UTTERANCE_SECONDS", 15.0)
    if max_utterance_seconds <= 0 or max_utterance_seconds > 60:
        log.warning("MAX_UTTERANCE_SECONDS=%s out of range; using 15.", max_utterance_seconds)
        max_utterance_seconds = 15.0

    elevenlabs_stt_model = _get("ELEVENLABS_STT_MODEL", SCRIBE_REALTIME_MODEL) or SCRIBE_REALTIME_MODEL

    state_path = _get("VOICE_STATE_PATH") or os.path.join(
        os.path.expanduser("~"), ".aria-voice", "state.json"
    )

    return Config(
        aria_api_base=aria_api_base,
        aria_jwt=aria_jwt,
        tts_provider=tts_provider,
        elevenlabs_api_key=elevenlabs_api_key,
        elevenlabs_voice_id=elevenlabs_voice_id,
        elevenlabs_model=elevenlabs_model,
        elevenlabs_stt_model=elevenlabs_stt_model,
        voice_mode=voice_mode,
        hotkey=hotkey,
        hotkey_mode=hotkey_mode,
        wakeword_model=wakeword_model,
        state_path=state_path,
        max_utterance_seconds=max_utterance_seconds,
    )
