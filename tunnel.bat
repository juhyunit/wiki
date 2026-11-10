@echo off
chcp 65001 > nul
title wikiLink 외부 접속(Cloudflare 임시 터널)
REM 사전 준비: cloudflared 설치  →  명령 프롬프트에서  winget install --id Cloudflare.cloudflared
REM start.bat으로 서버를 먼저 켠 뒤 이 파일을 실행하세요.
REM 화면에 나오는 https://xxxx.trycloudflare.com 주소를 공유하면 됩니다(창을 닫으면 주소가 사라짐).
REM 주의: 회사 보안 정책상 사내 PC를 외부에 여는 것이 허용되는지 먼저 확인하세요. 예시(가상) 데이터로만 쓰세요.

where cloudflared >nul 2>nul
if errorlevel 1 (
  echo [오류] cloudflared가 없습니다. 명령 프롬프트에서 다음을 실행해 설치하세요:
  echo        winget install --id Cloudflare.cloudflared
  pause
  exit /b 1
)
cloudflared tunnel --url http://localhost:8000
pause
