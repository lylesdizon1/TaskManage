#!/usr/bin/env python3
"""Convenience shim so you can `python run.py` from the project root.

Equivalent to `python -m voice_satellite`.
"""

from voice_satellite.run import main

if __name__ == "__main__":
    raise SystemExit(main())
