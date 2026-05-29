"""TTS provider interface."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Iterator


class TTSProvider(ABC):
    """Synthesizes speech. stream() yields 16 kHz mono int16 PCM chunks as they
    arrive so the caller can play them live (sub-100 ms first audio on a flash
    streaming model). The caller is responsible for ducking the mic during
    playback so output can't self-trigger the wake word."""

    @abstractmethod
    def stream(self, text: str) -> Iterator[bytes]:
        raise NotImplementedError
