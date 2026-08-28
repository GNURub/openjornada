from pathlib import Path
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile

from scripts import package_release


EXPECTED_UNIX = [
    "LICENSE",
    "NOTICE",
    "THIRD_PARTY_NOTICES",
    "openjornada-terminal",
]
EXPECTED_WINDOWS = [
    "LICENSE",
    "NOTICE",
    "THIRD_PARTY_NOTICES",
    "openjornada-terminal.exe",
]


class PackageReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.inputs = self.root / "inputs"
        self.inputs.mkdir()
        self.binary = self.inputs / "compiled-output"
        self.license = self.inputs / "LICENSE"
        self.notice = self.inputs / "NOTICE"
        self.third_party = self.inputs / "THIRD_PARTY_NOTICES"
        self.binary.write_bytes(b"terminal executable\n")
        self.license.write_bytes(b"license\n")
        self.notice.write_bytes(b"notice\n")
        self.third_party.write_bytes(b"third party\n")

    def tearDown(self):
        self.temporary.cleanup()

    def package(self, output: Path, target_os: str = "linux", arch: str = "amd64") -> Path:
        return package_release.package_archive(
            binary=self.binary,
            target_os=target_os,
            arch=arch,
            license_file=self.license,
            notice_file=self.notice,
            third_party_file=self.third_party,
            output_dir=output,
        )

    def test_linux_archive_is_reproducible_and_bounded(self):
        first = self.package(self.root / "first")
        second = self.package(self.root / "second")

        self.assertEqual(first.read_bytes(), second.read_bytes())
        self.assertEqual(first.name, "openjornada-terminal_linux_amd64.tar.gz")
        with tarfile.open(first, "r:gz") as archive:
            members = archive.getmembers()
            self.assertEqual([member.name for member in members], EXPECTED_UNIX)
            self.assertEqual(
                [archive.extractfile(member).read() for member in members],
                [b"license\n", b"notice\n", b"third party\n", b"terminal executable\n"],
            )
            self.assertEqual([member.mode for member in members], [0o644, 0o644, 0o644, 0o755])
            self.assertTrue(all(member.mtime == 0 for member in members))
            self.assertTrue(all(member.uid == 0 and member.gid == 0 for member in members))
            self.assertTrue(all(member.uname == "" and member.gname == "" for member in members))
            self.assertTrue(all(member.isfile() for member in members))

        self.assertEqual(int.from_bytes(first.read_bytes()[4:8], "little"), 0)

    def test_windows_archive_has_exe_name_fixed_metadata_and_modes(self):
        first = self.package(self.root / "first", "windows", "arm64")
        second = self.package(self.root / "second", "windows", "arm64")

        self.assertEqual(first.read_bytes(), second.read_bytes())
        self.assertEqual(first.name, "openjornada-terminal_windows_arm64.zip")
        with zipfile.ZipFile(first) as archive:
            infos = archive.infolist()
            self.assertEqual([info.filename for info in infos], EXPECTED_WINDOWS)
            self.assertEqual([info.date_time for info in infos], [(1980, 1, 1, 0, 0, 0)] * 4)
            self.assertEqual([info.create_system for info in infos], [3] * 4)
            self.assertEqual(
                [stat.S_IMODE(info.external_attr >> 16) for info in infos],
                [0o644, 0o644, 0o644, 0o755],
            )
            self.assertEqual(
                [archive.read(info) for info in infos],
                [b"license\n", b"notice\n", b"third party\n", b"terminal executable\n"],
            )

    def test_rejects_symlink_and_non_regular_inputs(self):
        symlink = self.inputs / "linked-binary"
        symlink.symlink_to(self.binary)
        self.binary = symlink
        with self.assertRaisesRegex(ValueError, "regular file"):
            self.package(self.root / "symlink-output")

        self.binary = self.inputs
        with self.assertRaisesRegex(ValueError, "regular file"):
            self.package(self.root / "directory-output")

    def test_rejects_unexpected_metadata_filename(self):
        unexpected = self.inputs / "COPYING"
        unexpected.write_bytes(self.license.read_bytes())
        self.license = unexpected

        with self.assertRaisesRegex(ValueError, "LICENSE"):
            self.package(self.root / "output")

    def test_rejects_unsupported_target(self):
        with self.assertRaisesRegex(ValueError, "unsupported target"):
            self.package(self.root / "output", "freebsd", "amd64")
        with self.assertRaisesRegex(ValueError, "unsupported target"):
            self.package(self.root / "output", "linux", "386")

    def test_refuses_unsafe_output_locations_and_existing_archive(self):
        regular_file = self.root / "not-a-directory"
        regular_file.write_bytes(b"x")
        with self.assertRaisesRegex(ValueError, "output directory"):
            self.package(regular_file)

        real_output = self.root / "real-output"
        real_output.mkdir()
        linked_output = self.root / "linked-output"
        linked_output.symlink_to(real_output, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "output directory"):
            self.package(linked_output)

        archive = self.package(real_output)
        original = archive.read_bytes()
        with self.assertRaisesRegex(FileExistsError, archive.name):
            self.package(real_output)
        self.assertEqual(archive.read_bytes(), original)

    def test_command_line_interface_uses_documented_arguments(self):
        output = self.root / "cli-output"
        result = subprocess.run(
            [
                sys.executable,
                str(Path(package_release.__file__)),
                "--binary",
                str(self.binary),
                "--os",
                "darwin",
                "--arch",
                "arm64",
                "--license",
                str(self.license),
                "--notice",
                str(self.notice),
                "--third-party",
                str(self.third_party),
                "--output",
                str(output),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        archive = output / "openjornada-terminal_darwin_arm64.tar.gz"
        self.assertEqual(result.stdout.strip(), str(archive))
        self.assertTrue(archive.is_file())


if __name__ == "__main__":
    unittest.main()
