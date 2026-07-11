@echo off
cd /d "C:\Users\jihad\Desktop\open art\apiOpenArt"
start /B node index.js > server.log 2>&1
start /B node src\v2\queue\v2WorkflowWorker.js > worker.log 2>&1
timeout /t 5 /nobreak > nul
echo Server and worker started
