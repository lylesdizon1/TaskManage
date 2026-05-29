"""Aria voice satellite — a portable, hands-free voice client for Aria.

A tiny LOCAL wake-word model is the only always-on piece. No audio leaves the
machine until the wake word fires. After a trigger, the captured utterance is
transcribed (ElevenLabs Scribe v2 Realtime), sent through Aria's existing
server-side router, and the reply is spoken back (ElevenLabs Flash v2.5) using
Aria's own voice. All memory/state lives server-side; this
client is a thin, stateless satellite that runs unchanged on any Mac.
"""

__version__ = "0.1.0"
