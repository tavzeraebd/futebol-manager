@echo off
cd /d "%~dp0"
echo Servidor em http://localhost:3210  (feche esta janela para parar)
start "" http://localhost:3210
node server\server.js
pause
