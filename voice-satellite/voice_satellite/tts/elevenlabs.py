"""ElevenLabs streaming TTS over WebSocket.

Live conversational path: we open a stream-input websocket on the low-latency
flash model and yield PCM chunks as ElevenLabs returns them, so playback starts
within ~100 ms rather than after full synthesis. Output is requested as raw
16 kHz mono PCM (pcm_16000) so it plays directly through sounddevice with no
decode step.

Voice identity comes solely from voice_id (Aria's existing voice). The model is
configurable but defaults to eleven_flash_v2_5; config.py warns if a slower,
higher-fidelity model is selected.

The ElevenLabs websocket API is async; we bridge it to a synchronous generator
by running the asyncio client in a background thread that pushes decoded PCM
onto a queue the generator drains.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import queue
import threading
from typing import Iterator

log = logging.getLogger("voice.tts.elevenlabs")

_SENTINEL = None  # end-of-stream marker on the queue


class ElevenLabsTTS:
    def __init__(self, api_key: str, voice_id: str, model: str):
        if not voice_id:
            # Defensive: config.load_config() already enforces this. A wrong or
            # default voice breaks the "sounds like Aria" requirement.
            raise ValueError("ELEVENLABS_VOICE_ID is required — refusing to use a stock voice.")
        self._api_key = api_key
        self._voice_id = voice_id
        self._model = model

    def _url(self) -> str:
        return (
            f"wss://api.elevenlabs.io/v1/text-to-speech/{self._voice_id}/stream-input"
            f"?model_id={self._model}&output_format=pcm_16000"
        )

    def stream(self, text: str) -> Iterator[bytes]:
        text = (text or "").strip()
        if not text:
            return
        out: "queue.Queue[bytes | None]" = queue.Queue()

        thread = threading.Thread(
            target=self._run_async, args=(text, out), daemon=True
        )
        thread.start()

        while True:
            chunk = out.get()
            if chunk is _SENTINEL:
                break
            yield chunk
        thread.join(timeout=2.0)

    def _run_async(self, text: str, out: "queue.Queue[bytes | None]") -> None:
        try:
            asyncio.run(self._synthesize(text, out))
        except Exception as exc:  # noqa: BLE001
            log.warning("ElevenLabs TTS failed: %s", exc)
        finally:
            out.put(_SENTINEL)

    async def _synthesize(self, text: str, out: "queue.Queue[bytes | None]") -> None:
        try:
            import websockets
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError(
                "websockets is not installed. Run: pip install -r requirements.txt"
            ) from exc

        async with websockets.connect(self._url(), max_size=None) as ws:
            # BOS — voice settings + api key. A single space primes the stream.
            await ws.send(json.dumps({
                "text": " ",
                "voice_settings": {"stability": 0.5, "similarity_boost": 0.8},
                "xi_api_key": self._api_key,
            }))
            # The full reply, then flush, then EOS (empty text closes the input).
            await ws.send(json.dumps({"text": text, "flush": True}))
            await ws.send(json.dumps({"text": ""}))

            async for message in ws:
                try:
                    data = json.loads(message)
                except (ValueError, TypeError):
                    continue
                audio_b64 = data.get("audio")
                if audio_b64:
                    out.put(base64.b64decode(audio_b64))
                if data.get("isFinal"):
                    break
