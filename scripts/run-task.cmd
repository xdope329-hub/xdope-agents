@echo off
rem Punto de entrada de las tareas programadas de Windows: corre un script de npm desde la raiz del repo y guarda el log.
cd /d "%~dp0.."
if not exist logs mkdir logs
echo [%date% %time%] %* >> logs\scheduler.log
call npm run %* >> logs\scheduler.log 2>&1
