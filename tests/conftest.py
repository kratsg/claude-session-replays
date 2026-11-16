"""Make the skill's scripts importable as plain modules."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "skills/session-replay/scripts"))
