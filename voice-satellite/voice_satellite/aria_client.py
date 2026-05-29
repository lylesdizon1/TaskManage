"""Client for Aria's voice endpoint.

POSTs { transcript, conversation_id? } to {ARIA_API_BASE}/api/voice/message
with the JWT bearer token and returns Aria's text reply plus the conversation
id the server wants the satellite to use next.

All reasoning, tools, and long-term memory live server-side. The only state
the satellite holds is the conversation_id — an opaque pointer that lets the
server load the windowed working-memory history for multi-turn continuity. The
server may hand back a NEW id (e.g. after a 30-min idle session reset); the
caller should adopt whatever comes back.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import requests

from .config import Config

log = logging.getLogger("voice.aria")


@dataclass
class AriaReply:
    """Result of one voice turn. `conversation_id` is the id the satellite
    should send on the NEXT turn — on transport/error paths it falls back to
    whatever id was sent in, so a transient failure never drops the thread."""

    reply: str
    conversation_id: int | None = None


class AriaClient:
    def __init__(self, config: Config, timeout: float = 60.0):
        self._url = config.voice_message_url
        self._jwt = config.aria_jwt
        self._timeout = timeout

    def send(self, transcript: str, conversation_id: int | None = None) -> AriaReply:
        """Send a transcript (and the current conversation_id, if any). Returns
        an AriaReply. On failure, returns a short spoken error string and keeps
        the inbound conversation_id so the loop keeps running on the same thread."""
        payload: dict = {"transcript": transcript}
        if conversation_id is not None:
            payload["conversation_id"] = conversation_id
        try:
            resp = requests.post(
                self._url,
                json=payload,
                headers={
                    "Authorization": f"Bearer {self._jwt}",
                    "Content-Type": "application/json",
                },
                timeout=self._timeout,
            )
        except requests.RequestException as exc:
            log.warning("voice/message request failed: %s", exc)
            return AriaReply("I couldn't reach the server just now.", conversation_id)

        if resp.status_code == 401:
            log.error("voice/message returned 401 — ARIA_JWT is missing/expired.")
            return AriaReply("My access token expired. Please refresh it.", conversation_id)
        if resp.status_code != 200:
            log.warning("voice/message HTTP %s: %s", resp.status_code, resp.text[:200])
            return AriaReply("Something went wrong on the server.", conversation_id)

        try:
            data = resp.json()
        except ValueError:
            return AriaReply("I got an unreadable response from the server.", conversation_id)

        new_cid = data.get("conversation_id")
        if not isinstance(new_cid, int):
            new_cid = conversation_id  # server omitted it — keep the current thread
        return AriaReply((data.get("reply") or "").strip(), new_cid)
