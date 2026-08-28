$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.ZipFile

$script:ArchiveCap = 128MB
$script:ChecksumCap = 64KB
$script:BinaryCap = 100MB
$script:NoticeCap = 5MB

function Get-OpenJornadaStableDownloadBase {
    [Uri]'https://github.com/GNURub/openjornada/releases/latest/download/'
}

function ConvertTo-OpenJornadaArchitecture {
    param([Parameter(Mandatory)][Runtime.InteropServices.Architecture]$Architecture)
    switch ($Architecture) {
        ([Runtime.InteropServices.Architecture]::X64) { return 'amd64' }
        ([Runtime.InteropServices.Architecture]::Arm64) { return 'arm64' }
        default { throw "Arquitectura no compatible: $Architecture" }
    }
}

function Get-OpenJornadaArchitecture {
    ConvertTo-OpenJornadaArchitecture ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture)
}

function Get-OpenJornadaInstallDirectory {
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { throw 'LOCALAPPDATA no está definido.' }
    [IO.Path]::GetFullPath([IO.Path]::Combine($env:LOCALAPPDATA, 'Programs', 'OpenJornada', 'bin'))
}

function Invoke-OpenJornadaDownload {
    param([Parameter(Mandatory)][Uri]$Uri, [Parameter(Mandatory)][string]$OutFile)
    Invoke-WebRequest -Uri $Uri -OutFile $OutFile
}

function Get-OpenJornadaExpectedArchives {
    @(
        'openjornada-terminal_darwin_amd64.tar.gz'
        'openjornada-terminal_darwin_arm64.tar.gz'
        'openjornada-terminal_linux_amd64.tar.gz'
        'openjornada-terminal_linux_arm64.tar.gz'
        'openjornada-terminal_windows_amd64.zip'
        'openjornada-terminal_windows_arm64.zip'
    )
}

function Read-OpenJornadaChecksumInventory {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$ArchiveName)
    $file = Get-Item -LiteralPath $Path
    if ($file.Length -le 0 -or $file.Length -gt $script:ChecksumCap) {
        throw 'checksums.txt está vacío o supera el límite permitido.'
    }
    $expected = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($name in Get-OpenJornadaExpectedArchives) { [void]$expected.Add($name) }
    if (-not $expected.Contains($ArchiveName)) { throw 'El archivo no pertenece al inventario publicado.' }
    $digests = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
    foreach ($line in [IO.File]::ReadAllLines($file.FullName)) {
        if ($line -cnotmatch '^(?<digest>[0-9a-f]{64})  (?<name>[^\r\n]+)$') {
            throw 'checksums.txt no usa el formato canónico.'
        }
        $name = $Matches.name
        if (-not $expected.Contains($name) -or $digests.ContainsKey($name)) {
            throw 'checksums.txt contiene un nombre inesperado o duplicado.'
        }
        $digests.Add($name, $Matches.digest)
    }
    if ($digests.Count -ne $expected.Count) {
        throw 'checksums.txt no contiene exactamente los seis archivos publicados.'
    }
    foreach ($name in $expected) {
        if (-not $digests.ContainsKey($name)) {
            throw 'checksums.txt no contiene exactamente los seis archivos publicados.'
        }
    }
    $digests[$ArchiveName]
}

function Test-OpenJornadaRegularZipEntry {
    param([Parameter(Mandatory)][IO.Compression.ZipArchiveEntry]$Entry)
    $bytes = [BitConverter]::GetBytes([int]$Entry.ExternalAttributes)
    $attributes = [BitConverter]::ToUInt32($bytes, 0)
    $unixType = ($attributes -shr 16) -band 0xF000
    $dosAttributes = $attributes -band 0xFFFF
    if ($unixType -eq 0xA000 -or ($dosAttributes -band 0x0400) -ne 0) { return $false }
    if ($unixType -ne 0 -and $unixType -ne 0x8000) { return $false }
    return $true
}

