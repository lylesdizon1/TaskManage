"""Text-to-speech providers, behind a swappable interface.

ElevenLabs is the default and only wired provider — Aria has an established
ElevenLabs voice across her other channels, and the satellite must sound like
the same Aria. The interface is intentionally preserved so another provider
can be added later without reworking the pipeline; add a module implementing
TTSProvider and extend make_tts().
"""

from __future__ import annotations

from ..config import Config
from .base import TTSProvider


def make_tts(config: Config) -> TTSProvider:
    if config.tts_provider == "elevenlabs":
        from .elevenlabs import ElevenLabsTTS
        return ElevenLabsTTS(
            api_key=config.elevenlabs_api_key,
            voice_id=config.elevenlabs_voice_id,
            model=config.elevenlabs_model,
        )
    # config.load_config() already rejects anything else, but guard anyway.
    raise ValueError(f"Unsupported TTS_PROVIDER: {config.tts_provider!r}")


__all__ = ["TTSProvider", "make_tts"]
