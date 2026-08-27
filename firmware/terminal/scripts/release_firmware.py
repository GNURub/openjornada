#!/usr/bin/env python3

"""Create the exact, bounded manifest signed by the release workflow."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import datetime
from pathlib import Path


ASSET_NAME = "openjornada-m5stack.bin"
BOARD = "m5stack-basic-core-v27"
KEY_ID = "production-2026"
VERSION_PATTERN = re.compile(
    rb'#define OPENJORNADA_TERMINAL_VERSION_LITERAL "([0-9]+\.[0-9]+\.[0-9]+)"'
)


def firmware_version(version_header: Path) -> str:
    match = VERSION_PATTERN.search(version_header.read_bytes())
    if not match:
        raise ValueError("version.hpp no contiene una versión SemVer válida")
    return match.group(1).decode("ascii")


def normalized_timestamp(value: str) -> str:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("publishedAt debe incluir zona horaria")
    return parsed.isoformat(timespec="seconds").replace("+00:00", "Z")


def build_manifest(
    firmware: Path, version_header: Path, release_tag: str, published_at: str
) -> bytes:
    if not firmware.is_file() or firmware.stat().st_size <= 0:
        raise ValueError("el binario de firmware está vacío o no existe")
    if not release_tag or any(byte in release_tag for byte in "\r\n\x00"):
        raise ValueError("la etiqueta de release no es válida")
    payload = {
        "schemaVersion": 1,
        "channel": "stable",
        "board": BOARD,
        "firmwareVersion": firmware_version(version_header),
        "releaseTag": release_tag,
        "protocolVersion": 1,
        "assetName": ASSET_NAME,
        "size": firmware.stat().st_size,
        "sha256": hashlib.sha256(firmware.read_bytes()).hexdigest(),
        "keyId": KEY_ID,
        "publishedAt": normalized_timestamp(published_at),
    }
    encoded = json.dumps(payload, ensure_ascii=True, separators=(",", ":")).encode(
        "ascii"
    ) + b"\n"
    if len(encoded) > 2048:
        raise ValueError("el manifiesto supera 2048 bytes")
    return encoded


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--firmware", type=Path, required=True)
    parser.add_argument("--version-header", type=Path, required=True)
    parser.add_argument("--release-tag", required=True)
    parser.add_argument("--published-at", required=True)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    arguments.output.write_bytes(
        build_manifest(
            arguments.firmware,
            arguments.version_header,
            arguments.release_tag,
            arguments.published_at,
        )
    )


if __name__ == "__main__":
    main()
