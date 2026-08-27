#!/usr/bin/env python3

from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from release_firmware import build_manifest  # noqa: E402


class ReleaseFirmwareTest(unittest.TestCase):
    def test_compiled_public_key_matches_published_pem(self):
        terminal = Path(__file__).resolve().parent.parent
        der = subprocess.run(
            [
                "openssl",
                "pkey",
                "-pubin",
                "-in",
                str(terminal / "keys" / "production-ed25519-public.pem"),
                "-outform",
                "DER",
            ],
            check=True,
            capture_output=True,
        ).stdout
        self.assertGreaterEqual(len(der), 32)
        header = (terminal / "include" / "openjornada" / "ota_configuration.hpp").read_text(
            encoding="utf-8"
        )
        declaration = re.search(
            r"kProductionOtaPublicKey\{(?P<body>.*?)\};", header, re.DOTALL
        )
        self.assertIsNotNone(declaration)
        compiled = bytes(
            int(value, 16)
            for value in re.findall(r"0x([0-9a-fA-F]{2})", declaration.group("body"))
        )
        self.assertEqual(der[-32:], compiled)

    def test_manifest_is_deterministic_and_matches_binary(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            firmware = root / "firmware.bin"
            firmware.write_bytes(b"signed firmware")
            version = root / "version.hpp"
            version.write_text(
                '#define OPENJORNADA_TERMINAL_VERSION_LITERAL "1.2.0"\n',
                encoding="utf-8",
            )
            first = build_manifest(
                firmware, version, "v0.8.0", "2026-08-27T12:00:00Z"
            )
            second = build_manifest(
                firmware, version, "v0.8.0", "2026-08-27T12:00:00+00:00"
            )
            self.assertEqual(first, second)
            self.assertTrue(first.endswith(b"\n"))
            payload = json.loads(first)
            self.assertEqual(payload["firmwareVersion"], "1.2.0")
            self.assertEqual(payload["assetName"], "openjornada-m5stack.bin")
            self.assertEqual(payload["sha256"], hashlib.sha256(b"signed firmware").hexdigest())

    def test_rejects_missing_binary_or_invalid_version(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            version = root / "version.hpp"
            version.write_text("invalid", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "binario"):
                build_manifest(
                    root / "missing.bin", version, "v0.8.0", "2026-08-27T12:00:00Z"
                )
            firmware = root / "firmware.bin"
            firmware.write_bytes(b"x")
            with self.assertRaisesRegex(ValueError, "SemVer"):
                build_manifest(
                    firmware, version, "v0.8.0", "2026-08-27T12:00:00Z"
                )


if __name__ == "__main__":
    unittest.main()
