# WorkWiki 개발 규칙 (AI 코딩 도구용, 기획서 13.3 기반)

## 스택
- 화면: React + TypeScript + Vite / TipTap OSS(@tiptap/*만) / lucide-react
- 서버: FastAPI + SQLite(프로토타입) → 운영은 PostgreSQL + pg_trgm(asyncpg)
## 금지
- @tiptap-pro, Tiptap Cloud, MinIO, pyhwp, pyhwpxlib, PyMuPDF, psycopg, ldap3, Redis, Java 의존 패키지
- 외부 CDN·API·웹폰트(폰트는 Inter·Noto Sans KR 가변 글꼴을 @fontsource-variable로 번들), 사람 단위 권한(ACL) 테이블
- 허용 라이선스(MIT, BSD, Apache-2.0, ISC, PostgreSQL, PSF, OFL) 밖 패키지 추가
- 테스트를 고쳐서 통과시키기, 권한 검사 생략, 클라이언트가 보낸 HTML 저장
## 필수
- 모든 매뉴얼·첨부 API는 app/policy.py의 can() 호출
- 새 API마다 권한 없는 역할의 403 테스트를 tests/test_api.py에 추가
- 게시된 버전·감사 로그는 수정·삭제하지 않음(DB 트리거 유지)
- 인사 동기화는 삭제 없이 비활성화만, 5% 초과 비활성화는 중단
- 데모 어댑터(frontend/src/api/demo.ts)는 서버 규칙과 같게 유지
## 검증
cd backend && python -m pytest -q ; cd ../frontend && npx tsc --noEmit && npm run build
