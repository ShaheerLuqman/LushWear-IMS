Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptPath = fso.GetParentFolderName(WScript.ScriptFullName)
batFile = scriptPath & "\start-app.bat"
WshShell.Run "cmd /c """ & batFile & """ hidden", 0, False
Set WshShell = Nothing
Set fso = Nothing

