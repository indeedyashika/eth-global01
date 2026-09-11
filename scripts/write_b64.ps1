param($target, $b64)
$dir = [System.IO.Path]::GetDirectoryName($target)
if ($dir -and -not (Test-Path $dir)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
}
[System.IO.File]::WriteAllBytes($target, [System.Convert]::FromBase64String($b64))
Write-Host  Wrote $target successfully.