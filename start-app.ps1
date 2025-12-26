$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$batFile = Join-Path $scriptPath "start-app.bat"
Start-Process -FilePath $batFile -WindowStyle Hidden

