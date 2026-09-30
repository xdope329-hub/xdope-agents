@echo off
rem Punto de entrada de las tareas programadas: corre el pipeline desde la raíz del repo y guarda el log.
cd /d "%~dp0.."
if not exist logs mkdir logs
echo [%date% %time%] pipeline %* >> logs\scheduler.log
call npm run pipeline -- %* >> logs\scheduler.log 2>&1
