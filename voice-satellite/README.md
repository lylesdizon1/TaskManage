# Aria Voice Satellite

A portable, clone-and-go macOS voice client for Aria. A tiny **local** wake-word
model listens for a wake phrase; only *after* it triggers does any audio leave
your machine. Captured speech is transcribed, sent through Aria's existing
backend, and Aria's reply is spoken back — using Aria's own voice.

```
mic (local) ─▶ wake word (local, on-device)
                     │  trigger
                     ▼
            ElevenLabs Scribe v2 Realtime  ── transcript ─▶  POST /api/voice/message
                  (STT, streaming)                                   │
                                                              Aria reply (text)
                                                                     │
            ElevenLabs Flash v2.5  ◀── reply text ───────────────────┘
                  (TTS, streaming)  ── audio ─▶  speaker
```

The satellite is a **thin, stateless client**. All reasoning, tools, and memory
live server-side; this app holds no conversation state and authenticates with a
JWT.

## Privacy boundary

Nothing is sent off-device until a trigger fires. The microphone callback only
pushes frames into a local in-process queue (`audio.py`). A single worker thread
feeds those frames to the **local** wake-word detector. The first component that
sends audio off the machine — the Scribe STT stream — is reached *only* from
inside `_handle_utterance` in `orchestrator.py`, i.e. after a wake-word or hotkey
trigger. In `hotkey_only` mode the wake detector never runs at all.

## Requirements

You need exactly **one** external account:

- **ElevenLabs** — one API key powers both speech-to-text (Scribe v2 Realtime)
  and text-to-speech (Flash v2.5). Get a key at
  <https://elevenlabs.io> → Profile → API Keys.

…plus a running **Aria** backend and a valid **Aria JWT**.

Python 3.10+ on macOS. (The code is OS-portable in spirit; the only mac-specific
artifact is the launchd template.)

## Install

```bash
cd voice-satellite
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
# edit .env — fill in ARIA_JWT, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID
```

The first run downloads a small pretrained wake-word model if you haven't pointed
`VOICE_WAKEWORD_MODEL` at a custom one.

## Run

```bash
python -m voice_satellite      # or: python run.py
```

Then either say the wake phrase (always_on) or press the hotkey
(`Option+Space` by default) and talk. Ctrl-C to quit.

## macOS permissions

Grant these to whatever runs the process (your terminal app, or the launchd job):

- **Microphone** — System Settings → Privacy & Security → Microphone.
- **Accessibility** — System Settings → Privacy & Security → Accessibility
  (required for the global hotkey via `pynput`).

Without them you'll see a clear mic error, or the hotkey silently won't fire.

## Modes

Set `VOICE_MODE` in `.env`:

| Mode          | Behaviour                                                                 |
|---------------|---------------------------------------------------------------------------|
| `auto` (default) | Picks from power: **desktop or on AC → always_on**; **on battery → hotkey_only**. Re-evaluated live when you plug/unplug. Fails safe to `hotkey_only` if power can't be read. |
| `always_on`   | Wake word always listening.                                               |
| `hotkey_only` | Wake word disabled; only the hotkey triggers capture.                     |

The **hotkey works in every mode** — it's the manual override for when the wake
word is off (e.g. on battery).

`VOICE_HOTKEY_MODE`:
- `hold` (default) — talk while holding the combo; releasing also barges in on a
  reply that's still playing.
- `toggle` — press to start, press again to stop.

End-of-speech is detected automatically by Scribe's server-side VAD; a hard
`MAX_UTTERANCE_SECONDS` cap (default 15s) is the safety net.

## The wake word ("Hey Aria")

openWakeWord needs a model trained for your phrase. Until you provide one, the
app falls back to a **bundled pretrained** model and logs a TODO — the wake
phrase will **not** be "Hey Aria" with the fallback.

To use a real "Hey Aria" wake word:
1. Train a model with openWakeWord's training flow
   (<https://github.com/dscripka/openWakeWord>).
2. Point `VOICE_WAKEWORD_MODEL` at the resulting `.onnx`/`.tflite` file
   (absolute path).

## Run at login (optional)

A launchd **template** is provided at `com.dizon.aria-voice.plist`. It is *not*
auto-installed. To use it:

```bash
# 1. Edit the plist: replace __PYTHON__ and __WORKING_DIR__ with absolute paths.
#    __PYTHON__      → $(pwd)/.venv/bin/python
#    __WORKING_DIR__ → $(pwd)

# 2. Install and load:
cp com.dizon.aria-voice.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.dizon.aria-voice.plist

# To stop / uninstall:
launchctl unload ~/Library/LaunchAgents/com.dizon.aria-voice.plist
rm ~/Library/LaunchAgents/com.dizon.aria-voice.plist
```

Logs land in `voice-satellite.log` / `voice-satellite.err.log` in the working
directory.

## Configuration reference

Every key lives in `.env` — see `.env.example` for the full annotated list.
Required: `ARIA_API_BASE`, `ARIA_JWT`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`.

## Layout

```
voice_satellite/
  run.py            entrypoint (also `python -m voice_satellite`)
  config.py         env loading + validation (fail-fast)
  audio.py          mic capture + playback (one canonical 16 kHz mono stream)
  wakeword.py       local openWakeWord detection (privacy gate)
  power.py          battery/AC detection + auto-mode resolution
  hotkey.py         global push-to-talk (pynput)
  orchestrator.py   single capture thread; wires the pipeline together
  aria_client.py    thin POST to /api/voice/message
  stt/              speech-to-text providers (ElevenLabs Scribe wired)
  tts/              text-to-speech providers (ElevenLabs Flash wired)
```

Both `stt/` and `tts/` keep a small provider interface so another vendor can be
added later without touching the orchestrator.
