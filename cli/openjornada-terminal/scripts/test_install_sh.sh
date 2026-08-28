#!/bin/sh
set -eu

umask 077

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
installer=$script_dir/../install.sh
test_root=$(mktemp -d "${TMPDIR:-/tmp}/openjornada-install-test.XXXXXX")

cleanup() {
    status=$?
    trap - 0 HUP INT TERM
    rm -rf "$test_root"
    exit "$status"
}
trap cleanup 0
trap 'exit 1' HUP INT TERM

fail() {
    printf 'test_install_sh.sh: %s\n' "$*" >&2
    exit 1
}

fixture_dir=$test_root/fixtures
source_dir=$test_root/source
stub_dir=$test_root/stubs
install_dir=$test_root/'installation with spaces'
home_dir=$test_root/'home with spaces'
work_tmp=$test_root/'temporary files'
curl_log=$test_root/curl.log
mkdir -p "$fixture_dir" "$source_dir" "$stub_dir" "$install_dir" "$home_dir" "$work_tmp"

cat > "$source_dir/openjornada-terminal" <<'EOF'
#!/bin/sh
if [ "${1-}" = version ]; then
    printf '%s\n' fixture-version
    exit 0
fi
exit 2
EOF
chmod 0755 "$source_dir/openjornada-terminal"
printf '%s\n' license > "$source_dir/LICENSE"
printf '%s\n' notice > "$source_dir/NOTICE"
printf '%s\n' third-party > "$source_dir/THIRD_PARTY_NOTICES"

cat > "$stub_dir/uname" <<'EOF'
#!/bin/sh
case ${1-} in
    -s) printf '%s\n' "$TEST_UNAME_SYSTEM" ;;
    -m) printf '%s\n' "$TEST_UNAME_MACHINE" ;;
    *) exit 2 ;;
esac
EOF
chmod 0755 "$stub_dir/uname"

cat > "$stub_dir/curl" <<'EOF'
#!/bin/sh
set -eu

output=
url=
while [ "$#" -gt 0 ]; do
    case $1 in
        -fsSL) ;;
        -o|--output)
            shift
            [ "$#" -gt 0 ] || exit 2
            output=$1
            ;;
        https://github.com/GNURub/openjornada/releases/latest/download/*)
            url=$1
            ;;
        *) exit 2 ;;
    esac
    shift
done
[ -n "$output" ] && [ -n "$url" ] || exit 2
printf '%s\n' "$url" >> "$TEST_CURL_LOG"
asset=${url##*/}
case $asset in
    checksums.txt|openjornada-terminal_linux_amd64.tar.gz|openjornada-terminal_linux_arm64.tar.gz|openjornada-terminal_darwin_amd64.tar.gz|openjornada-terminal_darwin_arm64.tar.gz) ;;
    *) exit 2 ;;
esac
cp "$TEST_FIXTURE_DIR/$asset" "$output"
EOF
chmod 0755 "$stub_dir/curl"

digest_file() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    else
        shasum -a 256 "$1" | awk '{print $1}'
    fi
}

archive_name=openjornada-terminal_linux_amd64.tar.gz
archive=$fixture_dir/$archive_name

make_valid_archive() {
    rm -f "$archive"
    tar -czf "$archive" -C "$source_dir" \
        LICENSE NOTICE THIRD_PARTY_NOTICES openjornada-terminal
}

write_valid_checksum() {
    printf '%s  %s\n' "$(digest_file "$archive")" "$archive_name" \
        > "$fixture_dir/checksums.txt"
}

run_installer() {
    TEST_UNAME_SYSTEM=${TEST_UNAME_SYSTEM:-Linux} \
    TEST_UNAME_MACHINE=${TEST_UNAME_MACHINE:-x86_64} \
    TEST_FIXTURE_DIR=$fixture_dir \
    TEST_CURL_LOG=$curl_log \
    OPENJORNADA_INSTALL_DIR=$install_dir \
    HOME=$home_dir \
    TMPDIR=$work_tmp \
    PATH=$stub_dir:$PATH \
        sh "$installer"
}

expect_failure() {
    description=$1
    if run_installer > "$test_root/stdout" 2> "$test_root/stderr"; then
        fail "$description: the installer unexpectedly succeeded"
    fi
}

