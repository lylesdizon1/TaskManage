"""ElevenLabs Scribe v2 Realtime STT over WebSocket.

We stream the captured utterance to Scribe frame-by-frame as raw 16 kHz mono
PCM and rely on Scribe's server-side VAD (commit_strategy="vad") to detect when
the speaker stops — that is the single source of end-of-speech, so there is no
local Silero VAD competing with it. When Scribe commits, it returns one
`committed_transcript`; we finalize on the first one and return exactly that
text, so an utterance is never posted to Aria twice.

A hard local `max_seconds` cap still applies: if Scribe never commits (a stuck
or silent stream), we force a commit and stop sending so the loop can't hang.

The Scribe websocket API is async; we bridge it to the satellite's synchronous
pipeline by running the asyncio client inside transcribe_live() via asyncio.run.
Frames are pulled from a synchronous `read_frame` callback off the event loop
thread so blocking reads don't stall the socket.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging

from .base import FrameReader, STTProvider

log = logging.getLogger("voice.stt.scribe")

_REALTIME_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime"
# Grace window (seconds) to wait for Scribe's final commit after we stop sending
# (either VAD end-of-speech or the hard cap firing).
_FINAL_GRACE_SECONDS = 5.0


class ElevenLabsScribeSTT(STTProvider):
    def __init__(self, api_key: str, model: str):
        if not api_key:
            raise ValueError("ELEVENLABS_API_KEY is required for Scribe STT.")
        self._api_key = api_key
        self._model = model

    def _url(self, sample_rate: int) -> str:
        return (
            f"{_REALTIME_URL}?model_id={self._model}"
            f"&audio_format=pcm_{sample_rate}"
            f"&sample_rate={sample_rate}"
            "&commit_strategy=vad"
        )

    def transcribe_live(
        self,
        read_frame: FrameReader,
        max_seconds: float,
        sample_rate: int,
    ) -> str:
        try:
            return asyncio.run(self._run(read_frame, max_seconds, sample_rate))
        except Exception as exc:  # noqa: BLE001
            log.warning("Scribe STT failed: %s", exc)
            return ""

    async def _connect(self, url: str):
        import websockets

        headers = {"xi-api-key": self._api_key}
        # websockets renamed the header kwarg (extra_headers → additional_headers
        # in v12). Try the modern name, fall back for older installs.
        try:
            return await websockets.connect(url, additional_headers=headers, max_size=None)
        except TypeError:
            return await websockets.connect(url, extra_headers=headers, max_size=None)

    async def _run(
        self,
        read_frame: FrameReader,
        max_seconds: float,
        sample_rate: int,
    ) -> str:
        try:
            import websockets  # noqa: F401
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError(
                "websockets is not installed. Run: pip install -r requirements.txt"
            ) from exc

        loop = asyncio.get_running_loop()
        result = {"text": ""}
        done = asyncio.Event()

        ws = await self._connect(self._url(sample_rate))
        try:
            async def sender() -> None:
                deadline = loop.time() + max_seconds
                while not done.is_set():
                    remaining = deadline - loop.time()
                    if remaining <= 0:
                        # Hard cap reached — force a final commit and stop.
                        await ws.send(json.dumps({
                            "message_type": "input_audio_chunk",
                            "audio_base_64": "",
                            "commit": True,
                        }))
                        return
                    frame = await asyncio.to_thread(read_frame, min(0.1, remaining))
                    if frame is None:
                        continue
                    await ws.send(json.dumps({
                        "message_type": "input_audio_chunk",
                        "audio_base_64": base64.b64encode(frame).decode("ascii"),
                        "commit": False,
                    }))

            async def receiver() -> None:
                async for message in ws:
                    try:
                        data = json.loads(message)
                    except (ValueError, TypeError):
                        continue
                    mtype = data.get("message_type")
                    if mtype == "committed_transcript":
                        # First commit is the end-of-utterance — finalize once.
                        result["text"] = (data.get("text") or "").strip()
                        done.set()
                        return
                    if mtype in ("error", "auth_error", "quota_exceeded"):
                        log.warning("Scribe error: %s", data.get("message") or data)
                        done.set()
                        return

            send_task = asyncio.create_task(sender())
            recv_task = asyncio.create_task(receiver())
            try:
                await asyncio.wait_for(done.wait(), timeout=max_seconds + _FINAL_GRACE_SECONDS)
            except asyncio.TimeoutError:
                log.warning("Scribe produced no commit within the deadline.")
            finally:
                send_task.cancel()
                recv_task.cancel()
        finally:
            await ws.close()

        return result["text"]
