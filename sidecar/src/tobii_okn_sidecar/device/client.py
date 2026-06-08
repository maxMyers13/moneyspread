"""Async g3api client. Mirrors the protocol the browser-side adapter speaks
(docs §3.1 and §3.6) so behavior is the same on both ends:

  - Connect via WebSocket at ws://<host>/websocket with sub-protocol "g3api"
  - Send request JSON: {"path": ..., "id": N, "method": "GET"|"POST", "body": ...}
  - Receive response JSON keyed by the same id: {"id": N, "body": ...}
  - Subscribe to signals by POSTing the signal path; device returns a numeric
    signal id; subsequent pushes arrive as {"signal": id, "body": [...]}

REST is used only when WebSocket isn't ergonomic — e.g., one-shot health
checks that don't need the persistent connection.

Single-tenant: one G3ApiClient per device per process. If you need to talk
to two units, instantiate two clients.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable
from typing import Any

import httpx
import websockets
from websockets.asyncio.client import ClientConnection

logger = logging.getLogger(__name__)

SignalHandler = Callable[[list[Any]], Awaitable[None] | None]
"""Callback invoked with the body list of each pushed signal frame.
May be sync or async — we await it either way."""


class G3ApiError(RuntimeError):
    """Raised when the device returns a logical error (X-g3-action-error header
    on REST, or non-OK body on a WS action response). Carries the raw response
    so callers can introspect."""

    def __init__(self, message: str, *, response: Any = None) -> None:
        super().__init__(message)
        self.response = response


class G3ApiClient:
    """Thin g3api client.

    Lifecycle:
        client = G3ApiClient("tg03b-080200012671.local")
        async with client:
            serial = await client.read_property("system.recording-unit-serial")
            uuid = await client.call_action("webrtc!create", [])

    All methods are coroutines. The class is not thread-safe; create one per
    asyncio task graph.
    """

    def __init__(self, host: str, *, ws_timeout_s: float = 8.0) -> None:
        # Normalize "host", "host:port", or "http://host" — we just want the
        # bare authority for building ws:// and http:// URLs.
        self.host = host.replace("http://", "").replace("ws://", "").rstrip("/")
        self.ws_timeout_s = ws_timeout_s

        self._ws: ClientConnection | None = None
        self._reader_task: asyncio.Task[None] | None = None
        self._next_req_id = 0
        self._pending: dict[int, asyncio.Future[Any]] = {}
        self._signal_handlers: dict[int, SignalHandler] = {}
        self._closing = False

    # -----------------------------------------------------------------------
    # Connection lifecycle
    # -----------------------------------------------------------------------

    @property
    def ws_url(self) -> str:
        return f"ws://{self.host}/websocket"

    @property
    def http_base(self) -> str:
        return f"http://{self.host}/rest"

    async def connect(self) -> None:
        if self._ws is not None:
            return
        logger.info("g3api: connecting %s", self.ws_url)
        self._closing = False
        self._ws = await websockets.connect(
            self.ws_url,
            subprotocols=["g3api"],
            open_timeout=self.ws_timeout_s,
            ping_interval=None,  # device has its own keep-alive semantics
        )
        if self._ws.subprotocol != "g3api":
            await self._ws.close()
            self._ws = None
            raise G3ApiError(
                f"server negotiated unexpected subprotocol: {self._ws.subprotocol!r}"
            )
        self._reader_task = asyncio.create_task(
            self._reader_loop(), name=f"g3api-reader-{self.host}"
        )
        logger.info("g3api: connected")

    async def disconnect(self) -> None:
        self._closing = True
        if self._reader_task is not None:
            self._reader_task.cancel()
            try:
                await self._reader_task
            except (asyncio.CancelledError, Exception):
                pass
            self._reader_task = None
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:
                pass
            self._ws = None
        # Fail any in-flight requests so callers don't hang forever.
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(G3ApiError("connection closed"))
        self._pending.clear()
        self._signal_handlers.clear()

    async def __aenter__(self) -> G3ApiClient:
        await self.connect()
        return self

    async def __aexit__(self, *_exc: Any) -> None:
        await self.disconnect()

    # -----------------------------------------------------------------------
    # API surface
    # -----------------------------------------------------------------------

    async def read_property(self, path: str) -> Any:
        """GET <path>. Per docs §3.4.1, returns the property value."""
        return await self._request(path, method="GET", body=None)

    async def write_property(self, path: str, value: Any) -> bool:
        """POST <path> with the new value. Returns the device's True/False."""
        return await self._request(path, method="POST", body=value)

    async def call_action(self, path: str, args: list[Any] | None = None) -> Any:
        """POST <path> with `args` as the JSON-array body (docs §3.5).
        `path` includes the `!` separator, e.g. `webrtc!create` or
        `webrtc/<uuid>!keep-alive`.
        """
        return await self._request(path, method="POST", body=args or [])

    async def subscribe_signal(
        self,
        path: str,
        handler: SignalHandler,
    ) -> tuple[int, Callable[[], Awaitable[None]]]:
        """Subscribe to `<obj>:<signal>` and route each push body to handler.

        Returns (signal_id, unsubscribe). The signal_id is the device's id
        for this subscription (the same one that appears in pushed frames).
        Calling unsubscribe() drops local routing — note we don't yet send
        an "unsubscribe" action to the device; the subscription dies with
        the WS connection.
        """
        signal_id_raw = await self._request(path, method="POST", body=None)
        if not isinstance(signal_id_raw, int):
            raise G3ApiError(
                f"signal subscription returned non-int: {signal_id_raw!r}",
                response=signal_id_raw,
            )
        signal_id = signal_id_raw
        self._signal_handlers[signal_id] = handler

        async def unsubscribe() -> None:
            self._signal_handlers.pop(signal_id, None)

        return signal_id, unsubscribe

    # REST-mode helpers — for one-shot calls that don't need the WS session.

    async def rest_read_property(self, path: str) -> Any:
        async with httpx.AsyncClient(timeout=4.0) as c:
            r = await c.get(f"{self.http_base}/{path}")
        return _decode_rest(r)

    async def rest_call_action(
        self, path: str, args: list[Any] | None = None
    ) -> Any:
        async with httpx.AsyncClient(timeout=4.0) as c:
            r = await c.post(f"{self.http_base}/{path}", json=args or [])
        return _decode_rest(r)

    # -----------------------------------------------------------------------
    # Internals
    # -----------------------------------------------------------------------

    async def _request(
        self,
        path: str,
        *,
        method: str,
        body: Any,
    ) -> Any:
        if self._ws is None:
            raise G3ApiError("not connected — call connect() first")
        self._next_req_id += 1
        req_id = self._next_req_id
        msg = {"path": path, "id": req_id, "method": method, "body": body}
        fut: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._pending[req_id] = fut
        try:
            await self._ws.send(json.dumps(msg))
            return await asyncio.wait_for(fut, timeout=self.ws_timeout_s)
        finally:
            self._pending.pop(req_id, None)

    async def _reader_loop(self) -> None:
        ws = self._ws
        if ws is None:
            return
        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    logger.warning("g3api: non-JSON frame ignored")
                    continue
                # Response to a request we sent.
                if isinstance(msg, dict) and isinstance(msg.get("id"), int):
                    fut = self._pending.get(msg["id"])
                    if fut is not None and not fut.done():
                        fut.set_result(msg.get("body"))
                    continue
                # Pushed signal frame.
                if isinstance(msg, dict) and isinstance(msg.get("signal"), int):
                    handler = self._signal_handlers.get(msg["signal"])
                    if handler is not None:
                        await _maybe_await(handler(msg.get("body") or []))
                    continue
                logger.debug("g3api: unknown frame: %s", str(msg)[:200])
        except asyncio.CancelledError:
            raise
        except Exception:
            if not self._closing:
                logger.exception("g3api: reader loop crashed")
            # Surface the failure to anyone awaiting a response.
            for fut in self._pending.values():
                if not fut.done():
                    fut.set_exception(G3ApiError("ws reader stopped"))


async def _maybe_await(value: Any) -> None:
    """Allow signal handlers to be either sync or async."""
    if asyncio.iscoroutine(value):
        await value


def _decode_rest(r: httpx.Response) -> Any:
    """Parse a REST response, honoring the X-g3-action-error header (docs §3.5)."""
    err = r.headers.get("X-g3-action-error")
    if err:
        raise G3ApiError(f"device action error: {err}", response=r.text)
    r.raise_for_status()
    text = r.text.strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # Some properties return bare strings without JSON quotes.
        return text
