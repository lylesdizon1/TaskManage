"""Thin, stateless client for Aria's voice endpoint.

POSTs { transcript } to {ARIA_API_BASE}/api/voice/message with the JWT bearer
token and returns Aria's text reply. All reasoning, tools, and memory live
server-side; this client holds no conversation state.
"""

from __future__ import annotations

import logging

import requests

from .config import Config

log = logging.getLogger("voice.aria")


class AriaClient:
    def __init__(self, config: Config, timeout: float = 60.0):
        self._url = config.voice_message_url
        self._jwt = config.aria_jwt
        self._timeout = timeout

    def send(self, transcript: str) -> str:
        """Send a transcript, return Aria's reply text. Returns a short spoken
        error string on failure rather than raising, so the loop keeps running."""
        try:
            resp = requests.post(
                self._url,
                json={"transcript": transcript},
                headers={
                    "Authorization": f"Bearer {self._jwt}",
                    "Content-Type": "application/json",
                },
                timeout=self._timeout,
            )
        except requests.RequestException as exc:
            log.warning("voice/message request failed: %s", exc)
            return "I couldn't reach the server just now."

        if resp.status_code == 401:
            log.error("voice/message returned 401 — ARIA_JWT is missing/expired.")
            return "My access token expired. Please refresh it."
        if resp.status_code != 200:
            log.warning("voice/message HTTP %s: %s", resp.status_code, resp.text[:200])
            return "Something went wrong on the server."

        try:
            data = resp.json()
        except ValueError:
            return "I got an unreadable response from the server."
        return (data.get("reply") or "").strip()
