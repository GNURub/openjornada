#!/usr/bin/env python3

"""Validate the A/B layout and keep USB uploads away from persistent data."""

from __future__ import annotations

import csv
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


FLASH_SIZE = 16 * 1024 * 1024
APP_START = 0x10000
BOOT_APP_OFFSET = 0xE000
OTADATA_START = 0x3F0000
OTA_SLOT_SIZE = 0x1F0000
MAX_APP_SIZE = OTA_SLOT_SIZE * 85 // 100
EXPECTED_LAYOUT = {
    "nvs": ("data", "nvs", 0x9000, 0x6000),
    "phy_init": ("data", "phy", 0xF000, 0x1000),
    "ota_0": ("app", "ota_0", APP_START, OTA_SLOT_SIZE),
    "ota_1": ("app", "ota_1", 0x200000, OTA_SLOT_SIZE),
    "otadata": ("data", "ota", OTADATA_START, 0x2000),
    "littlefs": ("data", "spiffs", 0x410000, 0xBF0000),
}
EXPECTED_EXTRA_OFFSETS = {0x1000, 0x8000, OTADATA_START}
EXPECTED_EXTRA_IMAGES = [
    (0x1000, "bootloader.bin"),
    (0x8000, "partitions.bin"),
    (OTADATA_START, "boot_app0.bin"),
]


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
    if normalized.endswith(("kb", "k")):
        normalized = normalized[: -2 if normalized.endswith("kb") else -1]
        multiplier = 1024
    elif normalized.endswith(("mb", "m")):
        normalized = normalized[: -2 if normalized.endswith("mb") else -1]
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


def validate_layout(
    partitions: list[Partition],
    flash_size: int,
    app_offset: int,
    extra_offsets: Iterable[int],
) -> list[str]:
    errors: list[str] = []
    by_name = {partition.name: partition for partition in partitions}
    if len(by_name) != len(partitions):
        errors.append("los nombres de partición deben ser únicos")

    for name, expected in EXPECTED_LAYOUT.items():
        partition = by_name.get(name)
        actual = None
        if partition is not None:
            actual = (
                partition.partition_type,
                partition.subtype,
                partition.offset,
                partition.size,
            )
        if actual != expected:
            errors.append(
                f"{name} debe ser {expected[0]}/{expected[1]} en "
                f"{expected[2]:#x} con tamaño {expected[3]:#x}"
            )

    ordered = sorted(partitions, key=lambda partition: partition.offset)
    for partition in ordered:
        if partition.offset % 0x1000 != 0 or partition.size % 0x1000 != 0:
            errors.append(f"{partition.name} no está alineada a sectores de 4 KiB")
        if partition.end > flash_size:
            errors.append(
                f"{partition.name} termina en {partition.end:#x}, fuera de la flash"
            )
    for previous, current in zip(ordered, ordered[1:]):
        if previous.end > current.offset:
            errors.append(
                f"{previous.name} ({previous.offset:#x}-{previous.end:#x}) se solapa con "
                f"{current.name} ({current.offset:#x}-{current.end:#x})"
            )

    if flash_size != FLASH_SIZE:
        errors.append(f"la flash efectiva debe ser de 16 MB, no {flash_size:#x} bytes")
    if app_offset != APP_START:
        errors.append(f"la aplicación debe cargarse en {APP_START:#x}, no {app_offset:#x}")

    offsets = set(extra_offsets)
    if offsets != EXPECTED_EXTRA_OFFSETS:
        formatted = ", ".join(f"{offset:#x}" for offset in sorted(offsets))
        errors.append(
            "las imágenes auxiliares deben limitarse al bootloader, la tabla y "
            f"otadata en 0x1000, 0x8000 y 0x3f0000; se encontraron: "
            f"{formatted or 'ninguna'}"
        )
    for offset in offsets:
        for partition in partitions:
            if partition.offset <= offset < partition.end:
                if offset == OTADATA_START and partition.name == "otadata":
                    continue
                errors.append(
                    f"una imagen auxiliar en {offset:#x} sobrescribiría {partition.name}"
                )
    return errors


def validate_extra_images(images: Iterable[tuple[Any, Any]]) -> list[str]:
    actual = sorted(
        (parse_number(str(offset)), Path(str(path)).name) for offset, path in images
    )
    if actual == EXPECTED_EXTRA_IMAGES:
        return []
    formatted = ", ".join(f"{offset:#x}/{name}" for offset, name in actual)
    return [
        "las imágenes auxiliares efectivas deben ser exactamente "
        "0x1000/bootloader.bin, 0x8000/partitions.bin y "
        f"0x3f0000/boot_app0.bin; son: {formatted or 'ninguna'}"
    ]


