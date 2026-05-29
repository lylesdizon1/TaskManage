"""STT provider interface.

The realtime path streams PCM to the provider frame-by-frame and lets the
provider's own server-side VAD decide when the speaker has stopped. The
satellite no longer endpoints locally (Silero is retired) — it hands the
provider a live frame source and the provider returns one final transcript per
utterance.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Callable

# A frame source: called with a timeout (seconds) and returns one 16-bit mono
# PCM frame, or None if no audio arrived before the timeout (e.g. mic drained).
FrameReader = Callable[[float], "bytes | None"]


class STTProvider(ABC):
    """Streams a live utterance to a realtime STT and returns its transcript.

    Implementations open a streaming session, pump frames from `read_frame`
    until the provider signals end-of-speech (its built-in VAD) OR `max_seconds`
    elapses (a hard local cap so a stuck stream can't run forever), then return
    exactly one transcript. Empty string if nothing was recognized."""

    @abstractmethod
    def transcribe_live(
        self,
        read_frame: FrameReader,
        max_seconds: float,
        sample_rate: int,
    ) -> str:
        raise NotImplementedError
