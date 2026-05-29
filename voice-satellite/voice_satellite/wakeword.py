"""Local wake-word detection via openWakeWord.

This is the ONLY always-on component and the privacy gate for the whole system:
audio is fed here frame-by-frame and stays on-device. Nothing downstream
(STT/network) runs until detect() reports a trigger.

Model selection:
  - VOICE_WAKEWORD_MODEL set  → load that custom model (a real "hey_aria" model
    you trained with openWakeWord's training flow — see README).
  - unset                     → fall back to a bundled openWakeWord pretrained
    model and log a clear TODO. The fallback lets you run immediately, but the
    wake phrase will NOT be "Hey Aria" until you train + point at a real model.
"""

from __future__ import annotations

import logging
import os

import numpy as np

log = logging.getLogger("voice.wakeword")

# Bundled pretrained fallback. openWakeWord ships several; "hey_jarvis" is the
# closest stock two-syllable wake phrase. This is a stand-in ONLY.
_FALLBACK_PRETRAINED = "hey_jarvis_v0.1"


class WakeWordDetector:
    def __init__(self, model_path: str | None, threshold: float = 0.5):
        self._threshold = threshold
        self._using_fallback = model_path is None
        self._model = self._load(model_path)

    def _load(self, model_path: str | None):
        try:
            from openwakeword.model import Model
            import openwakeword.utils as oww_utils
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError(
                "openwakeword is not installed. Run: pip install -r requirements.txt"
            ) from exc

        if model_path:
            if not os.path.exists(model_path):
                raise RuntimeError(
                    f"VOICE_WAKEWORD_MODEL points at {model_path!r} which does not "
                    f"exist. Provide a valid openWakeWord model path, or unset the "
                    f"var to use the bundled fallback."
                )
            log.info("loading custom wake-word model: %s", model_path)
            return Model(wakeword_models=[model_path])

        # Fallback path — make sure pretrained weights are present, then load.
        log.warning(
            "VOICE_WAKEWORD_MODEL is unset. Falling back to bundled pretrained "
            "'%s'. TODO: train a real 'hey_aria' model (see README) and set "
            "VOICE_WAKEWORD_MODEL — the wake phrase is NOT 'Hey Aria' until then.",
            _FALLBACK_PRETRAINED,
        )
        try:
            oww_utils.download_models([_FALLBACK_PRETRAINED])
        except Exception as exc:  # noqa: BLE001
            log.warning("could not pre-download pretrained models: %s", exc)
        return Model(wakeword_models=[_FALLBACK_PRETRAINED])

    @property
    def using_fallback(self) -> bool:
        return self._using_fallback

    def reset(self) -> None:
        """Clear internal prediction buffers (call after a trigger so the next
        detection starts clean)."""
        try:
            self._model.reset()
        except Exception:  # noqa: BLE001
            pass

    def detect(self, int16_frame: np.ndarray) -> bool:
        """Feed one 16 kHz int16 frame. Returns True when any loaded wake-word
        model crosses the trigger threshold."""
        scores = self._model.predict(int16_frame)
        for name, score in scores.items():
            if score >= self._threshold:
                log.info("wake word triggered (%s=%.2f)", name, score)
                return True
        return False
