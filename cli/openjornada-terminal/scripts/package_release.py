#!/usr/bin/env python3
"""Build deterministic OpenJornada terminal CLI release archives."""

from __future__ import annotations

import argparse
import gzip
import os
from pathlib import Path
import stat
import tarfile
from typing import Final
import zipfile


SUPPORTED_TARGETS: Final = {
    ("linux", "amd64"),
    ("linux", "arm64"),
    ("darwin", "amd64"),
    ("darwin", "arm64"),
    ("windows", "amd64"),
    ("windows", "arm64"),
}


def _read_regular_file(path: Path, description: str) -> bytes:
    path = Path(path)
    try:
        metadata = path.lstat()
    except OSError as error:
        raise ValueError(f"{description} must be a readable regular file: {path}") from error
    if not stat.S_ISREG(metadata.st_mode):
        raise ValueError(f"{description} must be a regular file, not a symlink or directory: {path}")

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
        with os.fdopen(descriptor, "rb") as source:
            descriptor = -1
            return source.read()
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def _prepare_output_directory(output_dir: Path) -> Path:
    output_dir = Path(output_dir)
    try:
        output_dir.mkdir(parents=True, exist_ok=True)
        metadata = output_dir.lstat()
    except OSError as error:
        raise ValueError(f"invalid output directory: {output_dir}") from error
    if not stat.S_ISDIR(metadata.st_mode) or output_dir.is_symlink():
        raise ValueError(f"output directory must be a real directory: {output_dir}")
    return output_dir


def _archive_entries(
    binary: Path,
    target_os: str,
    license_file: Path,
    notice_file: Path,
    third_party_file: Path,
) -> list[tuple[str, bytes, int]]:
    required_names = (
        (Path(license_file), "LICENSE", "license"),
        (Path(notice_file), "NOTICE", "notice"),
        (Path(third_party_file), "THIRD_PARTY_NOTICES", "third-party notices"),
    )
    entries: list[tuple[str, bytes, int]] = []
    for path, expected_name, description in required_names:
        if path.name != expected_name:
            raise ValueError(f"{description} input must be named {expected_name}: {path}")
        entries.append((expected_name, _read_regular_file(path, description), 0o644))

    binary_name = "openjornada-terminal.exe" if target_os == "windows" else "openjornada-terminal"
    entries.append((binary_name, _read_regular_file(Path(binary), "binary"), 0o755))
    return sorted(entries, key=lambda entry: entry[0].encode("utf-8"))


def _write_tar_gz(path: Path, entries: list[tuple[str, bytes, int]]) -> None:
    with path.open("xb") as destination:
        with gzip.GzipFile(filename="", mode="wb", fileobj=destination, compresslevel=9, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
                for name, contents, mode in entries:
                    member = tarfile.TarInfo(name)
                    member.size = len(contents)
                    member.mode = mode
                    member.mtime = 0
                    member.uid = 0
                    member.gid = 0
                    member.uname = ""
                    member.gname = ""
                    archive.addfile(member, fileobj=_BytesReader(contents))


class _BytesReader:
    """Small file-like reader accepted by tarfile.addfile."""

    def __init__(self, contents: bytes):
        self._contents = contents
        self._position = 0

    def read(self, size: int = -1) -> bytes:
        if size < 0:
            size = len(self._contents) - self._position
        start = self._position
        self._position = min(len(self._contents), self._position + size)
        return self._contents[start : self._position]


def _write_zip(path: Path, entries: list[tuple[str, bytes, int]]) -> None:
    with path.open("xb") as destination:
        with zipfile.ZipFile(destination, mode="w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for name, contents, mode in entries:
                member = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                member.create_system = 3
                member.compress_type = zipfile.ZIP_DEFLATED
                member.external_attr = (stat.S_IFREG | mode) << 16
                member.extra = b""
                member.comment = b""
                archive.writestr(member, contents, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)


def package_archive(
    *,
    binary: Path,
    target_os: str,
    arch: str,
    license_file: Path,
    notice_file: Path,
    third_party_file: Path,
    output_dir: Path,
) -> Path:
    """Create one canonical archive and return its path."""
    if (target_os, arch) not in SUPPORTED_TARGETS:
        raise ValueError(f"unsupported target: {target_os}/{arch}")

    entries = _archive_entries(binary, target_os, license_file, notice_file, third_party_file)
    output_dir = _prepare_output_directory(output_dir)
    extension = ".zip" if target_os == "windows" else ".tar.gz"
    output = output_dir / f"openjornada-terminal_{target_os}_{arch}{extension}"
    try:
        if target_os == "windows":
            _write_zip(output, entries)
        else:
            _write_tar_gz(output, entries)
    except FileExistsError:
        raise FileExistsError(f"output already exists: {output}") from None
    except Exception:
        try:
            output.unlink()
        except FileNotFoundError:
            pass
        raise
    return output


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True, type=Path)
    parser.add_argument("--os", required=True, dest="target_os")
    parser.add_argument("--arch", required=True)
    parser.add_argument("--license", required=True, dest="license_file", type=Path)
    parser.add_argument("--notice", required=True, dest="notice_file", type=Path)
    parser.add_argument("--third-party", required=True, dest="third_party_file", type=Path)
    parser.add_argument("--output", required=True, dest="output_dir", type=Path)
    return parser


def main() -> int:
    arguments = _parser().parse_args()
    try:
        output = package_archive(**vars(arguments))
    except (OSError, ValueError) as error:
        raise SystemExit(f"package_release.py: error: {error}") from error
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
