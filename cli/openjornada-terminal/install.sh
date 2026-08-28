#!/bin/sh
set -eu

umask 077
LC_ALL=C
export LC_ALL

readonly download_base=https://github.com/GNURub/openjornada/releases/latest/download

die() {
    printf 'openjornada-terminal: error: %s\n' "$*" >&2
    exit 1
}

case $(uname -s) in
    Linux) target_os=linux ;;
    Darwin) target_os=darwin ;;
    *) die 'sistema operativo no compatible' ;;
esac

case $(uname -m) in
    x86_64|amd64) target_arch=amd64 ;;
    arm64|aarch64) target_arch=arm64 ;;
    *) die 'arquitectura no compatible' ;;
esac

archive_name=openjornada-terminal_${target_os}_${target_arch}.tar.gz
work_dir=$(mktemp -d "${TMPDIR:-/tmp}/openjornada-terminal.XXXXXX") || \
    die 'no se pudo crear el directorio temporal'
install_tmp=

cleanup() {
    status=$?
    trap - 0 HUP INT TERM
    if [ -n "$install_tmp" ]; then
        rm -f "$install_tmp"
    fi
    rm -rf "$work_dir"
    exit "$status"
}
trap cleanup 0
trap 'exit 1' HUP INT TERM

checksums=$work_dir/checksums.txt
archive=$work_dir/$archive_name
members=$work_dir/archive-members.txt
verbose_members=$work_dir/archive-members-verbose.txt
extract_dir=$work_dir/extracted

command -v curl >/dev/null 2>&1 || die 'se necesita curl'
command -v tar >/dev/null 2>&1 || die 'se necesita tar'

curl -fsSL --output "$checksums" "$download_base/checksums.txt" || \
    die 'no se pudo descargar checksums.txt'
curl -fsSL --output "$archive" "$download_base/$archive_name" || \
    die 'no se pudo descargar el archivo de la plataforma'

if ! expected_digest=$(awk -v target="$archive_name" '
    {
        line_digest = substr($0, 1, 64)
        separator = substr($0, 65, 2)
        name = substr($0, 67)
        if (length(line_digest) != 64 || line_digest ~ /[^0-9a-f]/ ||
            separator != "  " || name == "") {
            invalid = 1
            next
        }
        seen[name]++
        if (seen[name] != 1) {
            invalid = 1
        }
        if (name == target) {
            matches++
            digest = line_digest
        }
    }
    END {
        if (invalid || matches != 1) {
            exit 1
        }
        print digest
    }
' "$checksums"); then
    die 'checksums.txt no es canónico o no contiene una única línea exacta para el archivo'
fi

if command -v sha256sum >/dev/null 2>&1; then
    actual_digest=$(sha256sum "$archive" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
    actual_digest=$(shasum -a 256 "$archive" | awk '{print $1}')
else
    die 'se necesita sha256sum o shasum'
fi

case $actual_digest in
    *[!0-9a-f]*|'') die 'la herramienta SHA-256 devolvió un resultado no válido' ;;
esac
[ "${#actual_digest}" -eq 64 ] || \
    die 'la herramienta SHA-256 devolvió un resultado no válido'
[ "$actual_digest" = "$expected_digest" ] || \
    die 'el checksum SHA-256 del archivo no coincide'

tar -tzf "$archive" > "$members" || die 'el archivo tar no es válido'
if ! awk '
    $0 == "LICENSE" { license++; next }
    $0 == "NOTICE" { notice++; next }
    $0 == "THIRD_PARTY_NOTICES" { third_party++; next }
    $0 == "openjornada-terminal" { binary++; next }
    { invalid = 1 }
    END {
        if (invalid || NR != 4 || license != 1 || notice != 1 ||
            third_party != 1 || binary != 1) {
            exit 1
        }
    }
' "$members"; then
    die 'el archivo debe contener exactamente los cuatro ficheros esperados'
fi

tar -tvzf "$archive" > "$verbose_members" || die 'no se pudo inspeccionar el archivo tar'
if ! awk '
    substr($0, 1, 1) != "-" { invalid = 1 }
    END { if (invalid || NR != 4) exit 1 }
' "$verbose_members"; then
    die 'el archivo contiene enlaces o entradas que no son ficheros regulares'
fi

mkdir "$extract_dir" || die 'no se pudo preparar la extracción'
tar -xzf "$archive" -C "$extract_dir" \
    LICENSE NOTICE THIRD_PARTY_NOTICES openjornada-terminal || \
    die 'no se pudo extraer el archivo verificado'

for expected_file in LICENSE NOTICE THIRD_PARTY_NOTICES openjornada-terminal; do
    [ -f "$extract_dir/$expected_file" ] && [ ! -L "$extract_dir/$expected_file" ] || \
        die 'la extracción no produjo los cuatro ficheros regulares esperados'
done

install_dir=${OPENJORNADA_INSTALL_DIR:-$HOME/.local/bin}
[ -n "$install_dir" ] || die 'el directorio de instalación está vacío'
mkdir -p "$install_dir" || die 'no se pudo crear el directorio de instalación'
[ -d "$install_dir" ] || die 'el destino de instalación no es un directorio'

destination=$install_dir/openjornada-terminal
[ ! -d "$destination" ] || die 'el destino del ejecutable es un directorio'
install_tmp=$(mktemp "$install_dir/.openjornada-terminal.XXXXXX") || \
    die 'no se pudo crear el ejecutable temporal en el destino'
cp "$extract_dir/openjornada-terminal" "$install_tmp" || \
    die 'no se pudo copiar el ejecutable verificado'
chmod 0755 "$install_tmp" || die 'no se pudo establecer el modo 0755'
mv -f "$install_tmp" "$destination" || die 'no se pudo instalar el ejecutable atómicamente'
install_tmp=

printf 'openjornada-terminal instalado en %s\n' "$destination"
