#!/usr/bin/env python3

"""Regression tests for the USB upload memory layout."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("validate_partitions.py")
sys.path.insert(0, str(MODULE_PATH.parent))
import validate_partitions as validator  # noqa: E402


def valid_partitions():
    return [
        validator.Partition("nvs", "data", "nvs", 0x9000, 0x6000),
        validator.Partition("phy_init", "data", "phy", 0xF000, 0x1000),
        validator.Partition("ota_0", "app", "ota_0", 0x10000, 0x1F0000),
        validator.Partition("ota_1", "app", "ota_1", 0x200000, 0x1F0000),
        validator.Partition("otadata", "data", "ota", 0x3F0000, 0x2000),
        validator.Partition("littlefs", "data", "spiffs", 0x410000, 0xBF0000),
    ]


class PartitionLayoutTest(unittest.TestCase):
    def test_platformio_flash_size_units_are_parsed(self):
        self.assertEqual(validator.parse_number("16MB"), validator.FLASH_SIZE)

    def test_published_layout_with_safe_upload_is_valid(self):
        self.assertEqual(
            validator.validate_layout(
                valid_partitions(),
                validator.FLASH_SIZE,
                validator.APP_START,
                {0x1000, 0x8000, 0x3F0000},
            ),
            [],
        )

    def test_boot_app_upload_over_nvs_is_rejected(self):
        errors = validator.validate_layout(
            valid_partitions(),
            validator.FLASH_SIZE,
            validator.APP_START,
            {0x1000, 0x8000, 0xE000, 0x3F0000},
        )
        self.assertTrue(any("sobrescribiría nvs" in error for error in errors))

    def test_wrong_nvs_type_size_or_offset_is_rejected(self):
        partitions = valid_partitions()
        partitions[0] = validator.Partition("nvs", "data", "ota", 0xA000, 0x5000)
        errors = validator.validate_layout(
            partitions, validator.FLASH_SIZE, validator.APP_START, {0x1000, 0x8000, 0x3F0000}
        )
        self.assertTrue(any(error.startswith("nvs debe ser") for error in errors))

    def test_non_ota_app_or_wrong_app_offset_is_rejected(self):
        partitions = valid_partitions()
        partitions[2] = validator.Partition(
            "ota_0", "app", "factory", 0x20000, 0x1F0000
        )
        errors = validator.validate_layout(
            partitions, validator.FLASH_SIZE, 0x20000, {0x1000, 0x8000, 0x3F0000}
        )
        self.assertTrue(any(error.startswith("ota_0 debe ser") for error in errors))
        self.assertTrue(any("aplicación debe cargarse" in error for error in errors))

    def test_wrong_flash_size_is_rejected(self):
        errors = validator.validate_layout(
            valid_partitions(),
            8 * 1024 * 1024,
            validator.APP_START,
            {0x1000, 0x8000, 0x3F0000},
        )
        self.assertTrue(any("flash efectiva debe ser de 16 MB" in error for error in errors))

    def test_only_exact_boot_app_image_is_removed(self):
        images = [
            ("0x1000", "bootloader.bin"),
            ("0x8000", "partitions.bin"),
            ("0xe000", "/framework/boot_app0.bin"),
        ]
        kept, removed = validator.relocate_boot_app_image(images)
        self.assertEqual(kept, images[:2] + [("0x3f0000", "/framework/boot_app0.bin")])
        self.assertEqual(removed, "/framework/boot_app0.bin")

    def test_extra_images_reject_duplicates_or_unexpected_names(self):
        self.assertTrue(
            validator.validate_extra_images(
                [("0x1000", "bootloader.bin"), ("0x1000", "bootloader.bin")]
            )
        )
        self.assertTrue(
            validator.validate_extra_images(
                [("0x1000", "large.bin"), ("0x8000", "partitions.bin")]
            )
        )

    def test_upload_flags_drop_only_matching_offset_and_path(self):
        flags = ["write_flash", "0x1000", "boot.bin", "0xe000", "boot_app0.bin"]
        self.assertEqual(
            validator.remove_upload_flag_pair(flags, 0xE000, "boot_app0.bin"),
            (["write_flash", "0x1000", "boot.bin"], 1),
        )

    def test_upload_flags_report_when_boot_app_pair_does_not_match(self):
        flags = ["write_flash", "0xe000", "different.bin"]
        self.assertEqual(
            validator.remove_upload_flag_pair(flags, 0xE000, "boot_app0.bin"),
            (flags, 0),
        )

    def test_platformio_integration_rewrites_the_effective_upload(self):
        project_dir = MODULE_PATH.parents[1]

        class FakeEnvironment:
            def __init__(self):
                self.values = {
                    "FLASH_EXTRA_IMAGES": [
                        ("0x1000", "bootloader.bin"),
                        ("0x8000", "partitions.bin"),
                        ("0xe000", "/framework/boot_app0.bin"),
                    ],
                    "UPLOADERFLAGS": [
                        "write_flash",
                        "0x1000",
                        "bootloader.bin",
                        "0x8000",
                        "partitions.bin",
                        "0xe000",
                        "/framework/boot_app0.bin",
                    ],
                }

            def subst(self, value):
                return {
                    "$PARTITIONS_TABLE_CSV": str(project_dir / "partitions.csv"),
                    "$ESP32_APP_OFFSET": "0x10000",
                }.get(value, value)

            def get(self, key, default=None):
                return self.values.get(key, default)

            def Replace(self, **values):
                self.values.update(values)

            def BoardConfig(self):
                return {"upload.flash_size": "16MB"}

            def AddPostAction(self, target, action):
                self.values["POST_ACTION"] = (target, action)

        environment = FakeEnvironment()
        validator.configure_platformio(environment)

        self.assertEqual(
            [
                validator.parse_number(str(offset))
                for offset, _ in environment.values["FLASH_EXTRA_IMAGES"]
            ],
            [0x1000, 0x8000, 0x3F0000],
        )
        self.assertNotIn("0xe000", environment.values["UPLOADERFLAGS"])
        self.assertIn("0x3f0000", environment.values["UPLOADERFLAGS"])
        self.assertIn("POST_ACTION", environment.values)

    def test_platformio_integration_fails_closed_when_flags_do_not_match(self):
        class MismatchedEnvironment:
            def __init__(self):
                self.values = {
                    "FLASH_EXTRA_IMAGES": [
                        ("0x1000", "bootloader.bin"),
                        ("0x8000", "partitions.bin"),
                        ("0xe000", "/framework/boot_app0.bin"),
                    ],
                    "UPLOADERFLAGS": ["write_flash", "0xe000", "different.bin"],
                }

            def subst(self, value):
                return value

            def get(self, key, default=None):
                return self.values.get(key, default)

        with self.assertRaisesRegex(SystemExit, "exactamente una imagen"):
            validator.configure_platformio(MismatchedEnvironment())


if __name__ == "__main__":
    unittest.main()
