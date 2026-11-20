' Run the bot in the background (no window). Auto-updates and restarts on crash.
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.Run "cmd /c """ & dir & "\start-auto.bat""", 0, False
