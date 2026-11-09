@echo off
chcp 65001 > nul
title WorkWiki
cd /d "%~dp0backend"

where python >nul 2>nul
if errorlevel 1 (
  echo [오류] Python이 없습니다. https://www.python.org/downloads/ 에서 3.10 이상을 설치하고
  echo        설치 첫 화면의 "Add python.exe to PATH"를 체크하세요.
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo 처음 실행: 가상환경을 만들고 필요한 패키지를 설치합니다. 1~2분 걸립니다.
  python -m venv .venv
)
call ".venv\Scripts\activate.bat"
python -m pip install -q --disable-pip-version-check -r requirements.txt
if errorlevel 1 (
  echo [오류] 패키지 설치에 실패했습니다. 인터넷 연결 또는 사내 프록시 설정을 확인하세요.
  pause
  exit /b 1
)

echo.
echo 다른 PC에서 접속이 안 되면 Windows 방화벽 창에서 "개인 네트워크 허용"을 눌러 주세요.
echo.
python -m app
pause