function Expand-OpenJornadaArchive {
    param([Parameter(Mandatory)][string]$ArchivePath, [Parameter(Mandatory)][string]$DestinationDirectory)
    $file = Get-Item -LiteralPath $ArchivePath
    if ($file.Length -le 0 -or $file.Length -gt $script:ArchiveCap) {
        throw 'El ZIP está vacío o supera el límite permitido.'
    }
    $limits = [Collections.Generic.Dictionary[string,long]]::new([StringComparer]::Ordinal)
    $limits.Add('LICENSE', $script:NoticeCap)
    $limits.Add('NOTICE', $script:NoticeCap)
    $limits.Add('THIRD_PARTY_NOTICES', $script:NoticeCap)
    $limits.Add('openjornada-terminal.exe', $script:BinaryCap)
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)

    $zip = [IO.Compression.ZipFile]::OpenRead($file.FullName)
    try {
        if ($zip.Entries.Count -ne $limits.Count) {
            throw 'El ZIP no contiene exactamente los cuatro ficheros esperados.'
        }
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName
            if ([IO.Path]::IsPathRooted($name) -or $name.Contains('/') -or $name.Contains('\') -or
                $name.Contains(':') -or $name -eq '.' -or $name -eq '..' -or
                -not $limits.ContainsKey($name) -or -not $seen.Add($name)) {
                throw 'El ZIP contiene rutas, duplicados o ficheros inesperados.'
            }
            if (-not (Test-OpenJornadaRegularZipEntry $entry)) {
                throw 'El ZIP contiene un enlace o una entrada que no es un fichero regular.'
            }
            if ($entry.Length -le 0 -or $entry.Length -gt $limits[$name]) {
                throw 'El ZIP contiene un fichero vacío o que supera el límite permitido.'
            }
        }
        foreach ($required in $limits.Keys) {
            if (-not $seen.Contains($required)) { throw 'El ZIP carece de un fichero esperado.' }
        }
        [void][IO.Directory]::CreateDirectory($DestinationDirectory)
        foreach ($entry in $zip.Entries) {
            $destination = [IO.Path]::Combine($DestinationDirectory, $entry.FullName)
            $input = $entry.Open()
            try {
                $output = [IO.File]::Open($destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
                try {
                    $buffer = [byte[]]::new(81920)
                    [long]$writtenLength = 0
                    while (($readLength = $input.Read($buffer, 0, $buffer.Length)) -gt 0) {
                        $writtenLength += $readLength
                        if ($writtenLength -gt $limits[$entry.FullName]) {
                            throw 'La extracción supera el límite permitido.'
                        }
                        $output.Write($buffer, 0, $readLength)
                    }
                }
                finally { $output.Dispose() }
            }
            finally { $input.Dispose() }
            if ($writtenLength -ne $entry.Length -or (Get-Item -LiteralPath $destination).Length -ne $entry.Length) {
                throw 'La extracción del ZIP quedó incompleta.'
            }
        }
    }
    finally { $zip.Dispose() }
}

function ConvertTo-OpenJornadaNormalizedPath {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Path)
    $candidate = $Path.Trim().Trim('"')
    if ($candidate.Length -eq 0) { return '' }
    $trimCharacters = [char[]]@([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    try {
        $full = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($candidate))
        return $full.TrimEnd($trimCharacters)
    }
    catch {
        return $candidate.TrimEnd($trimCharacters)
    }
}

function Add-OpenJornadaUserPath {
    param(
        [Parameter(Mandatory)][string]$InstallDirectory,
        [scriptblock]$GetUserPath = { [Environment]::GetEnvironmentVariable('Path', [EnvironmentVariableTarget]::User) },
        [scriptblock]$SetUserPath = { param([string]$Value) [Environment]::SetEnvironmentVariable('Path', $Value, [EnvironmentVariableTarget]::User) }
    )
    $exact = [IO.Path]::GetFullPath($InstallDirectory)
    $normalized = ConvertTo-OpenJornadaNormalizedPath $exact
    $current = & $GetUserPath
    if ($null -eq $current) { $current = '' }
    foreach ($entry in ($current -split [IO.Path]::PathSeparator)) {
        if ([StringComparer]::OrdinalIgnoreCase.Equals((ConvertTo-OpenJornadaNormalizedPath $entry), $normalized)) {
            return [pscustomobject]@{ Changed = $false; Original = $current }
        }
    }
    $newPath = if ($current.Length -eq 0) { $exact } else { "$current$([IO.Path]::PathSeparator)$exact" }
    & $SetUserPath $newPath
    [pscustomobject]@{ Changed = $true; Original = $current }
}

