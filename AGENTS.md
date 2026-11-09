# WorkWiki 개발 규칙 (AI 코딩 도구용, 기획서 13.3 기반)

## 스택
- 화면: React + TypeScript + Vite / TipTap OSS(@tiptap/*만) / lucide-react
- 서버: FastAPI + SQLite(프로토타입) → 운영은 PostgreSQL + pg_trgm(asyncpg)
## 금지
- @tiptap-pro, Tiptap Cloud, MinIO, pyhwp, pyhwpxlib, PyMuPDF, psycopg, ldap3, Redis, Java 의존 패키지
- 외부 CDN·API·웹폰트(폰트는 웹폰트 없이 시스템 글꼴 스택 사용), 사람 단위 권한(ACL) 테이블
- 허용 라이선스(MIT, BSD, Apache-2.0, ISC, PostgreSQL, PSF, OFL) 밖 패키지 추가
- 테스트를 고쳐서 통과시키기, 권한 검사 생략, 클라이언트가 보낸 HTML 저장
## 필수
- 모든 매뉴얼·첨부 API는 app/policy.py의 can() 호출
- 새 API마다 권한 없는 역할의 403 테스트를 tests/test_api.py에 추가
- 게시된 버전·감사 로그는 수정·삭제하지 않음(DB 트리거 유지)
- 인사 동기화는 삭제 없이 비활성화만, 5% 초과 비활성화는 중단
- 데모 어댑터(frontend/src/api/demo.ts)는 서버 규칙과 같게 유지
- 글자 서식(색·글꼴·크기) 허용 목록은 backend/app/render.py와 frontend/src/editor/textStyle.ts를 함께 고친다
- 부서 코드는 4자리 숫자(1000~9999), 문서 번호는 "부서코드-일련번호"
- AI 질의응답은 can(view_published)를 통과한 공식본 근거 문단만 모델에 넘긴다. 모델 서버는 이 PC·사내망 주소만(외부 API 금지), 모델 출력은 HTML로 넣지 않는다
- 추천 모델·패키지는 허용 라이선스만(Qwen3 Apache-2.0, BGE-M3 MIT 등). EXAONE·Llama·Gemma 같은 별도 약관 모델은 기본값으로 넣지 않는다
- 근거 문단·링크 규칙은 backend/app/chunks.py와 frontend/src/lib/knowledge.ts, 내려받기 구성은 backend/app/exporters.py와 frontend/src/lib/exporters.ts를 함께 고친다
## 디자인
- 색은 frontend/src/styles.css의 토큰만 쓴다: Primary #263B63(주요 버튼·선택 메뉴·제목), Primary Light #E9EFF8, Accent #D97736(즐겨찾기·중요·선택적 강조만), Background #F7F8FA, Surface #FFF, Border #E1E5EB, Text #202B3C, Muted #758196
- 그라데이션 배경·글래스모피즘·장식용 아이콘·배지·과한 그림자 금지, 모서리 4px
## 검증
cd backend && python -m pytest -q ; cd ../frontend && npx tsc --noEmit && npm run build
