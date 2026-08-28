#!/usr/bin/env python3
"""Verify the complete terminal CLI GitHub Release asset contract."""

from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import re
import stat
from typing import Final, Iterable, Mapping


EXPECTED_ARCHIVE_NAMES: Final = frozenset(
    {
        "openjornada-terminal_linux_amd64.tar.gz",
        "openjornada-terminal_linux_arm64.tar.gz",
        "openjornada-terminal_darwin_amd64.tar.gz",
        "openjornada-terminal_darwin_arm64.tar.gz",
        "openjornada-terminal_windows_amd64.zip",
        "openjornada-terminal_windows_arm64.zip",
    }
)
EXPECTED_ASSET_NAMES: Final = EXPECTED_ARCHIVE_NAMES | {
    "checksums.txt",
    "install.sh",
    "install.ps1",
}
_CHECKSUM_LINE: Final = re.compile(r"([0-9a-f]{64})  ([^\r\n]+)")


def _format_names(names: Iterable[str]) -> str:
    return ", ".join(sorted(names, key=lambda name: name.encode("utf-8")))


def _verify_inventory(entries: Iterable[tuple[str, int]]) -> None:
    materialized = list(entries)
    names = [name for name, _ in materialized]
    duplicates = {name for name, count in Counter(names).items() if count > 1}
    if duplicates:
        raise ValueError(f"duplicate assets: {_format_names(duplicates)}")

    actual = set(names)
    missing = EXPECTED_ASSET_NAMES - actual
    if missing:
        raise ValueError(f"missing assets: {_format_names(missing)}")
    extra = actual - EXPECTED_ASSET_NAMES
    if extra:
        raise ValueError(f"unexpected assets: {_format_names(extra)}")

    empty = {name for name, size in materialized if size <= 0}
    if empty:
        raise ValueError(f"empty assets: {_format_names(empty)}")


def _read_regular_file(path: Path, description: str) -> bytes:
    path = Path(path)
    try:
        metadata = path.lstat()
    except OSError as error:
        raise ValueError(f"{description} must be a readable regular file: {path}") from error
    if not stat.S_ISREG(metadata.st_mode):
        raise ValueError(f"{description} must be a regular file: {path}")

    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0)
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise ValueError(f"{description} must be a readable regular file: {path}") from error
    try:
        opened_metadata = os.fstat(descriptor)
        if not stat.S_ISREG(opened_metadata.st_mode):
            raise ValueError(f"{description} must be a regular file: {path}")
        if (opened_metadata.st_dev, opened_metadata.st_ino) != (
            metadata.st_dev,
            metadata.st_ino,
        ):
            raise ValueError(f"{description} changed while it was opened: {path}")
        if opened_metadata.st_size <= 0:
            raise ValueError(f"{description} must not be empty: {path}")
        with os.fdopen(descriptor, "rb") as source:
            descriptor = -1
            contents = source.read()
        if not contents:
            raise ValueError(f"{description} must not be empty: {path}")
        return contents
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def _parse_checksums(path: Path) -> dict[str, str]:
    contents = _read_regular_file(path, "checksum inventory")
    try:
        text = contents.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ValueError("checksum inventory must be UTF-8") from error
    if not text.endswith("\n") or "\r" in text:
        raise ValueError("checksum inventory must use canonical LF-terminated lines")

    entries: dict[str, str] = {}
    duplicates: set[str] = set()
    for line_number, line in enumerate(text.splitlines(), start=1):
        match = _CHECKSUM_LINE.fullmatch(line)
        if match is None:
            raise ValueError(f"non-canonical checksum line {line_number}")
        digest, name = match.groups()
        if name in entries:
            duplicates.add(name)
        entries[name] = digest
    if duplicates:
        raise ValueError(f"duplicate checksum entries: {_format_names(duplicates)}")

    names = set(entries)
    missing = EXPECTED_ARCHIVE_NAMES - names
    if missing:
        raise ValueError(f"checksum entries missing: {_format_names(missing)}")
    extra = names - EXPECTED_ARCHIVE_NAMES
    if extra:
        raise ValueError(f"unexpected checksum entries: {_format_names(extra)}")
    return entries


def verify_local_assets(paths: Iterable[Path]) -> None:
    """Verify exact local files and match every archive to its SHA-256 line."""
    materialized = [Path(path) for path in paths]
    entries: list[tuple[str, int]] = []
    for path in materialized:
        contents = _read_regular_file(path, "release asset")
        entries.append((path.name, len(contents)))
    _verify_inventory(entries)

    by_name = {path.name: path for path in materialized}
    expected_digests = _parse_checksums(by_name["checksums.txt"])
    for name in sorted(EXPECTED_ARCHIVE_NAMES):
        actual = hashlib.sha256(_read_regular_file(by_name[name], "release archive")).hexdigest()
        if actual != expected_digests[name]:
            raise ValueError(f"checksum mismatch: {name}")


def verify_server_inventory(
    inventory: Iterable[Mapping[str, object]], checksums: Path
) -> None:
    """Verify GitHub's uploaded asset names/sizes and the checksum name set."""
    entries: list[tuple[str, int]] = []
    for index, item in enumerate(inventory):
        if not isinstance(item, Mapping):
            raise ValueError(f"server inventory item {index} must be an object")
        name = item.get("name")
        size = item.get("size")
        if not isinstance(name, str) or not name or "\n" in name or "\r" in name:
            raise ValueError(f"server inventory item {index} has an invalid name")
        if isinstance(size, bool) or not isinstance(size, int):
            raise ValueError(f"server inventory item {index} has an invalid size")
        entries.append((name, size))
    _verify_inventory(entries)
    _parse_checksums(checksums)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("assets", nargs="*", type=Path)
    parser.add_argument("--inventory-json", type=Path)
    parser.add_argument("--checksums", type=Path)
    return parser


def main() -> int:
    arguments = _parser().parse_args()
    try:
        if arguments.inventory_json is not None:
            if arguments.assets:
                raise ValueError("local asset paths cannot be combined with --inventory-json")
            if arguments.checksums is None:
                raise ValueError("--checksums is required with --inventory-json")
            raw_inventory = json.loads(
                _read_regular_file(arguments.inventory_json, "server inventory").decode("utf-8")
            )
            if not isinstance(raw_inventory, list):
                raise ValueError("server inventory JSON must be an array")
            verify_server_inventory(raw_inventory, arguments.checksums)
        else:
            if arguments.checksums is not None:
                raise ValueError("--checksums is only valid with --inventory-json")
            if not arguments.assets:
                raise ValueError("local asset paths or --inventory-json are required")
            verify_local_assets(arguments.assets)
    except (OSError, UnicodeDecodeError, ValueError, json.JSONDecodeError) as error:
        raise SystemExit(f"verify_release_assets.py: error: {error}") from error
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
