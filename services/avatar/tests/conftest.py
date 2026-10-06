import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
# Tests never reach a real engine: no keys, and the chain tests pass their own env.
for k in ("AVATAR_ENGINES", "FAL_KEY", "TRIPO_API_KEY", "MESHY_API_KEY", "AI_CONFIG_FILE"):
    os.environ.pop(k, None)