def relocate_boot_app_image(
    images: Iterable[tuple[Any, Any]],
) -> tuple[list[tuple[Any, Any]], str]:
    kept: list[tuple[Any, Any]] = []
    removed_path = ""
    for offset, path in images:
        if (
            parse_number(str(offset)) == BOOT_APP_OFFSET
            and Path(str(path)).name == "boot_app0.bin"
        ):
            removed_path = str(path)
            continue
        kept.append((offset, path))
    if removed_path:
        kept.append((f"{OTADATA_START:#x}", removed_path))
    return kept, removed_path


def remove_upload_flag_pair(
    flags: Iterable[Any], offset: int, image_path: str
) -> tuple[list[Any], int]:
    values = list(flags)
    kept: list[Any] = []
    removed = 0
    index = 0
    while index < len(values):
        if (
            index + 1 < len(values)
            and str(values[index]).lower() == f"{offset:#x}"
            and str(values[index + 1]) == image_path
        ):
            removed += 1
            index += 2
            continue
        kept.append(values[index])
        index += 1
    return kept, removed


def configure_platformio(environment: Any) -> None:
    partition_path = Path(environment.subst("$PARTITIONS_TABLE_CSV")).resolve()
    images = list(environment.get("FLASH_EXTRA_IMAGES", []))
    kept_images, removed_path = relocate_boot_app_image(images)
    if not removed_path:
        raise SystemExit("No se encontró boot_app0.bin en 0xe000; no se puede asegurar NVS")

    resolved_removed_path = environment.subst(removed_path)
    upload_flags, removed_flag_pairs = remove_upload_flag_pair(
        environment.get("UPLOADERFLAGS", []),
        BOOT_APP_OFFSET,
        resolved_removed_path,
    )
    if removed_flag_pairs != 1:
        raise SystemExit(
            "No se retiró exactamente una imagen boot_app0.bin de la orden de carga"
        )
    if any(str(flag).lower() == f"{BOOT_APP_OFFSET:#x}" for flag in upload_flags):
        raise SystemExit("La orden de carga todavía contiene la dirección NVS 0xe000")
    upload_flags.extend([f"{OTADATA_START:#x}", resolved_removed_path])

    environment.Replace(FLASH_EXTRA_IMAGES=kept_images)
    environment.Replace(UPLOADERFLAGS=upload_flags)

    board = environment.BoardConfig()
    flash_size = parse_number(str(board.get("upload.flash_size", "")))
    app_offset = parse_number(str(environment.subst("$ESP32_APP_OFFSET")))
    extra_offsets = [parse_number(str(offset)) for offset, _ in kept_images]
    errors = validate_layout(
        load_partitions(partition_path), flash_size, app_offset, extra_offsets
    )
    errors.extend(validate_extra_images(kept_images))
    if errors:
        details = "\n".join(f"  - {error}" for error in errors)
        raise SystemExit(f"Carga USB o tabla de particiones no válida:\n{details}")

    def validate_program_size(source: Any, target: Any, env: Any) -> None:
        del source
        del env
        candidates = list(target)
        if not candidates:
            raise SystemExit("No se encontró el binario del firmware")
        binary = Path(str(candidates[0]))
        size = binary.stat().st_size
        if size > MAX_APP_SIZE:
            raise SystemExit(
                f"El firmware ocupa {size} bytes y supera el límite OTA del 85 % "
                f"({MAX_APP_SIZE} bytes)"
            )

    environment.AddPostAction("$BUILD_DIR/${PROGNAME}.bin", validate_program_size)


def validate_standalone() -> None:
    project_dir = Path(__file__).resolve().parents[1]
    errors = validate_layout(
        load_partitions(project_dir / "partitions.csv"),
        FLASH_SIZE,
        APP_START,
        EXPECTED_EXTRA_OFFSETS,
    )
    errors.extend(validate_extra_images(EXPECTED_EXTRA_IMAGES))
    if errors:
        details = "\n".join(f"  - {error}" for error in errors)
        raise SystemExit(f"Tabla de particiones no válida:\n{details}")


try:
    Import("env")  # type: ignore[name-defined]  # PlatformIO/SCons global
except NameError:
    if __name__ == "__main__":
        validate_standalone()
else:
    configure_platformio(env)  # type: ignore[name-defined]
