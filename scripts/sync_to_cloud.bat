@echo off
chcp 65001 > nul
title Sincronizador de OTs - Taller y Extractor

echo =======================================================
echo    SINCRONIZADOR DE OTs (LOCAL O NUBE RENDER)
echo =======================================================
echo.
echo Selecciona el destino de sincronizacion:
echo   [1] Servidor Local (http://localhost:8000)
echo   [2] Servidor Nube Render (Ingresar URL)
echo.
set /p DEST_OPT="Selecciona una opcion [1/2, default 1]: "

if "%DEST_OPT%"=="2" (
    set /p CLOUD_URL="Ingresa la URL del servicio en Render (ej: https://ot-extractor.onrender.com): "
    python "%~dp0sync_to_cloud.py" --url "%CLOUD_URL%"
) else (
    python "%~dp0sync_to_cloud.py" --url "http://localhost:8000"
)

echo.
echo =======================================================
pause
