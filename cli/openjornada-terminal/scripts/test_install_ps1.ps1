$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$installer = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..', 'install.ps1'))
. $installer
$testRoot = [IO.Path]::Combine([IO.Path]::GetTempPath(), "openjornada-install-test-$([Guid]::NewGuid().ToString('N'))")
[void][IO.Directory]::CreateDirectory($testRoot)

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw "test_install_ps1.ps1: $Message" }
}

function Assert-Throws {
    param([scriptblock]$Action, [string]$Message)
    try { & $Action } catch { return }
    throw "test_install_ps1.ps1: $Message"
}

function New-FixtureZip {
    param([string]$Path, [object[]]$Entries)
    Add-Type -AssemblyName System.IO.Compression
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $false)
        try {
            foreach ($item in $Entries) {
                $entry = $zip.CreateEntry($item.Name, [IO.Compression.CompressionLevel]::Optimal)
                if ($null -ne $item.Attributes) { $entry.ExternalAttributes = $item.Attributes }
                $output = $entry.Open()
                try {
                    if ($item.ContainsKey('Source')) {
                        $input = [IO.File]::OpenRead($item.Source)
                        try { $input.CopyTo($output) } finally { $input.Dispose() }
                    }
                    elseif ($item.ContainsKey('Bytes')) {
                        $output.Write($item.Bytes, 0, $item.Bytes.Length)
                    }
                }
                finally { $output.Dispose() }
            }
        }
        finally { $zip.Dispose() }
    }
    finally { $stream.Dispose() }
}

function Get-ValidEntries {
    param([string]$Executable)
    @(
        @{ Name = 'LICENSE'; Bytes = [Text.Encoding]::UTF8.GetBytes('license'); Attributes = $null }
        @{ Name = 'NOTICE'; Bytes = [Text.Encoding]::UTF8.GetBytes('notice'); Attributes = $null }
        @{ Name = 'THIRD_PARTY_NOTICES'; Bytes = [Text.Encoding]::UTF8.GetBytes('third-party'); Attributes = $null }
        @{ Name = 'openjornada-terminal.exe'; Source = $Executable; Attributes = $null }
    )
}

function Write-ChecksumInventory {
    param([string]$FixtureDirectory, [string]$SelectedArchive)
    $digest = (Get-FileHash -LiteralPath ([IO.Path]::Combine($FixtureDirectory, $SelectedArchive)) -Algorithm SHA256).Hash.ToLowerInvariant()
    $lines = foreach ($name in Get-OpenJornadaExpectedArchives) { "$digest  $name" }
    [IO.File]::WriteAllLines([IO.Path]::Combine($FixtureDirectory, 'checksums.txt'), $lines)
}

