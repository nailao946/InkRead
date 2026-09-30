@echo off
rem ============================================================
rem  InkRead local server: static files + translation API proxy
rem  (The proxy lets the web version use Youdao / Baidu official APIs,
rem   which the browser blocks by CORS when fetched directly.)
rem  Usage: double click this file. Close the window to stop.
rem ============================================================
cd /d "%~dp0"
set PORT=8642

where py >nul 2>nul && (py "tools\serve.py" %PORT% & goto :eof)
where python >nul 2>nul && (python "tools\serve.py" %PORT% & goto :eof)
where python3 >nul 2>nul && (python3 "tools\serve.py" %PORT% & goto :eof)

echo [!] Python was not found on this computer.
echo     Official translation APIs (Youdao / Baidu) need this local proxy server.
echo     Option 1: install Python 3, then run this file again.
echo     Option 2: use the desktop app: wpf\bin\Release\net8.0-windows\InkRead.exe
echo     (Without the proxy the web version can still use the built-in free engine MyMemory.)
echo.
echo     PS: A plain static server also works for reading, e.g.:
echo         python -m http.server 8642
pause
