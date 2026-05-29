"""Audio capture + playback.

ONE canonical capture stream produces 16 kHz / mono / int16 PCM. Every consumer
(wake-word detector, VAD, STT) reads that single stream — we never resample per
consumer. sounddevice opens the input device directly at 16 kHz (CoreAudio does
the device-rate conversion on macOS); if the device can't provide it we fail
with a clear error rather than silently feeding the wrong rate downstream.

PRIVACY BOUNDARY: the input callback in this module ONLY pushes frames into a
local in-process queue. It performs no network I/O. Audio leaves the machine
exclusively when the orchestrator hands a captured clip to the STT provider,
which only happens AFTER a wake-word/hotkey trigger. See orchestrator.py.
"""

from __future__ import annotations

import logging
import queue
import threading

import numpy as np
import sounddevice as sd

from .config import CHANNELS, FRAME_SAMPLES, SAMPLE_RATE

log = logging.getLogger("voice.audio")


class MicStream:
    """Always-on 16 kHz mono int16 capture. Frames are delivered to a bounded
    local queue; the callback never touches the network."""

    def __init__(self, frame_samples: int = FRAME_SAMPLES, max_queue_frames: int = 200):
        self._frame_samples = frame_samples
        self._q: "queue.Queue[bytes]" = queue.Queue(maxsize=max_queue_frames)
        self._stream: sd.RawInputStream | None = None
        self._dropped = 0

    def _callback(self, indata, frames, time_info, status):  # noqa: ANN001
        if status:
            log.debug("input stream status: %s", status)
        # indata is a CFFI buffer of int16 little-endian PCM (RawInputStream).
        # LOCAL-ONLY: push bytes to the in-process queue. No I/O beyond this.
        try:
            self._q.put_nowait(bytes(indata))
        except queue.Full:
            self._dropped += 1
            if self._dropped % 50 == 1:
                log.warning("audio queue full; dropping frames (count=%d)", self._dropped)

    def start(self) -> None:
        if self._stream is not None:
            return
        try:
            self._stream = sd.RawInputStream(
                samplerate=SAMPLE_RATE,
                channels=CHANNELS,
                dtype="int16",
                blocksize=self._frame_samples,
                callback=self._callback,
            )
            self._stream.start()
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(
                f"Could not open microphone at {SAMPLE_RATE} Hz mono. On macOS, "
                f"grant Microphone permission to your terminal/app in System "
                f"Settings → Privacy & Security → Microphone. Original error: {exc}"
            ) from exc
        log.info("microphone capture started (%d Hz mono int16)", SAMPLE_RATE)

    def read_frame(self, timeout: float = 1.0) -> bytes | None:
        """Block for the next int16 PCM frame. Returns None on timeout."""
        try:
            return self._q.get(timeout=timeout)
        except queue.Empty:
            return None

    def drain(self) -> None:
        """Discard any buffered frames (used after playback to avoid stale audio)."""
        try:
            while True:
                self._q.get_nowait()
        except queue.Empty:
            return

    def stop(self) -> None:
        if self._stream is not None:
            try:
                self._stream.stop()
                self._stream.close()
            finally:
                self._stream = None
        log.info("microphone capture stopped")


class AudioPlayer:
    """Plays 16 kHz mono int16 PCM via sounddevice. Used for TTS output. A lock
    serializes playback so overlapping replies can't interleave on the device."""

    def __init__(self):
        self._lock = threading.Lock()
        self._stop_flag = threading.Event()

    def play_stream(self, pcm_chunks) -> None:
        """Play an iterator/generator of int16 PCM byte chunks as they arrive.
        Blocks until the stream is exhausted or stop() is requested."""
        self._stop_flag.clear()
        with self._lock:
            stream = sd.RawOutputStream(
                samplerate=SAMPLE_RATE, channels=CHANNELS, dtype="int16"
            )
            stream.start()
            try:
                for chunk in pcm_chunks:
                    if self._stop_flag.is_set():
                        break
                    if chunk:
                        stream.write(chunk)
            finally:
                stream.stop()
                stream.close()

    def stop(self) -> None:
        self._stop_flag.set()


def pcm_bytes_to_float32(pcm: bytes) -> np.ndarray:
    """int16 PCM bytes → float32 numpy in [-1, 1], as VAD/openWakeWord expect."""
    audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
    return audio


def pcm_bytes_to_int16(pcm: bytes) -> np.ndarray:
    return np.frombuffer(pcm, dtype=np.int16)