assert_old_binary() {
    actual=$("$install_dir/openjornada-terminal" version)
    [ "$actual" = old-version ] || fail "the old binary was changed after a rejected download"
}

install_old_binary() {
    cat > "$install_dir/openjornada-terminal" <<'EOF'
#!/bin/sh
printf '%s\n' old-version
EOF
    chmod 0755 "$install_dir/openjornada-terminal"
}

# The normal path works when the script itself arrives on standard input, as in
# `curl .../install.sh | sh`, and accepts a destination containing spaces.
make_valid_archive
write_valid_checksum
TEST_UNAME_SYSTEM=Linux TEST_UNAME_MACHINE=x86_64 \
TEST_FIXTURE_DIR=$fixture_dir TEST_CURL_LOG=$curl_log \
OPENJORNADA_INSTALL_DIR=$install_dir HOME=$home_dir TMPDIR=$work_tmp \
PATH=$stub_dir:$PATH \
    sh < "$installer"
[ "$("$install_dir/openjornada-terminal" version)" = fixture-version ] || \
    fail 'the installed binary did not run'
[ "$(LC_ALL=C stat -c '%a' "$install_dir/openjornada-terminal" 2>/dev/null || \
    LC_ALL=C stat -f '%Lp' "$install_dir/openjornada-terminal")" = 755 ] || \
    fail 'the installed binary mode is not 0755'
[ "$(wc -l < "$curl_log" | tr -d ' ')" = 2 ] || fail 'expected exactly two downloads'
grep -Fx 'https://github.com/GNURub/openjornada/releases/latest/download/checksums.txt' "$curl_log" >/dev/null || \
    fail 'checksums URL did not use the production latest-stable base'
grep -Fx "https://github.com/GNURub/openjornada/releases/latest/download/$archive_name" "$curl_log" >/dev/null || \
    fail 'archive URL did not use the production latest-stable base'
[ -z "$(find "$work_tmp" -mindepth 1 -print -quit)" ] || \
    fail 'the exact temporary work directory was not cleaned up'

# With no override, installation defaults to HOME/.local/bin.
rm -rf "$home_dir/.local"
(
    unset OPENJORNADA_INSTALL_DIR
    TEST_UNAME_SYSTEM=Linux TEST_UNAME_MACHINE=amd64 \
    TEST_FIXTURE_DIR=$fixture_dir TEST_CURL_LOG=$curl_log \
    HOME=$home_dir TMPDIR=$work_tmp PATH=$stub_dir:$PATH \
        sh "$installer" >/dev/null
)
[ "$("$home_dir/.local/bin/openjornada-terminal" version)" = fixture-version ] || \
    fail 'the default HOME/.local/bin installation failed'

# Every documented uname mapping resolves to its exact unversioned archive.
for mapped_name in \
    openjornada-terminal_linux_arm64.tar.gz \
    openjornada-terminal_darwin_amd64.tar.gz \
    openjornada-terminal_darwin_arm64.tar.gz
do
    cp "$archive" "$fixture_dir/$mapped_name"
done
: > "$fixture_dir/checksums.txt"
for mapped_name in \
    openjornada-terminal_linux_amd64.tar.gz \
    openjornada-terminal_linux_arm64.tar.gz \
    openjornada-terminal_darwin_amd64.tar.gz \
    openjornada-terminal_darwin_arm64.tar.gz
do
    printf '%s  %s\n' "$(digest_file "$fixture_dir/$mapped_name")" "$mapped_name" \
        >> "$fixture_dir/checksums.txt"
done
: > "$curl_log"
TEST_UNAME_SYSTEM=Linux TEST_UNAME_MACHINE=aarch64 run_installer >/dev/null
TEST_UNAME_SYSTEM=Darwin TEST_UNAME_MACHINE=x86_64 run_installer >/dev/null
TEST_UNAME_SYSTEM=Darwin TEST_UNAME_MACHINE=arm64 run_installer >/dev/null
for mapped_name in \
    openjornada-terminal_linux_arm64.tar.gz \
    openjornada-terminal_darwin_amd64.tar.gz \
    openjornada-terminal_darwin_arm64.tar.gz
