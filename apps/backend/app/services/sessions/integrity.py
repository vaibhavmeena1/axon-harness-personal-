"""Bounded streaming checksum and gzip validation, independent of object storage."""

import hashlib
import zlib
from collections.abc import Iterator
from typing import Any, BinaryIO

from app.services.sessions.adapters import InvalidSessionError
from app.services.sessions.contracts import Snapshot

CHUNK = 64 * 1024


def _inflate(decoder: Any, chunk: bytes, remaining: int) -> Iterator[bytes]:
    while chunk:
        data = decoder.decompress(chunk, min(CHUNK, remaining + 1))
        remaining -= len(data)
        if remaining < 0:
            raise InvalidSessionError("Raw payload exceeds declared size")
        yield data
        if decoder.unused_data:
            raise InvalidSessionError("Trailing or concatenated gzip data")
        chunk = decoder.unconsumed_tail


def verify_chunks(chunks: Iterator[bytes], snapshot: Snapshot, raw: BinaryIO) -> None:
    """Limit decompressed output before allocating it; reject extra gzip members."""
    stored_hash, raw_hash = hashlib.sha256(), hashlib.sha256()
    stored_size = raw_size = 0
    decoder = zlib.decompressobj(16 + zlib.MAX_WBITS) if snapshot.encoding == "gzip" else None

    def write(data: bytes) -> None:
        nonlocal raw_size
        raw_size += len(data)
        if raw_size > snapshot.raw_size_bytes:
            raise InvalidSessionError("Raw payload exceeds declared size")
        raw_hash.update(data)
        raw.write(data)

    try:
        for chunk in chunks:
            stored_size += len(chunk)
            if stored_size > snapshot.stored_size_bytes:
                raise InvalidSessionError("Stored payload exceeds declared size")
            stored_hash.update(chunk)
            if decoder is None:
                write(chunk)
            else:
                for data in _inflate(decoder, chunk, snapshot.raw_size_bytes - raw_size):
                    write(data)
        if decoder is not None and not decoder.eof:
            raise InvalidSessionError("Incomplete gzip stream")
    except zlib.error:
        raise InvalidSessionError("Invalid gzip stream") from None
    if (
        stored_size != snapshot.stored_size_bytes
        or raw_size != snapshot.raw_size_bytes
        or stored_hash.hexdigest() != snapshot.stored_sha256
        or raw_hash.hexdigest() != snapshot.raw_sha256
    ):
        raise InvalidSessionError("Session integrity mismatch")