function Invoke-FixtureInstall {
    param([string]$FixtureDirectory, [string]$InstallDirectory, [hashtable]$PathState, [hashtable]$RunState)
    $download = {
        param([Uri]$Uri, [string]$OutFile)
        $asset = [IO.Path]::GetFileName($Uri.AbsolutePath)
        $RunState.Downloads.Add($Uri.AbsoluteUri)
        $RunState.WorkDirectory = [IO.Path]::GetDirectoryName($OutFile)
        [IO.File]::Copy([IO.Path]::Combine($FixtureDirectory, $asset), $OutFile, $false)
    }.GetNewClosure()
    $getPath = { $PathState.Value }.GetNewClosure()
    $setPath = { param([string]$Value) $PathState.Value = $Value; $PathState.Writes++ }.GetNewClosure()
    Install-OpenJornadaRelease `
        -ArchiveName 'openjornada-terminal_windows_amd64.zip' `
        -InstallDirectory $InstallDirectory `
        -DownloadFile $download `
        -GetUserPath $getPath `
        -SetUserPath $setPath
}

try {
    Assert-True ((ConvertTo-OpenJornadaArchitecture ([Runtime.InteropServices.Architecture]::X64)) -ceq 'amd64') 'X64 no se mapeó a amd64'
    Assert-True ((ConvertTo-OpenJornadaArchitecture ([Runtime.InteropServices.Architecture]::Arm64)) -ceq 'arm64') 'Arm64 no se mapeó a arm64'
    Assert-Throws { ConvertTo-OpenJornadaArchitecture ([Runtime.InteropServices.Architecture]::X86) } 'X86 fue aceptado'

    $savedLocalAppData = $env:LOCALAPPDATA
    try {
        $env:LOCALAPPDATA = [IO.Path]::Combine($testRoot, 'local app data')
        $expected = [IO.Path]::GetFullPath([IO.Path]::Combine($env:LOCALAPPDATA, 'Programs', 'OpenJornada', 'bin'))
        Assert-True ([StringComparer]::Ordinal.Equals((Get-OpenJornadaInstallDirectory), $expected)) 'el destino no deriva exactamente de LOCALAPPDATA'
    }
    finally { $env:LOCALAPPDATA = $savedLocalAppData }

    $fixture = [IO.Path]::Combine($testRoot, 'fixture')
    $install = [IO.Path]::Combine($testRoot, 'installation with spaces')
    [void][IO.Directory]::CreateDirectory($fixture)
    $archiveName = 'openjornada-terminal_windows_amd64.zip'
    $archive = [IO.Path]::Combine($fixture, $archiveName)
    $fixtureExecutable = [IO.Path]::Combine($env:SystemRoot, 'System32', 'cmd.exe')
    Assert-True ([IO.File]::Exists($fixtureExecutable)) 'cmd.exe no existe en System32'
    New-FixtureZip $archive (Get-ValidEntries $fixtureExecutable)
    Write-ChecksumInventory $fixture $archiveName

    $pathState = @{ Value = 'C:\Windows\System32'; Writes = 0 }
    $runState = @{ Downloads = [Collections.Generic.List[string]]::new(); WorkDirectory = '' }
    Invoke-FixtureInstall $fixture $install $pathState $runState
    $installed = [IO.Path]::Combine($install, 'openjornada-terminal.exe')
    Assert-True ([IO.File]::Exists($installed)) 'no se instaló el ejecutable'
    $output = & $installed /d /c 'echo fixture-version'
    Assert-True (($output | Out-String).Trim() -ceq 'fixture-version') 'el ejecutable instalado no funciona'
    Assert-True ($runState.Downloads.Count -eq 2) 'no hubo exactamente dos descargas'
    Assert-True ($runState.Downloads[0] -ceq 'https://github.com/GNURub/openjornada/releases/latest/download/checksums.txt') 'checksums no usa latest estable'
    Assert-True ($runState.Downloads[1] -ceq "https://github.com/GNURub/openjornada/releases/latest/download/$archiveName") 'el ZIP no usa latest estable'
    Assert-True (-not [IO.Directory]::Exists($runState.WorkDirectory)) 'no se eliminó el directorio temporal exacto'
    Assert-True ($pathState.Writes -eq 1) 'PATH no se escribió exactamente una vez'
    Assert-True ($pathState.Value.EndsWith(";$([IO.Path]::GetFullPath($install))", [StringComparison]::Ordinal)) 'PATH no recibió el destino exacto'

    $normalizedPath = @{ Value = ([IO.Path]::GetFullPath($install).ToUpperInvariant() + '\'); Writes = 0 }
    $normalizedRun = @{ Downloads = [Collections.Generic.List[string]]::new(); WorkDirectory = '' }
    Invoke-FixtureInstall $fixture $install $normalizedPath $normalizedRun
    Assert-True ($normalizedPath.Writes -eq 0) 'PATH duplicó una ruta equivalente'

    $oldHash = (Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash
    [IO.File]::WriteAllBytes($archive, [byte[]]@(1, 2, 3))
    $failedRun = @{ Downloads = [Collections.Generic.List[string]]::new(); WorkDirectory = '' }
    Assert-Throws { Invoke-FixtureInstall $fixture $install $pathState $failedRun } 'un ZIP corrupto fue aceptado'
    Assert-True ((Get-FileHash $installed -Algorithm SHA256).Hash -ceq $oldHash) 'el fallo alteró el ejecutable anterior'
    Assert-True (-not [IO.Directory]::Exists($failedRun.WorkDirectory)) 'un fallo dejó el directorio temporal'

    $symlinkAttributes = [BitConverter]::ToInt32([BitConverter]::GetBytes([uint32]0xA1FF0000), 0)
    $cases = @(
        @{ Name = 'traversal'; Entries = @(
            @{ Name = 'LICENSE'; Bytes = [Text.Encoding]::UTF8.GetBytes('license'); Attributes = $null },
            @{ Name = 'NOTICE'; Bytes = [Text.Encoding]::UTF8.GetBytes('notice'); Attributes = $null },
            @{ Name = 'THIRD_PARTY_NOTICES'; Bytes = [Text.Encoding]::UTF8.GetBytes('third'); Attributes = $null },
            @{ Name = '../openjornada-terminal.exe'; Source = $fixtureExecutable; Attributes = $null }) },
        @{ Name = 'symlink'; Entries = @(
            @{ Name = 'LICENSE'; Bytes = [Text.Encoding]::UTF8.GetBytes('license'); Attributes = $null },
            @{ Name = 'NOTICE'; Bytes = [Text.Encoding]::UTF8.GetBytes('notice'); Attributes = $null },
            @{ Name = 'THIRD_PARTY_NOTICES'; Bytes = [Text.Encoding]::UTF8.GetBytes('third'); Attributes = $null },
            @{ Name = 'openjornada-terminal.exe'; Bytes = [Text.Encoding]::UTF8.GetBytes('target'); Attributes = $symlinkAttributes }) },
        @{ Name = 'duplicate'; Entries = @(
            @{ Name = 'LICENSE'; Bytes = [Text.Encoding]::UTF8.GetBytes('license'); Attributes = $null },
            @{ Name = 'NOTICE'; Bytes = [Text.Encoding]::UTF8.GetBytes('notice'); Attributes = $null },
            @{ Name = 'openjornada-terminal.exe'; Source = $fixtureExecutable; Attributes = $null },
            @{ Name = 'openjornada-terminal.exe'; Source = $fixtureExecutable; Attributes = $null }) },
        @{ Name = 'extra'; Entries = @(
            @{ Name = 'LICENSE'; Bytes = [Text.Encoding]::UTF8.GetBytes('license'); Attributes = $null },
            @{ Name = 'NOTICE'; Bytes = [Text.Encoding]::UTF8.GetBytes('notice'); Attributes = $null },
            @{ Name = 'THIRD_PARTY_NOTICES'; Bytes = [Text.Encoding]::UTF8.GetBytes('third'); Attributes = $null },
            @{ Name = 'openjornada-terminal.exe'; Source = $fixtureExecutable; Attributes = $null },
            @{ Name = 'EXTRA'; Bytes = [Text.Encoding]::UTF8.GetBytes('extra'); Attributes = $null }) },
        @{ Name = 'missing'; Entries = @(
            @{ Name = 'LICENSE'; Bytes = [Text.Encoding]::UTF8.GetBytes('license'); Attributes = $null },
            @{ Name = 'THIRD_PARTY_NOTICES'; Bytes = [Text.Encoding]::UTF8.GetBytes('third'); Attributes = $null },
            @{ Name = 'openjornada-terminal.exe'; Source = $fixtureExecutable; Attributes = $null }) },
        @{ Name = 'zero'; Entries = @(
            @{ Name = 'LICENSE'; Bytes = [Text.Encoding]::UTF8.GetBytes('license'); Attributes = $null },
            @{ Name = 'NOTICE'; Bytes = [byte[]]@(); Attributes = $null },
            @{ Name = 'THIRD_PARTY_NOTICES'; Bytes = [Text.Encoding]::UTF8.GetBytes('third'); Attributes = $null },
            @{ Name = 'openjornada-terminal.exe'; Source = $fixtureExecutable; Attributes = $null }) },
        @{ Name = 'cap'; Entries = @(
            @{ Name = 'LICENSE'; Bytes = [byte[]]::new(5MB + 1); Attributes = $null },
            @{ Name = 'NOTICE'; Bytes = [Text.Encoding]::UTF8.GetBytes('notice'); Attributes = $null },
            @{ Name = 'THIRD_PARTY_NOTICES'; Bytes = [Text.Encoding]::UTF8.GetBytes('third'); Attributes = $null },
            @{ Name = 'openjornada-terminal.exe'; Source = $fixtureExecutable; Attributes = $null }) }
    )
    foreach ($case in $cases) {
        New-FixtureZip $archive $case.Entries
        Write-ChecksumInventory $fixture $archiveName
        $caseRun = @{ Downloads = [Collections.Generic.List[string]]::new(); WorkDirectory = '' }
        Assert-Throws { Invoke-FixtureInstall $fixture $install $pathState $caseRun } "el ZIP $($case.Name) fue aceptado"
        Assert-True ((Get-FileHash $installed -Algorithm SHA256).Hash -ceq $oldHash) "el ZIP $($case.Name) alteró el ejecutable"
    }

    New-FixtureZip $archive (Get-ValidEntries $fixtureExecutable)
    Write-ChecksumInventory $fixture $archiveName
    [IO.File]::AppendAllText([IO.Path]::Combine($fixture, 'checksums.txt'), "not-canonical`n")
    $badInventoryRun = @{ Downloads = [Collections.Generic.List[string]]::new(); WorkDirectory = '' }
    Assert-Throws { Invoke-FixtureInstall $fixture $install $pathState $badInventoryRun } 'un inventario no canónico fue aceptado'
    Assert-True ((Get-FileHash $installed -Algorithm SHA256).Hash -ceq $oldHash) 'el inventario alteró el ejecutable'

    Write-Host 'test_install_ps1.ps1: OK'
}
finally {
    if ([IO.Directory]::Exists($testRoot)) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
