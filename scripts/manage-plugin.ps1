param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('install', 'uninstall')]
    [string]$Action,
    [string]$PluginsDirectory = (Join-Path $env:USERPROFILE '.gemini\config\plugins')
)

$ErrorActionPreference = 'Stop'

function Set-InstalledSidecarCommand([string]$manifestPath) {
    try {
        $wrapper = Get-Content -LiteralPath (Join-Path $env:APPDATA 'Antigravity\bin\agy-node.cmd') -Encoding UTF8 -Raw
    } catch {
        return
    }
    if ($wrapper -notmatch '(?im)^[ \t]*"(?<exe>(?:[a-z]:\\|\\\\)[^"\r\n]*\\Antigravity\.exe)"[ \t]+%\*[ \t]*\r?$') {
        return
    }
    $exe = $Matches.exe
    if ($exe -notmatch '[^\x00-\x7f]') { return }
    if (-not [IO.File]::Exists($exe)) { return }

    $loader = Join-Path $env:USERPROFILE '.gemini\antigravity\lib\node_modules\sidecar_sdk\register_loader.js'
    if (-not [IO.File]::Exists($loader)) { return }

    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $manifest.command = $exe
    $manifest.args = @("--import=$(([uri]$loader).AbsoluteUri)") + $manifest.args
    if (-not $manifest.env) { $manifest | Add-Member -NotePropertyName env -NotePropertyValue ([pscustomobject]@{}) }
    $manifest.env | Add-Member -NotePropertyName ELECTRON_RUN_AS_NODE -NotePropertyValue '1' -Force
    [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 20) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}

$pluginName = 'agy-cache-helper'
$pluginRoot = [IO.Path]::GetFullPath($PluginsDirectory).TrimEnd('\', '/')
$destination = [IO.Path]::GetFullPath((Join-Path $pluginRoot $pluginName))

if ((Split-Path -Parent $destination) -ne $pluginRoot -or (Split-Path -Leaf $destination) -ne $pluginName) {
    throw "Invalid plugin destination: $destination"
}
if ((Test-Path -LiteralPath $destination) -and ((Get-Item -LiteralPath $destination -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "Plugin destination is a link. Remove it manually first: $destination"
}

if ($Action -eq 'uninstall') {
    if (Test-Path -LiteralPath $destination) {
        Remove-Item -LiteralPath $destination -Recurse -Force
        Write-Host "Removed $pluginName from $destination (settings preserved)."
    } else {
        Write-Host "Not installed: $destination"
    }
    exit 0
}

$source = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\agy-cache-helper')).Path
if (-not (Test-Path -LiteralPath (Join-Path $source 'plugin.json'))) {
    throw "Source plugin manifest missing: $source\plugin.json"
}
if ($source -eq $destination) { throw 'Source and destination must be different directories.' }

New-Item -ItemType Directory -Path $destination -Force | Out-Null
$marker = Join-Path $destination '.update-in-progress'
Set-Content -LiteralPath $marker -Value "Updating $pluginName" -Encoding ASCII
try {
    & robocopy.exe $source $destination /MIR /XJ /XF .update-in-progress /NFL /NDL /NJH /NJS /NP /R:2 /W:1
    if ($LASTEXITCODE -ge 8) { throw "Plugin copy failed (robocopy exit code $LASTEXITCODE)." }
    Set-InstalledSidecarCommand (Join-Path $destination 'sidecars\cache_helper\sidecar.json')
} finally {
    Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
}

Write-Host "Installed/updated $pluginName at $destination"
Write-Host "Enable '$pluginName' in Antigravity Plugins panel (first install only)."
exit 0
