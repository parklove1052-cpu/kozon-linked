@echo off
rem Work Chrome for the password bot: CDP port 9888, own profile in data\chrome_profile.
rem Log in to sites here by hand (or with the password bot).
set PORT=9888
set CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe
if not exist "%CHROME%" set CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe
start "" "%CHROME%" --remote-debugging-port=%PORT% --user-data-dir="%~dp0..\data\chrome_profile" --no-first-run --no-default-browser-check
