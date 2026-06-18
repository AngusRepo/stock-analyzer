param([string]$PythonExe, [string]$Repo, [string]$OutFile, [string]$ErrFile, [string]$ExitFile, [string]$DoneFile, [string[]]$ArgsList)
$env:PYTHONIOENCODING = "utf-8"
Set-Location $Repo
& $PythonExe @ArgsList > $OutFile 2> $ErrFile
$code = $LASTEXITCODE
Set-Content -Path $ExitFile -Value $code -Encoding UTF8
Set-Content -Path $DoneFile -Value (Get-Date).ToString("o") -Encoding UTF8
exit $code