do
    grep -Fx "https://github.com/GNURub/openjornada/releases/latest/download/$mapped_name" "$curl_log" >/dev/null || \
        fail "the uname mapping did not select $mapped_name"
done

# Unsupported systems and architectures fail before curl is invoked.
: > "$curl_log"
if TEST_UNAME_SYSTEM=FreeBSD TEST_UNAME_MACHINE=x86_64 run_installer >/dev/null 2>&1; then
    fail 'an unsupported operating system was accepted'
fi
[ ! -s "$curl_log" ] || fail 'unsupported operating system downloaded assets'
if TEST_UNAME_SYSTEM=Linux TEST_UNAME_MACHINE=riscv64 run_installer >/dev/null 2>&1; then
    fail 'an unsupported architecture was accepted'
fi
[ ! -s "$curl_log" ] || fail 'unsupported architecture downloaded assets'

# A checksum mismatch must not modify an already-installed binary.
install_old_binary
make_valid_archive
write_valid_checksum
printf 'x' >> "$archive"
expect_failure 'corrupt archive'
assert_old_binary

# A target checksum entry must be unique and byte-for-byte canonical.
make_valid_archive
write_valid_checksum
cp "$fixture_dir/checksums.txt" "$test_root/checksum-line"
cat "$test_root/checksum-line" >> "$fixture_dir/checksums.txt"
expect_failure 'duplicate checksum entry'
assert_old_binary
write_valid_checksum
printf '%s %s\n' "$(digest_file "$archive")" "$archive_name" \
    >> "$fixture_dir/checksums.txt"
expect_failure 'canonical checksum plus malformed duplicate entry'
assert_old_binary
printf '%s %s\n' "$(digest_file "$archive")" "$archive_name" > "$fixture_dir/checksums.txt"
expect_failure 'non-canonical checksum entry'
assert_old_binary

# Even correctly checksummed archives are rejected if their inventory contains
# an extra member, a duplicate name, a symlink or a traversal path.
printf '%s\n' extra > "$source_dir/EXTRA"
tar -czf "$archive" -C "$source_dir" \
    LICENSE NOTICE THIRD_PARTY_NOTICES openjornada-terminal EXTRA
write_valid_checksum
expect_failure 'archive with extra member'
assert_old_binary

tar -czf "$archive" -C "$source_dir" \
    LICENSE NOTICE THIRD_PARTY_NOTICES openjornada-terminal openjornada-terminal
write_valid_checksum
expect_failure 'archive with duplicate member'
assert_old_binary

mv "$source_dir/openjornada-terminal" "$source_dir/real-binary"
ln -s real-binary "$source_dir/openjornada-terminal"
tar -czf "$archive" -C "$source_dir" \
    LICENSE NOTICE THIRD_PARTY_NOTICES openjornada-terminal
write_valid_checksum
expect_failure 'archive with symlinked binary'
assert_old_binary
rm "$source_dir/openjornada-terminal"
mv "$source_dir/real-binary" "$source_dir/openjornada-terminal"

MALICIOUS_SOURCE=$source_dir MALICIOUS_ARCHIVE=$archive python3 - <<'PY'
import io
import os
import tarfile

source = os.environ["MALICIOUS_SOURCE"]
output = os.environ["MALICIOUS_ARCHIVE"]
entries = (
    ("LICENSE", "LICENSE"),
    ("NOTICE", "NOTICE"),
    ("THIRD_PARTY_NOTICES", "THIRD_PARTY_NOTICES"),
    ("../openjornada-terminal", "openjornada-terminal"),
)
with tarfile.open(output, "w:gz") as archive:
    for member_name, source_name in entries:
        with open(os.path.join(source, source_name), "rb") as handle:
            contents = handle.read()
        member = tarfile.TarInfo(member_name)
        member.size = len(contents)
        member.mode = 0o755 if source_name == "openjornada-terminal" else 0o644
        archive.addfile(member, io.BytesIO(contents))
PY
write_valid_checksum
expect_failure 'archive with traversal path'
assert_old_binary

printf '%s\n' 'test_install_sh.sh: OK'
