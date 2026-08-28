import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from scripts import verify_release_assets


class VerifyReleaseAssetsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.assets = []
        for name in sorted(verify_release_assets.EXPECTED_ASSET_NAMES):
            path = self.root / name
            path.write_bytes(f"contents for {name}".encode("utf-8"))
            self.assets.append(path)
        self.checksums = self.root / "checksums.txt"
        self.write_valid_checksums()

    def write_valid_checksums(self):
        self.checksums.write_text(
            "".join(
                f"{hashlib.sha256((self.root / name).read_bytes()).hexdigest()}  {name}\n"
                for name in sorted(verify_release_assets.EXPECTED_ARCHIVE_NAMES)
            ),
            encoding="utf-8",
        )

    def tearDown(self):
        self.temporary.cleanup()

    def test_accepts_exact_local_inventory_and_checksum_digests(self):
        verify_release_assets.verify_local_assets(self.assets)

    def test_rejects_missing_and_extra_assets(self):
        with self.assertRaisesRegex(ValueError, "missing assets: install.sh"):
            verify_release_assets.verify_local_assets(
                [path for path in self.assets if path.name != "install.sh"]
            )

        extra = self.root / "unexpected.txt"
        extra.write_bytes(b"unexpected")
        with self.assertRaisesRegex(ValueError, "unexpected assets: unexpected.txt"):
            verify_release_assets.verify_local_assets([*self.assets, extra])

    def test_rejects_zero_byte_asset(self):
        (self.root / "install.ps1").write_bytes(b"")
        with self.assertRaisesRegex(ValueError, "must not be empty"):
            verify_release_assets.verify_local_assets(self.assets)

    def test_rejects_duplicate_asset_name(self):
        with self.assertRaisesRegex(ValueError, "duplicate assets: install.sh"):
            verify_release_assets.verify_local_assets(
                [*self.assets, self.root / "install.sh"]
            )

    def test_rejects_symlinked_assets_and_checksum_inventory(self):
        installer = self.root / "install.sh"
        installer.unlink()
        installer.symlink_to(self.root / "install.ps1")
        with self.assertRaisesRegex(ValueError, "regular file"):
            verify_release_assets.verify_local_assets(self.assets)

        installer.unlink()
        installer.write_bytes(b"installer")
        real_checksums = self.root / "real-checksums.txt"
        self.checksums.replace(real_checksums)
        self.checksums.symlink_to(real_checksums)
        with self.assertRaisesRegex(ValueError, "regular file"):
            verify_release_assets.verify_local_assets(self.assets)

    def test_rejects_file_swapped_for_symlink_between_stat_and_open(self):
        installer = self.root / "install.sh"
        replacement = self.root / "install.ps1"
        original_open = verify_release_assets.os.open
        swapped = False

        def swap_before_open(path, flags):
            nonlocal swapped
            if Path(path) == installer and not swapped:
                installer.unlink()
                installer.symlink_to(replacement)
                swapped = True
            return original_open(path, flags)

        with (
            mock.patch.object(verify_release_assets.os, "O_NOFOLLOW", 0),
            mock.patch.object(
                verify_release_assets.os, "open", side_effect=swap_before_open
            ),
        ):
            with self.assertRaisesRegex(ValueError, "changed while"):
                verify_release_assets.verify_local_assets(self.assets)

    def test_checksum_inventory_must_name_exactly_the_six_archives(self):
        lines = self.checksums.read_text(encoding="utf-8").splitlines()
        self.checksums.write_text("\n".join(lines[:-1]) + "\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "checksum entries missing"):
            verify_release_assets.verify_local_assets(self.assets)

        self.write_valid_checksums()
        self.checksums.write_text(
            self.checksums.read_text(encoding="utf-8") + "0" * 64 + "  extra.zip\n",
            encoding="utf-8",
        )
        with self.assertRaisesRegex(ValueError, "unexpected checksum entries: extra.zip"):
            verify_release_assets.verify_local_assets(self.assets)

    def test_rejects_duplicate_noncanonical_and_incorrect_checksums(self):
        first_line = self.checksums.read_text(encoding="utf-8").splitlines()[0]
        self.checksums.write_text(
            self.checksums.read_text(encoding="utf-8") + first_line + "\n",
            encoding="utf-8",
        )
        with self.assertRaisesRegex(ValueError, "duplicate checksum entries"):
            verify_release_assets.verify_local_assets(self.assets)

        self.write_valid_checksums()
        contents = self.checksums.read_text(encoding="utf-8")
        self.checksums.write_text(contents.replace("  ", " ", 1), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "non-canonical checksum line"):
            verify_release_assets.verify_local_assets(self.assets)

        self.write_valid_checksums()
        contents = self.checksums.read_text(encoding="utf-8")
        self.checksums.write_text("0" * 64 + contents[64:], encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            verify_release_assets.verify_local_assets(self.assets)

    def test_accepts_server_inventory_and_rejects_duplicate_or_zero_size(self):
        inventory = [
            {"name": path.name, "size": path.stat().st_size} for path in self.assets
        ]
        verify_release_assets.verify_server_inventory(inventory, self.checksums)

        duplicate = [*inventory, inventory[0]]
        with self.assertRaisesRegex(ValueError, "duplicate assets"):
            verify_release_assets.verify_server_inventory(duplicate, self.checksums)

        inventory[0]["size"] = 0
        with self.assertRaisesRegex(ValueError, "empty assets"):
            verify_release_assets.verify_server_inventory(inventory, self.checksums)

    def test_cli_accepts_local_paths_and_server_json(self):
        script = Path(verify_release_assets.__file__)
        local = subprocess.run(
            [sys.executable, str(script), *map(str, self.assets)],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(local.returncode, 0, local.stderr)

        inventory_path = self.root / "server-assets.json"
        inventory_path.write_text(
            json.dumps(
                [
                    {"name": path.name, "size": path.stat().st_size}
                    for path in self.assets
                ]
            ),
            encoding="utf-8",
        )
        server = subprocess.run(
            [
                sys.executable,
                str(script),
                "--inventory-json",
                str(inventory_path),
                "--checksums",
                str(self.checksums),
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(server.returncode, 0, server.stderr)


if __name__ == "__main__":
    unittest.main()
