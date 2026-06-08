"""`python -m tobii_okn_sidecar` entrypoint. Equivalent to running uvicorn
directly, but keeps the invocation tied to the package and gives us a single
place to thread in logging config / port overrides later.
"""

from __future__ import annotations

import os

import uvicorn


def main() -> None:
    host = os.environ.get("SIDECAR_HOST", "127.0.0.1")
    port = int(os.environ.get("SIDECAR_PORT", "8765"))
    reload = os.environ.get("SIDECAR_RELOAD", "").lower() in ("1", "true", "yes")
    uvicorn.run(
        "tobii_okn_sidecar.app:app",
        host=host,
        port=port,
        reload=reload,
        log_level="info",
    )


if __name__ == "__main__":
    main()
