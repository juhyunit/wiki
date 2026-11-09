#!/usr/bin/env bash
# macOS / Linux 실행 스크립트
set -e
cd "$(dirname "$0")/backend"
PY=${PYTHON:-python3}
if [ ! -x ".venv/bin/python" ]; then
  echo "처음 실행: 가상환경을 만들고 필요한 패키지를 설치합니다."
  $PY -m venv .venv
fi
source .venv/bin/activate
python -m pip install -q --disable-pip-version-check -r requirements.txt
python -m app
