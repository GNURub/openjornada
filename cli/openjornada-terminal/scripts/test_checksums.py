import hashlib
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from scripts import checksums


class ChecksumsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def test_writes_lowercase_sorted_bytewise_inventory_with_two_spaces(self):
        zeta = self.root / "zeta.zip"
        alpha = self.root / "Alpha.tar.gz"
        accented = self.root / "árchive.zip"
        zeta.write_bytes(b"zeta")
        alpha.write_bytes(b"alpha")
        accented.write_bytes(b"accented")
        output = self.root / "checksums.txt"

        result = checksums.write_checksums([zeta, accented, alpha], output)

        self.assertEqual(result, output)
        expected = b"".join(
            hashlib.sha256(path.read_bytes()).hexdigest().encode("ascii")
            + b"  "
            + path.name.encode("utf-8")
            + b"\n"
            for path in [alpha, zeta, accented]
        )
        self.assertEqual(output.read_bytes(), expected)
        for line in output.read_text(encoding="utf-8").splitlines():
            self.assertNotRegex(line.split("  ", 1)[0], r"[A-F]")

    def test_rejects_duplicate_basenames(self):
        first_dir = self.root / "first"
        second_dir = self.root / "second"
        first_dir.mkdir()
        second_dir.mkdir()
        first = first_dir / "asset.zip"
        second = second_dir / "asset.zip"
        first.write_bytes(b"first")
        second.write_bytes(b"second")

        with self.assertRaisesRegex(ValueError, "duplicate basename"):
            checksums.write_checksums([first, second], self.root / "checksums.txt")

    def test_refuses_output_itself_by_path_or_basename(self):
        output = self.root / "checksums.txt"
        output.write_bytes(b"old")
        with self.assertRaisesRegex(ValueError, "output itself"):
            checksums.write_checksums([output], output)

        other = self.root / "nested"
        other.mkdir()
        forbidden = other / "checksums.txt"
        forbidden.write_bytes(b"not an inventory")
        with self.assertRaisesRegex(ValueError, "checksums.txt"):
            checksums.write_checksums([forbidden], self.root / "inventory.txt")

    def test_rejects_symlink_and_non_regular_inputs(self):
        asset = self.root / "asset.zip"
        asset.write_bytes(b"asset")
        symlink = self.root / "asset-link.zip"
        symlink.symlink_to(asset)
        with self.assertRaisesRegex(ValueError, "regular file"):
            checksums.write_checksums([symlink], self.root / "checksums.txt")

        with self.assertRaisesRegex(ValueError, "regular file"):
            checksums.write_checksums([self.root], self.root / "checksums.txt")

    def test_rejects_unsafe_or_existing_output(self):
        asset = self.root / "asset.zip"
        asset.write_bytes(b"asset")
        output = self.root / "checksums.txt"
        output.symlink_to(asset)
        with self.assertRaisesRegex(FileExistsError, "checksums.txt"):
            checksums.write_checksums([asset], output)

        output.unlink()
        output.write_bytes(b"old")
        with self.assertRaisesRegex(FileExistsError, "checksums.txt"):
            checksums.write_checksums([asset], output)

    def test_rejects_empty_input_and_unsafe_filenames(self):
        with self.assertRaisesRegex(ValueError, "at least one"):
            checksums.write_checksums([], self.root / "checksums.txt")

        unsafe = self.root / "line\nbreak.zip"
        unsafe.write_bytes(b"asset")
        with self.assertRaisesRegex(ValueError, "filename"):
            checksums.write_checksums([unsafe], self.root / "checksums.txt")

    def test_command_line_interface_uses_documented_arguments(self):
        asset = self.root / "asset.zip"
        asset.write_bytes(b"asset")
        output = self.root / "inventory.txt"
        result = subprocess.run(
            [sys.executable, str(Path(checksums.__file__)), str(asset), "--output", str(output)],
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.stdout.strip(), str(output))
        self.assertEqual(
            output.read_text(encoding="utf-8"),
            f"{hashlib.sha256(b'asset').hexdigest()}  asset.zip\n",
        )


if __name__ == "__main__":
    unittest.main()
