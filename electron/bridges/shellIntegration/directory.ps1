# Session-only integration honors the current execution policy and preserves
# user-managed profile, registry and PSReadLine settings.
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { return }
if (Test-Path variable:global:__NetcattyDirectory) { return }
if (-not $env:NETCATTY_DIRECTORY_NONCE) { return }

$global:__NetcattyDirectory = @{
    OriginalPrompt = $function:prompt
    Nonce = $env:NETCATTY_DIRECTORY_NONCE
    Sequence = 0
}
$env:NETCATTY_DIRECTORY_NONCE = $null

function global:prompt {
    $netcattyFailed = -not $global:?
    Set-StrictMode -Off
    $netcattyExitCode = $global:LASTEXITCODE
    $netcattyReport = ''
    try {
        $global:__NetcattyDirectory.Sequence++
        $netcattyLocation = $ExecutionContext.SessionState.Path.CurrentLocation
        $netcattyPath = $null
        if ($netcattyLocation.Provider.Name -eq 'FileSystem') {
            $netcattyPath = $netcattyLocation.ProviderPath
        }
        $netcattyState = @{
            version = 1
            nonce = $global:__NetcattyDirectory.Nonce
            pid = $PID
            sequence = $global:__NetcattyDirectory.Sequence
            provider = $netcattyLocation.Provider.Name
            cwd = $netcattyPath
            home = $HOME
        } | Microsoft.PowerShell.Utility\ConvertTo-Json -Compress
        $netcattyEncoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($netcattyState))
        $netcattyReport = "$([char]27)]633;P;NetcattyDirectory=$netcattyEncoded$([char]7)"
    } catch {
        # Prompt remains usable if reporting fails.
    }
    $global:LASTEXITCODE = $netcattyExitCode
    # Restore the status seen by the original prompt (also on PowerShell 5.1).
    if ($netcattyFailed) { Microsoft.PowerShell.Utility\Write-Error 'failure' -ErrorAction Ignore }
    $netcattyPrompt = $global:__NetcattyDirectory.OriginalPrompt.Invoke()
    $global:LASTEXITCODE = $netcattyExitCode
    return $netcattyReport + ($netcattyPrompt -join '')
}
