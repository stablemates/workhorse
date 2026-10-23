"""A TCP proxy that delays every write from a client to PostgreSQL.

Each chunk that a client writes reaches PostgreSQL a fixed time later, in the order of the writes.
So PostgreSQL sees an idle gap of that time before each statement, as on a slow network. The proxy
works the same for every driver. Writes from PostgreSQL to the client are not delayed.
"""

from __future__ import annotations

import socket
from collections.abc import Iterator
from contextlib import contextmanager, suppress
from queue import SimpleQueue
from threading import Event, Thread
from time import monotonic, sleep
from urllib.parse import urlsplit, urlunsplit

_CHUNK_BYTES = 65_536


class DelayedProxy:
    """Forward connections on a loopback port to `target`, and delay each client write."""

    def __init__(self, target: tuple[str, int], delay_seconds: float) -> None:
        self._target = target
        self._delay = delay_seconds
        self._listener = socket.create_server(("127.0.0.1", 0))
        self._stopped = Event()
        self._sockets: list[socket.socket] = []
        self.port = int(self._listener.getsockname()[1])
        Thread(target=self._accept, name="delayed-proxy-accept", daemon=True).start()

    def close(self) -> None:
        self._stopped.set()
        with suppress(OSError):
            self._listener.close()
        for opened in list(self._sockets):
            with suppress(OSError):
                opened.close()

    def _accept(self) -> None:
        while not self._stopped.is_set():
            try:
                client, _address = self._listener.accept()
            except OSError:
                return
            try:
                server = socket.create_connection(self._target)
            except OSError:
                client.close()
                continue
            for opened in (client, server):
                opened.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                self._sockets.append(opened)
            delayed: SimpleQueue[tuple[float, bytes]] = SimpleQueue()
            Thread(target=self._read_client, args=(client, delayed), daemon=True).start()
            Thread(target=self._write_server, args=(client, server, delayed), daemon=True).start()
            Thread(target=self._pump, args=(server, client), daemon=True).start()

    def _read_client(
        self, client: socket.socket, delayed: SimpleQueue[tuple[float, bytes]]
    ) -> None:
        try:
            while chunk := client.recv(_CHUNK_BYTES):
                delayed.put((monotonic() + self._delay, chunk))
        except OSError:
            pass
        # An empty chunk ends the connection after the writes before it.
        delayed.put((monotonic() + self._delay, b""))

    def _write_server(
        self,
        client: socket.socket,
        server: socket.socket,
        delayed: SimpleQueue[tuple[float, bytes]],
    ) -> None:
        try:
            while True:
                due, chunk = delayed.get()
                wait = due - monotonic()
                if wait > 0:
                    sleep(wait)
                if not chunk:
                    break
                server.sendall(chunk)
        except OSError:
            pass
        finally:
            _close(server, client)

    @staticmethod
    def _pump(source: socket.socket, destination: socket.socket) -> None:
        try:
            while chunk := source.recv(_CHUNK_BYTES):
                destination.sendall(chunk)
        except OSError:
            pass
        finally:
            _close(source, destination)


def _close(*sockets: socket.socket) -> None:
    for opened in sockets:
        with suppress(OSError):
            opened.shutdown(socket.SHUT_RDWR)
        with suppress(OSError):
            opened.close()


@contextmanager
def delayed_database_url(database_url: str, delay_seconds: float) -> Iterator[str]:
    """Give a URL for `database_url` through a proxy that delays each client write."""
    parsed = urlsplit(database_url)
    proxy = DelayedProxy((parsed.hostname or "127.0.0.1", parsed.port or 5432), delay_seconds)
    credentials = parsed.netloc.rpartition("@")[0]
    netloc = f"{credentials}@127.0.0.1:{proxy.port}" if credentials else f"127.0.0.1:{proxy.port}"
    try:
        yield urlunsplit(parsed._replace(netloc=netloc))
    finally:
        proxy.close()
