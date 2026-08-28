#!/usr/bin/env python3
"""Write the deterministic SHA-256 inventory for release archives."""

from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
import stat
from typing import BinaryIO


def _open_regular_file(path: Path) -> BinaryIO:
    try:
        metadata = path.lstat()
    except OSError as error:
        raise ValueError(f"input must be a readable regular file: {path}") from error
    if not stat.S_ISREG(metadata.st_mode):
        raise ValueError(f"input must be a regular file, not a symlink or directory: {path}")

    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0)
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise ValueError(f"input must be a readable regular file: {path}") from error
    metadata = os.fstat(descriptor)
    if not stat.S_ISREG(metadata.st_mode):
        os.close(descriptor)
        raise ValueError(f"input must be a regular file: {path}")
    return os.fdopen(descriptor, "rb")


def _digest(path: Path) -> str:
    digest = hashlib.sha256()
    with _open_regular_file(path) as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def write_checksums(inputs: list[Path], output: Path) -> Path:
    """Hash inputs and create a sorted GNU-compatible checksum inventory."""
    paths = [Path(path) for path in inputs]
    output = Path(output)
    if not paths:
        raise ValueError("at least one input file is required")

    output_absolute = os.path.abspath(output)
    basenames: set[str] = set()
    for path in paths:
        if os.path.abspath(path) == output_absolute:
            raise ValueError("refusing to include the output itself")
        if path.name == "checksums.txt":
            raise ValueError("refusing to include checksums.txt")
        if "\n" in path.name or "\r" in path.name:
            raise ValueError(f"unsafe filename: {path.name!r}")
        if path.name in basenames:
            raise ValueError(f"duplicate basename: {path.name}")
        basenames.add(path.name)

    ordered = sorted(paths, key=lambda path: path.name.encode("utf-8"))
    lines = [f"{_digest(path)}  {path.name}\n".encode("utf-8") for path in ordered]

    parent = output.parent
    try:
        metadata = parent.lstat()
    except OSError as error:
        raise ValueError(f"invalid output directory: {parent}") from error
    if not stat.S_ISDIR(metadata.st_mode) or parent.is_symlink():
        raise ValueError(f"output directory must be a real directory: {parent}")

    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
    try:
        descriptor = os.open(output, flags, 0o644)
    except FileExistsError:
        raise FileExistsError(f"output already exists: {output}") from None
    try:
        with os.fdopen(descriptor, "wb") as destination:
            descriptor = -1
            destination.writelines(lines)
    except Exception:
        try:
            output.unlink()
        except FileNotFoundError:
            pass
        raise
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    return output


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inputs", nargs="+", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    return parser


def main() -> int:
    arguments = _parser().parse_args()
    try:
        output = write_checksums(arguments.inputs, arguments.output)
    except (OSError, ValueError) as error:
        raise SystemExit(f"checksums.py: error: {error}") from error
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