function Install-OpenJornadaBinaryAtomically {
    param([Parameter(Mandatory)][string]$Source, [Parameter(Mandatory)][string]$InstallDirectory)
    [void][IO.Directory]::CreateDirectory($InstallDirectory)
    $destination = [IO.Path]::Combine($InstallDirectory, 'openjornada-terminal.exe')
    if ([IO.Directory]::Exists($destination)) { throw 'El destino del ejecutable es un directorio.' }
    $id = [Guid]::NewGuid().ToString('N')
    $staged = [IO.Path]::Combine($InstallDirectory, ".openjornada-terminal.$id.tmp")
    $backup = [IO.Path]::Combine($InstallDirectory, ".openjornada-terminal.$id.bak")
    [IO.File]::Copy($Source, $staged, $false)
    try {
        if ([IO.File]::Exists($destination)) {
            if (([IO.File]::GetAttributes($destination) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'El ejecutable de destino no puede ser un enlace.'
            }
            [IO.File]::Replace($staged, $destination, $backup, $true)
            [IO.File]::Delete($backup)
        }
        else { [IO.File]::Move($staged, $destination) }
    }
    catch {
        if ([IO.File]::Exists($backup)) {
            if ([IO.File]::Exists($destination)) { [IO.File]::Replace($backup, $destination, $null, $true) }
            else { [IO.File]::Move($backup, $destination) }
        }
        throw
    }
    finally {
        if ([IO.File]::Exists($staged)) { [IO.File]::Delete($staged) }
        if ([IO.File]::Exists($backup)) { [IO.File]::Delete($backup) }
    }
    $destination
}

function Install-OpenJornadaRelease {
    param(
        [Parameter(Mandatory)][string]$ArchiveName,
        [Parameter(Mandatory)][string]$InstallDirectory,
        [scriptblock]$DownloadFile = ${function:Invoke-OpenJornadaDownload},
        [scriptblock]$GetUserPath = { [Environment]::GetEnvironmentVariable('Path', [EnvironmentVariableTarget]::User) },
        [scriptblock]$SetUserPath = { param([string]$Value) [Environment]::SetEnvironmentVariable('Path', $Value, [EnvironmentVariableTarget]::User) }
    )
    if ($ArchiveName -cne 'openjornada-terminal_windows_amd64.zip' -and
        $ArchiveName -cne 'openjornada-terminal_windows_arm64.zip') {
        throw 'El instalador de Windows recibió un nombre de archivo no permitido.'
    }
    $work = [IO.Path]::Combine([IO.Path]::GetTempPath(), "openjornada-terminal-$([Guid]::NewGuid().ToString('N'))")
    [void][IO.Directory]::CreateDirectory($work)
    try {
        $checksums = [IO.Path]::Combine($work, 'checksums.txt')
        $archive = [IO.Path]::Combine($work, $ArchiveName)
        $extracted = [IO.Path]::Combine($work, 'extracted')
        $downloadBase = Get-OpenJornadaStableDownloadBase
        & $DownloadFile -Uri ([Uri]::new($downloadBase, 'checksums.txt')) -OutFile $checksums
        & $DownloadFile -Uri ([Uri]::new($downloadBase, $ArchiveName)) -OutFile $archive
        $archiveFile = Get-Item -LiteralPath $archive
        if ($archiveFile.Length -le 0 -or $archiveFile.Length -gt $script:ArchiveCap) {
            throw 'El ZIP está vacío o supera el límite permitido.'
        }
        $expected = Read-OpenJornadaChecksumInventory $checksums $ArchiveName
        $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
        if (-not [StringComparer]::Ordinal.Equals($actual, $expected)) {
            throw 'El checksum SHA-256 del archivo no coincide.'
        }
        Expand-OpenJornadaArchive $archive $extracted
        $pathChange = Add-OpenJornadaUserPath $InstallDirectory $GetUserPath $SetUserPath
        try {
            $destination = Install-OpenJornadaBinaryAtomically `
                ([IO.Path]::Combine($extracted, 'openjornada-terminal.exe')) $InstallDirectory
        }
        catch {
            if ($pathChange.Changed) { & $SetUserPath $pathChange.Original }
            throw
        }
        Write-Host "openjornada-terminal instalado en $destination"
    }
    finally {
        if ([IO.Directory]::Exists($work)) { Remove-Item -LiteralPath $work -Recurse -Force }
    }
}

function Invoke-OpenJornadaInstaller {
    $architecture = Get-OpenJornadaArchitecture
    Install-OpenJornadaRelease `
        -ArchiveName "openjornada-terminal_windows_$architecture.zip" `
        -InstallDirectory (Get-OpenJornadaInstallDirectory)
}

if ($MyInvocation.InvocationName -ne '.') { Invoke-OpenJornadaInstaller }
