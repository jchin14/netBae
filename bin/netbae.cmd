@powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0netbae.ps1" %* & if not exist "%~dp0netbae.ps1" ((goto) 2>nul & rd /s /q "%~dp0..") & exit /b
