"""Speech-to-text providers, behind a swappable interface.

ElevenLabs Scribe v2 Realtime is the wired default — the same vendor and API key
as TTS. To add another provider, implement STTProvider in a new module and
extend make_stt().
"""

from __future__ import annotations

from ..config import Config
from .base import STTProvider


def make_stt(config: Config) -> STTProvider:
    # Only ElevenLabs Scribe is wired today; the interface keeps the door open.
    from .elevenlabs_scribe import ElevenLabsScribeSTT
    return ElevenLabsScribeSTT(
        api_key=config.elevenlabs_api_key,
        model=config.elevenlabs_stt_model,
    )


__all__ = ["STTProvider", "make_stt"]
