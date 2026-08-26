#!/usr/bin/env python3

"""Fail firmware builds when persistent storage overlaps upload metadata."""

from __future__ import annotations

import csv
from dataclasses import dataclass
from pathlib import Path


FLASH_SIZE = 16 * 1024 * 1024
PARTITION_TABLE_END = 0x9000
BOOT_METADATA_START = 0xE000
APP_START = 0x10000


@dataclass(frozen=True)
class Partition:
    name: str
    partition_type: str
    subtype: str
    offset: int
    size: int

    @property
    def end(self) -> int:
        return self.offset + self.size


def parse_number(value: str) -> int:
    normalized = value.strip().lower()
    multiplier = 1
    if normalized.endswith("k"):
        normalized = normalized[:-1]
        multiplier = 1024
    elif normalized.endswith("m"):
        normalized = normalized[:-1]
        multiplier = 1024 * 1024
    return int(normalized, 0) * multiplier


def load_partitions(path: Path) -> list[Partition]:
    partitions: list[Partition] = []
    with path.open(newline="", encoding="utf-8") as source:
        for row in csv.reader(source):
            if not row or row[0].strip().startswith("#"):
                continue
            if len(row) < 5 or not row[3].strip() or not row[4].strip():
                raise ValueError("todas las particiones deben declarar offset y tamaño")
            partitions.append(
                Partition(
                    name=row[0].strip(),
                    partition_type=row[1].strip(),
                    subtype=row[2].strip(),
                    offset=parse_number(row[3]),
                    size=parse_number(row[4]),
                )
            )
    return partitions


def validate_partitions(partitions: list[Partition]) -> list[str]:
    errors: list[str] = []
    ordered = sorted(partitions, key=lambda partition: partition.offset)
    for partition in ordered:
        if partition.offset < PARTITION_TABLE_END:
            errors.append(
                f"{partition.name} empieza en {partition.offset:#x}, dentro del área de arranque"
            )
        if partition.end > FLASH_SIZE:
            errors.append(
                f"{partition.name} termina en {partition.end:#x}, fuera de la flash de 16 MB"
            )
    for previous, current in zip(ordered, ordered[1:]):
        if previous.end > current.offset:
            errors.append(
                f"{previous.name} ({previous.offset:#x}-{previous.end:#x}) se solapa con "
                f"{current.name} ({current.offset:#x}-{current.end:#x})"
            )

    nvs = [partition for partition in partitions if partition.name == "nvs"]
    if len(nvs) != 1:
        errors.append("debe existir exactamente una partición nvs")
    elif nvs[0].end > BOOT_METADATA_START:
        errors.append(
            f"nvs termina en {nvs[0].end:#x} y boot_app0 se escribe desde "
            f"{BOOT_METADATA_START:#x}; un flasheo borraría la configuración"
        )

    boot_metadata = [
        partition
        for partition in partitions
        if partition.offset == BOOT_METADATA_START and partition.end == APP_START
    ]
    if not any(
        partition.partition_type == "data" and partition.subtype == "ota"
        for partition in boot_metadata
    ):
        errors.append(
            "el rango 0xe000-0x10000 debe reservarse como partición data/ota"
        )

    return errors


def main() -> None:
    try:
        Import("env")  # type: ignore[name-defined]  # PlatformIO/SCons global
        project_dir = Path(env.subst("$PROJECT_DIR"))  # type: ignore[name-defined]
    except NameError:
        project_dir = Path(__file__).resolve().parents[1]
    path = project_dir / "partitions.csv"
    errors = validate_partitions(load_partitions(path))
    if errors:
        details = "\n".join(f"  - {error}" for error in errors)
        raise SystemExit(f"Tabla de particiones no válida:\n{details}")


main()
