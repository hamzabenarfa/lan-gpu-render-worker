@echo off
cd /d "%~dp0"
echo Starting LAN GPU Render Worker...
echo Keep this window open and stay signed into Windows while rendering.
node worker.mjs
pause
