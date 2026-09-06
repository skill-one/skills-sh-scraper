<#
.SYNOPSIS
    Configure the current PowerShell session to route local agent clients
    through the running EvoMap Proxy.

.DESCRIPTION
    Reads the proxy endpoint and token from the local settings file written by
    EVOMAP_PROXY=1. By default this script updates only the current PowerShell
    process environment and does not print the proxy token.

.EXAMPLE
    .\scripts\internal-proxy-env.ps1

.EXAMPLE
    .\scripts\internal-proxy-env.ps1 -Status

.EXAMPLE
    .\scripts\internal-proxy-env.ps1 -PrintSensitiveEnv | Invoke-Expression
#>

[CmdletBinding()]
param(
    [string]$Settings,
    [switch]$Status,
    [switch]$PrintSensitiveEnv
)

$ErrorActionPreference = 'Stop'

function Resolve-SettingsFile {
    if ($Settings) { return $Settings }
    if ($env:EVOLVER_SETTINGS_FILE) { return $env:EVOLVER_SETTINGS_FILE }
    if ($env:EVOLVER_SETTINGS_DIR) {
        return (Join-Path $env:EVOLVER_SETTINGS_DIR 'settings.json')
    }
    $homeDir = if ($env:USERPROFILE) {
        $env:USERPROFILE
    } elseif ($env:HOME) {
        $env:HOME
    } else {
        [Environment]::GetFolderPath('UserProfile')
    }
    return (Join-Path (Join-Path $homeDir '.evolver') 'settings.json')
}

function Quote-PowerShell {
    param([string]$Value)
    return "'" + $Value.Replace("'", "''") + "'"
}

function Test-NonEmptyString {
    param([object]$Value)
    return ($Value -is [string]) -and (-not [string]::IsNullOrWhiteSpace($Value))
}

function Warn-ExistingAnthropicApiKey {
    if (Test-NonEmptyString $env:ANTHROPIC_API_KEY) {
        Write-Warning 'ANTHROPIC_API_KEY is already set in this PowerShell session; this helper does not overwrite it. Clear it first if your client gives ANTHROPIC_API_KEY precedence over ANTHROPIC_AUTH_TOKEN.'
    }
}

$settingsFile = Resolve-SettingsFile

try {
    $parsed = Get-Content -LiteralPath $settingsFile -Raw | ConvertFrom-Json
} catch {
    Write-Error "cannot read proxy settings at $settingsFile; start evolver with EVOMAP_PROXY=1 first"
    exit 1
}

$proxy = $parsed.proxy
if (($null -eq $proxy) -or -not (Test-NonEmptyString $proxy.url) -or -not (Test-NonEmptyString $proxy.token)) {
    Write-Error "no active string proxy.url/proxy.token found in $settingsFile; start evolver with EVOMAP_PROXY=1 first"
    exit 1
}

$proxyUrl = $proxy.url
$proxyToken = $proxy.token

if ($Status) {
    Write-Output "proxy_url=$proxyUrl"
    if ($null -ne $proxy.pid) { Write-Output "proxy_pid=$($proxy.pid)" }
    if ($proxy.started_at) { Write-Output "proxy_started_at=$($proxy.started_at)" }
    exit 0
}

Warn-ExistingAnthropicApiKey

if ($PrintSensitiveEnv) {
    Write-Output "`$env:ANTHROPIC_BASE_URL = $(Quote-PowerShell $proxyUrl)"
    Write-Output "`$env:ANTHROPIC_AUTH_TOKEN = $(Quote-PowerShell $proxyToken)"
    Write-Output "`$env:CUSTOM_API_KEY = $(Quote-PowerShell $proxyToken)"
    Write-Output "`$env:EVOMAP_PROXY_URL = $(Quote-PowerShell $proxyUrl)"
    exit 0
}

$env:ANTHROPIC_BASE_URL = $proxyUrl
$env:ANTHROPIC_AUTH_TOKEN = $proxyToken
$env:CUSTOM_API_KEY = $proxyToken
$env:EVOMAP_PROXY_URL = $proxyUrl

Write-Host "EvoMap Proxy environment applied for this PowerShell session: $proxyUrl"
