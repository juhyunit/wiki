"""예시 데이터(가짜 데이터). 기획서 13.2: 실제 매뉴얼·인사 데이터는 넣지 않는다."""
from __future__ import annotations

import json
import os
import re
from datetime import datetime, timedelta

from . import services as S
from .policy import load_user


# ---------- 본문 작성 도우미 ----------
def _inline(s: str) -> list:
    """**굵게**와 [[글자|매뉴얼번호]](문서 링크) 표기를 편집기 마크로 바꾼다."""
    out = []
    bold = False
    for part in re.split(r"(\*\*|\[\[[^\]]+\]\])", s):
        if not part:
            continue
        if part == "**":
            bold = not bold
            continue
        marks = [{"type": "bold"}] if bold else []
        lk = re.fullmatch(r"\[\[([^|\]]+)\|(\d+)\]\]", part)
        if lk:
            part = lk.group(1)
            marks.append({"type": "link", "attrs": {"href": f"#/m/{lk.group(2)}"}})
        node = {"type": "text", "text": part}
        if marks:
            node["marks"] = marks
        out.append(node)
    return out


def P(s=""):
    n = {"type": "paragraph"}
    if s:
        n["content"] = _inline(s)
    return n


def H(level, s):
    return {"type": "heading", "attrs": {"level": level}, "content": _inline(s)}


def _li(item):
    blocks = item if isinstance(item, list) else [P(item)]
    return {"type": "listItem", "content": blocks}


def UL(*items):
    return {"type": "bulletList", "content": [_li(i) for i in items]}


def OL(*items):
    return {"type": "orderedList", "attrs": {"start": 1}, "content": [_li(i) for i in items]}


def TASK(*items):
    return {"type": "taskList", "content": [
        {"type": "taskItem", "attrs": {"checked": bool(c)}, "content": [P(t)]} for c, t in items]}


def TABLE(rows, header=True):
    out = []
    for ri, row in enumerate(rows):
        cells = []
        for c in row:
            cells.append({"type": "tableHeader" if header and ri == 0 else "tableCell",
                          "attrs": {"colspan": 1, "rowspan": 1, "colwidth": None}, "content": [P(c)]})
        out.append({"type": "tableRow", "content": cells})
    return {"type": "table", "content": out}


def CALLOUT(kind, *blocks):
    return {"type": "callout", "attrs": {"type": kind},
            "content": [P(b) if isinstance(b, str) else b for b in blocks]}


def DOC(*blocks):
    return {"type": "doc", "content": list(blocks)}


# ---------- 템플릿(기획서 7.1) ----------
TEMPLATE_BASIC = DOC(
    H(2, "1. 목적"), P("이 매뉴얼이 다루는 업무와 목적을 한두 문장으로 적습니다."),
    H(2, "2. 적용 범위"), P("적용 대상 부서·업무·시스템을 적습니다."),
    H(2, "3. 담당"), TABLE([["역할", "담당", "비고"], ["주담당", "", ""], ["부담당", "", ""]]),
    H(2, "4. 처리 절차"), OL("첫 번째 단계", "두 번째 단계", "세 번째 단계"),
    H(2, "5. 주의사항"), CALLOUT("warning", "실수하기 쉬운 부분을 적습니다."),
    H(2, "6. 관련 규정"), UL("관련 규정·지침 이름"),
    H(2, "7. 문의처"), P("담당 부서와 내선번호를 적습니다."),
)
TEMPLATE_CHECK = DOC(
    H(2, "개요"), P("이 체크리스트를 언제, 누가 사용하는지 적습니다."),
    H(2, "사전 준비"), TASK((0, "준비 항목 1"), (0, "준비 항목 2")),
    H(2, "진행 중 확인"), TASK((0, "확인 항목 1"), (0, "확인 항목 2")),
    H(2, "완료 후 확인"), TASK((0, "완료 항목 1")),
    CALLOUT("info", "체크리스트 항목이 바뀌면 '절차 변경' 사유로 저장하세요."),
)
TEMPLATE_EMPTY = DOC(P())


# ---------- 매뉴얼 본문 ----------
LEAVE_V1 = DOC(
    H(2, "1. 목적"),
    P("직원의 연차휴가 신청부터 승인, 근태 반영까지의 처리 기준을 정한다."),
    H(2, "2. 적용 범위"),
    P("정규직·계약직 전 직원. 단, 파견 인력은 소속 회사 기준을 따른다."),
    H(2, "3. 신청 절차"),
    OL("인사시스템 > 근태 > 휴가신청 메뉴에서 휴가 종류와 기간을 입력한다.",
       "사유를 적고 결재선(팀장)을 확인한 뒤 신청한다.",
       "팀장이 승인하면 근태에 자동 반영된다."),
    H(2, "4. 주의사항"),
    CALLOUT("warning", "휴가 시작일 **3영업일 전**까지 신청해야 한다."),
    H(2, "5. 문의처"),
    P("인사부 근태 담당(내선 2041)"),
)

LEAVE_V2 = DOC(
    H(2, "1. 목적"),
    P("직원의 연차휴가 신청부터 승인, 근태 반영까지의 처리 기준을 정한다."),
    H(2, "2. 적용 범위"),
    P("정규직·계약직 전 직원. 단, 파견 인력은 소속 회사 기준을 따른다."),
    H(2, "3. 휴가 종류"),
    TABLE([["구분", "단위", "비고"],
           ["연차", "1일", "근속 연수에 따라 15~25일"],
           ["반차", "0.5일", "오전 09~14시 / 오후 14~18시"],
           ["반반차", "0.25일", "2시간 단위, 월 4회까지"]]),
    H(2, "4. 신청 절차"),
    OL("인사시스템 > 근태 > 휴가신청 메뉴에서 휴가 종류와 기간을 입력한다.",
       "사유를 적고 결재선(팀장)을 확인한 뒤 신청한다.",
       "팀장이 승인하면 근태에 자동 반영된다."),
    H(2, "5. 주의사항"),
    CALLOUT("warning", "휴가 시작일 **3영업일 전**까지 신청해야 한다."),
    H(2, "6. 문의처"),
    P("인사부 근태 담당(내선 2041)"),
)

LEAVE_V3 = DOC(
    H(2, "1. 목적"),
    P("직원의 연차휴가 신청부터 승인, 근태 반영까지의 처리 기준을 정한다."),
    H(2, "2. 적용 범위"),
    P("정규직·계약직 전 직원. 단, 파견 인력은 소속 회사 기준을 따른다."),
    H(2, "3. 휴가 종류"),
    TABLE([["구분", "단위", "비고"],
           ["연차", "1일", "근속 연수에 따라 15~25일"],
           ["반차", "0.5일", "오전 09~14시 / 오후 14~18시"],
           ["반반차", "0.25일", "2시간 단위, 월 4회까지"]]),
    H(2, "4. 신청 절차"),
    OL("인사시스템 > 근태 > 휴가신청 메뉴에서 휴가 종류와 기간을 입력한다.",
       "사유를 적고 결재선을 확인한다. **3일 이상 연속 휴가는 부서장까지** 결재한다.",
       "결재가 끝나면 근태에 자동 반영되고, 신청자에게 알림이 간다.",
       "업무 대행자를 지정하고 인수인계 메모를 남긴다."),
    H(3, "4.1 긴급 휴가"),
    P("질병·경조사 등 사전 신청이 어려우면 당일 오전 9시 전까지 팀장에게 유선 보고하고, 복귀 후 2영업일 안에 사후 신청한다."),
    H(2, "5. 주의사항"),
    CALLOUT("warning", "휴가 시작일 **3영업일 전**까지 신청해야 한다."),
    CALLOUT("danger", "결산·감사 기간(분기 말 5영업일)에는 부서장 사전 승인 없이 휴가를 쓸 수 없다."),
    H(2, "6. 관련 규정"),
    UL("취업규칙 제32조(연차유급휴가)", "근태관리지침 제5조"),
    H(2, "7. 문의처"),
    P("인사부 근태 담당(내선 2041)"),
)

LEAVE_V4 = json.loads(json.dumps(LEAVE_V3))
LEAVE_V4["content"][7]["content"][1]["content"][0]["content"] = _inline(
    "사유를 적고 결재선을 확인한다. **3일 이상 연속 휴가는 부서장까지**, 5일 이상은 본부장까지 결재한다.")
LEAVE_V4["content"].insert(8, CALLOUT("info", "남은 연차는 인사시스템 > 근태 > 휴가현황에서 실시간으로 확인할 수 있다."))

ONBOARDING = DOC(
    H(2, "개요"),
    P("신규 입사자가 첫 출근부터 2주 동안 거쳐야 할 준비 항목이다. 소속 부서 담당자와 인사부가 함께 확인한다."),
    H(2, "입사 전(인사부)"),
    TASK((1, "근로계약서 서명 및 보관"), (1, "사번 발급 및 인사시스템 등록"), (0, "보안서약서·개인정보 동의서 수령")),
    H(2, "첫 출근일(소속 부서)"),
    TASK((0, "자리·업무용 PC 배정"), (0, "사내 메일·메신저 계정 안내"), (0, "출입카드 발급 신청(총무부)"),
         (0, "멘토 지정 및 인사")),
    H(2, "1주 차"),
    TASK((0, "필수 교육 이수: 정보보호, 개인정보보호, 내부통제"), (0, "부서 업무 매뉴얼 열람(wikiLink 즐겨찾기 등록)"),
         (0, "업무 시스템 권한 신청"), (0, "업무용 PC 보안 점검([[업무용 PC 보안 점검 가이드|10]])")),
    H(2, "2주 차"),
    TASK((0, "멘토 면담 1회"), (0, "수습 평가 일정 확인")),
    CALLOUT("info", "필수 교육은 입사 후 **30일 이내**에 이수해야 하며, 미이수 시 업무 시스템 권한이 제한된다."),
)

TRANSFER = DOC(
    H(2, "1. 목적"),
    P("정기·수시 인사발령의 확정부터 시스템 반영, 후속 조치까지의 처리 순서를 정한다."),
    H(2, "2. 처리 절차"),
    OL("발령안 확정: 인사위원회 결과를 발령 대장에 기록한다.",
       "발령 공고: 발령일 3영업일 전 사내 게시판에 공고한다.",
       "시스템 반영: 발령일 0시 기준으로 인사시스템 소속을 변경한다.",
       "후속 조치 요청: 총무부(좌석·출입), 정보보호부(시스템 권한)에 발령 목록을 보낸다."),
    H(2, "3. 부서별 후속 조치"),
    TABLE([["부서", "조치", "기한"],
           ["총무부", "좌석 배치, 출입권한 변경", "발령일 전일"],
           ["정보보호부", "업무 시스템 권한 회수·부여", "발령일 당일"],
           ["전입 부서", "업무 매뉴얼 담당자 재지정", "발령 후 5영업일"]]),
    CALLOUT("danger", "전출자의 **이전 부서 시스템 권한은 발령일 당일 회수**한다. 늦어지면 내부통제 지적 사항이 된다."),
    P("전입자의 첫 주 준비 항목은 [[신규 입사자 온보딩 체크리스트|2]]를 참고한다."),
    H(2, "4. 문의처"),
    P("인사부 인사운영 담당(내선 2032)"),
)

REMOTE_DRAFT = DOC(
    H(2, "1. 목적"),
    P("재택근무 신청 대상과 절차, 보안 준수 사항을 정한다."),
    H(2, "2. 신청 대상"),
    UL("입사 1년 이상 직원", "부서장이 재택 가능 업무로 지정한 업무 담당자"),
    H(2, "3. 신청 절차"),
    OL("인사시스템 > 근태 > 재택근무 신청", "부서장 승인", "보안 점검표 제출(정보보호부)"),
    P("(작성 중)"),
)

LOAN_V1 = DOC(
    H(2, "1. 목적"),
    P("개인 신용대출 신청 건의 심사 기준과 처리 절차를 정한다."),
    H(2, "2. 심사 절차"),
    OL("서류 접수 및 본인 확인", "신용평가(CB) 조회", "소득·재직 확인", "한도·금리 산정", "심사 의견 작성 및 결재"),
    H(2, "3. 필수 서류"),
    UL("신분증", "재직증명서", "소득금액증명원 또는 근로소득 원천징수영수증"),
)

LOAN_V2 = DOC(
    H(2, "1. 목적"),
    P("개인 신용대출 신청 건의 심사 기준과 처리 절차를 정한다."),
    H(2, "2. 심사 절차"),
    OL("서류 접수 및 본인 확인", "신용평가(CB) 조회", "소득·재직 확인", "DSR 산정", "한도·금리 산정",
       "심사 의견 작성 및 결재"),
    H(2, "3. 필수 서류"),
    UL("신분증", "재직증명서", "소득금액증명원 또는 근로소득 원천징수영수증", "건강보험 자격득실확인서(재직 확인 보완용)"),
    H(2, "4. 소득 확인 기준"),
    P("모든 신청 건은 소득 증빙을 받는 것이 원칙이다. 소득 형태별로 아래 서류를 받는다."),
    TABLE([["소득 형태", "소득 증빙 서류", "비고"],
           ["근로소득자", "근로소득 원천징수영수증 또는 소득금액증명원", "재직 1년 미만은 급여명세서 3개월분 추가"],
           ["사업소득자", "소득금액증명원, 사업자등록증", "개업 1년 미만은 부가가치세 과세표준증명 추가"],
           ["연금소득자", "연금수령 내역 증명서", ""]]),
    P("자동심사 통과 건이라도 **신청 금액이 연소득의 1.5배를 넘거나 재직 기간이 1년 미만**이면 소득 증빙을 추가로 받고 심사역이 직접 확인한다."),
    H(2, "5. 전결 기준"),
    TABLE([["대출 금액", "전결권자", "비고"],
           ["3천만 원 이하", "심사역", "자동심사 통과 건"],
           ["3천만 원 초과 ~ 1억 원 이하", "심사팀장", ""],
           ["1억 원 초과", "여신심사부장", "여신위원회 보고"]]),
    CALLOUT("danger", "DSR 기준을 넘는 건은 **예외 승인 사유서**가 없으면 승인할 수 없다."),
    CALLOUT("warning", "소득 서류 발급일이 **접수일 기준 1개월 이내**인지 반드시 확인한다."),
    H(2, "6. 관련 규정"),
    UL("여신업무규정 제12조", "가계여신 심사지침", "담보가 있는 대출은 [[담보대출 감정평가 의뢰 방법|6]]을 함께 따른다"),
)

COLLATERAL = DOC(
    H(2, "1. 개요"),
    P("부동산 담보대출 취급 시 외부 감정평가법인에 감정을 의뢰하는 방법이다."),
    H(2, "2. 의뢰 절차"),
    OL("감정평가 의뢰서 작성(여신시스템 > 담보 > 감정의뢰)",
       "협약 감정평가법인 중 순번제로 배정",
       "감정 수수료 산정 및 고객 안내",
       "감정서 접수 후 담보가치 입력"),
    CALLOUT("warning", "같은 물건을 **6개월 안에 다시 감정**할 때는 기존 감정서 활용 여부를 먼저 검토한다."),
    H(2, "3. 협약 법인 연락처"),
    P("여신심사부 담보관리 담당에게 문의(내선 3115). 협약 법인 목록은 부서 공유 자료로만 관리한다."),
)

ACCOUNT_V2 = DOC(
    H(2, "1. 목적"),
    P("영업점 창구에서 입출금 예금 계좌를 새로 개설할 때의 처리 기준이다."),
    H(2, "2. 처리 절차"),
    OL("실명 확인: 신분증 진위 확인 서비스로 확인한다.",
       "금융거래 목적 확인서를 받는다.",
       "고객확인(CDD) 정보를 입력한다. 고위험 고객은 강화된 고객확인(EDD)을 한다.",
       "계좌를 개설하고 통장·체크카드를 발급한다."),
    H(2, "3. 단기간 다수 계좌 개설 제한"),
    P("최근 20영업일 안에 다른 입출금 계좌를 개설한 고객은 **한도제한계좌**로 개설한다."),
    TABLE([["구분", "한도(1일)", "해제 조건"],
           ["창구 출금", "100만 원", "금융거래 목적 증빙 제출"],
           ["전자금융 이체", "100만 원", "급여·사업 증빙 제출"]]),
    CALLOUT("danger", "대리인 개설은 **위임장·인감증명서·대리인 신분증**이 모두 있어야 한다."),
    CALLOUT("info", "휴면계좌가 있는 고객은 먼저 [[휴면계좌 해지 및 잔액 이전|8]] 절차로 잔액을 옮긴 뒤 새 계좌를 연다."),
)

ACCOUNT_V1 = DOC(
    H(2, "1. 목적"),
    P("영업점 창구에서 입출금 예금 계좌를 새로 개설할 때의 처리 기준이다."),
    H(2, "2. 처리 절차"),
    OL("실명 확인: 신분증 진위 확인 서비스로 확인한다.",
       "금융거래 목적 확인서를 받는다.",
       "계좌를 개설하고 통장·체크카드를 발급한다."),
    CALLOUT("danger", "대리인 개설은 **위임장·인감증명서·대리인 신분증**이 모두 있어야 한다."),
)

DORMANT_V1 = DOC(
    H(2, "1. 개요"),
    P("휴면계좌(최종 거래일로부터 5년 경과) 해지 요청을 처리하는 방법이다."),
    H(2, "2. 처리 절차"),
    OL("본인 확인", "휴면 해제 및 잔액 확인", "해지 또는 다른 계좌로 이전", "처리 결과 안내"),
)
DORMANT_V2 = DOC(
    H(2, "1. 개요"),
    P("휴면계좌(최종 거래일로부터 5년 경과) 해지 요청을 처리하는 방법이다."),
    H(2, "2. 처리 절차"),
    OL("본인 확인", "휴면 해제 및 잔액 확인", "해지 또는 다른 계좌로 이전", "처리 결과 안내"),
    H(2, "3. 비대면 처리"),
    P("잔액 50만 원 이하는 모바일뱅킹 '휴면예금 찾기'에서 고객이 직접 이전할 수 있다."),
    CALLOUT("info", "서민금융진흥원으로 출연된 휴면예금은 진흥원 조회 후 지급 절차를 따른다."),
)

PRIVACY_INCIDENT = DOC(
    CALLOUT("danger", "개인정보 유출을 인지하면 **즉시(30분 이내) 정보보호부 상황실(내선 7000)**에 신고한다. 자체 판단으로 조치를 미루지 않는다."),
    H(2, "1. 대응 단계"),
    OL("신고: 인지자는 즉시 정보보호부에 신고한다.",
       "초동 조치: 유출 경로 차단(계정 잠금, 메일 회수, 파일 삭제 요청).",
       "영향 분석: 유출 항목·대상자 수·경위를 파악한다.",
       "통지·신고: 정보주체 통지 및 감독기관 신고 여부를 판단한다.",
       "재발 방지: 원인 분석 보고서를 작성하고 개선 조치를 한다."),
    H(2, "2. 신고 기준"),
    TABLE([["구분", "기준", "기한"],
           ["정보주체 통지", "유출 사실을 안 때", "지체 없이(72시간 이내)"],
           ["감독기관 신고", "1천 명 이상 또는 민감정보 유출", "72시간 이내"]]),
    H(2, "3. 초동 조치 체크리스트"),
    TASK((0, "유출 파일·메일 회수 또는 삭제 요청"), (0, "관련 계정 비밀번호 변경·잠금"), (0, "접속 로그 보존(삭제 금지)"),
         (0, "대응 경과를 시간순으로 기록")),
    P("평상시 예방 점검은 [[업무용 PC 보안 점검 가이드|10]]를 따른다."),
    CALLOUT("warning", "증거 보존을 위해 **관련 PC를 끄거나 초기화하지 않는다.**"),
)

PC_SECURITY_V1 = DOC(
    H(2, "점검 항목"),
    TASK((0, "백신 최신 업데이트"), (0, "화면보호기 10분 설정"), (0, "USB 저장장치 사용 차단 확인")),
)
PC_SECURITY_V2 = DOC(
    H(2, "1. 개요"),
    P("매월 첫 영업일에 전 직원이 업무용 PC의 보안 상태를 스스로 점검한다."),
    H(2, "2. 월간 점검 항목"),
    TASK((0, "백신 엔진·패턴 최신 업데이트"), (0, "운영체제 보안 패치 적용"), (0, "화면보호기 10분·암호 설정"),
         (0, "USB 저장장치 사용 차단 확인"), (0, "공유 폴더 해제"), (0, "개인정보 파일 암호화 또는 삭제")),
    H(2, "3. 결과 제출"),
    P("보안점검 프로그램에서 자동 점검 후 결과를 제출한다. 미제출자는 부서장에게 통보된다."),
    CALLOUT("info", "점검 프로그램이 실행되지 않으면 정보보호부(내선 7012)로 문의한다."),
)

CORP_CARD = DOC(
    H(2, "1. 사용 기준"),
    UL("업무 목적 경비에만 사용한다.", "1회 50만 원 초과 시 사전 품의가 필요하다.", "주말·심야(23시~06시) 사용은 사유를 기록한다."),
    H(2, "2. 정산 절차"),
    OL("사용 후 5영업일 안에 경비시스템에서 영수증을 첨부한다.", "용도와 참석자를 입력한다.", "팀장 승인 후 총무부가 월말에 일괄 정산한다."),
    H(2, "3. 사용 제한 업종"),
    TABLE([["업종", "사용 가능 여부", "비고"],
           ["유흥·사행업종", "불가", "적발 시 개인 부담 및 징계"],
           ["상품권·귀금속", "불가", ""],
           ["골프장", "부서장 사전 승인", "고객 접대 목적만"]]),
    CALLOUT("danger", "법인카드로 **개인 경비를 결제하면 전액 환수**하고 인사 조치한다."),
)

SUPPLIES = DOC(
    H(2, "신청 방법"),
    OL("그룹웨어 > 총무 > 사무용품 신청", "품목과 수량 입력", "매주 수요일 일괄 배송"),
    CALLOUT("info", "토너·복사용지는 층별 비품실에서 바로 가져갈 수 있다."),
)


def _ago(days: int, hour: int = 10) -> str:
    d = datetime.now() - timedelta(days=days)
    return d.replace(hour=hour, minute=(days * 7) % 60, second=0, microsecond=0).strftime("%Y-%m-%d %H:%M:%S")


def seed(conn):
    default_pw = os.environ.get("WORKWIKI_DEFAULT_PASSWORD", "1234")
    pw = S.hash_password(default_pw)

    # 부서 코드는 4자리 숫자(1000번대 경영지원, 2000번대 영업, 3000번대 IT·보안). 아래 영문 약칭은 이 파일 안에서만 쓰는 키
    depts = [
        ("HR", "1010", "인사부", "required"), ("LN", "2010", "여신심사부", "required"), ("DP", "2020", "수신업무부", "skip"),
        ("SEC", "3010", "정보보호부", "required"), ("GA", "1020", "총무부", "required"),
    ]
    dept_id, dept_code = {}, {}
    for i, (key, code, name, mode) in enumerate(depts):
        cur = conn.execute("INSERT INTO departments(code, name, approval_mode, sort_order) VALUES (?,?,?,?)",
                           (code, name, mode, i))
        dept_id[key], dept_code[key] = cur.lastrowid, code

    users = [
        # username, 사번, 이름, 직급, 부서
        ("admin", "A0001", "관리자", "차장", "SEC"),
        ("hr_lead", "E1001", "김지현", "과장", "HR"),
        ("hr_staff", "E1002", "박성우", "대리", "HR"),
        ("ln_lead", "E2001", "이정훈", "차장", "LN"),
        ("ln_staff", "E2002", "최유나", "주임", "LN"),
        ("dp_lead", "E3001", "윤서연", "과장", "DP"),
        ("dp_staff", "E3002", "정하늘", "대리", "DP"),
        ("sec_lead", "E4001", "강민준", "과장", "SEC"),
        ("ga_lead", "E5001", "송미경", "과장", "GA"),
        ("ga_staff", "E5002", "한도윤", "사원", "GA"),
    ]
    uid = {}
    for un, no, name, pos, d in users:
        cur = conn.execute(
            "INSERT INTO users(employee_no, username, name, email, position, department_id, password_hash, is_local_admin)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (no, un, name, f"{un}@example.com", pos, dept_id[d], pw, 1 if un == "admin" else 0))
        uid[un] = cur.lastrowid
    conn.execute("INSERT INTO system_roles VALUES (?, 'sys_admin')", (uid["admin"],))
    conn.execute("INSERT INTO system_roles VALUES (?, 'auditor')", (uid["admin"],))
    for d, un, selfpub in [("HR", "hr_lead", 1), ("LN", "ln_lead", 0), ("DP", "dp_lead", 1),
                           ("SEC", "sec_lead", 1), ("GA", "ga_lead", 1)]:
        conn.execute("INSERT INTO dept_admins VALUES (?,?,?)", (dept_id[d], uid[un], selfpub))

    cats = {
        "HR": ["근태·휴가", "채용·온보딩", "인사발령"],
        "LN": ["개인여신", "기업여신", "담보관리"],
        "DP": ["계좌개설", "휴면·해지", "전자금융"],
        "SEC": ["사고대응", "단말보안"],
        "GA": ["경비·법인카드", "시설·자산"],
    }
    cat_id = {}
    for d, names in cats.items():
        for i, n in enumerate(names):
            cur = conn.execute("INSERT INTO categories(department_id, name, sort_order) VALUES (?,?,?)",
                               (dept_id[d], n, i))
            cat_id[(d, n)] = cur.lastrowid

    for i, (n, desc, doc) in enumerate([
        ("기본형", "목적·적용 범위·담당·절차·주의사항·관련 규정·문의처", TEMPLATE_BASIC),
        ("체크리스트형", "단계별 확인 항목 중심", TEMPLATE_CHECK),
        ("빈 문서", "처음부터 직접 작성", TEMPLATE_EMPTY),
    ]):
        conn.execute("INSERT INTO templates(name, description, content_json, sort_order) VALUES (?,?,?,?)",
                     (n, desc, json.dumps(doc, ensure_ascii=False), i))

    U = {k: load_user(conn, v) for k, v in uid.items()}
    seq = {}

    def manual(d, cat, title, owner, tags, versions, visibility="company", cycle=12, extra=None,
               created_days=200, review_override=None):
        seq[d] = seq.get(d, 0) + 1
        no = f"{dept_code[d]}-{seq[d]:04d}"
        cur = conn.execute(
            "INSERT INTO manuals(manual_no, title, department_id, category_id, owner_id, visibility, review_cycle_months,"
            " tags, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (no, title, dept_id[d], cat_id[(d, cat)], uid[owner], visibility, cycle,
             json.dumps(tags, ensure_ascii=False), uid[owner], _ago(created_days), _ago(created_days)))
        mid = cur.lastrowid
        for x in extra or []:
            conn.execute("INSERT INTO manual_extra_departments VALUES (?,?)", (mid, dept_id[x]))
        for v in versions:
            author, doc, ctype, reason, days = v[:5]
            pub = v[5] if len(v) > 5 else None
            vid = S.create_version(conn, mid, uid[author], v[6] if len(v) > 6 else title, doc, ctype, reason, at=_ago(days, 10))
            if pub:
                S.publish(conn, mid, vid, U[pub], None, at=_ago(days - 1 if days > 1 else 0, 15))
        if review_override is not None:
            conn.execute("UPDATE manuals SET next_review_date=? WHERE id=?",
                         ((datetime.now() + timedelta(days=review_override)).date().isoformat(), mid))
        return mid

    leave = manual("HR", "근태·휴가", "연차휴가 신청 및 승인 절차", "hr_staff", ["연차", "휴가", "연가", "근태"], [
        ("hr_staff", LEAVE_V1, "최초 작성", "기존 HWP 매뉴얼 이관", 320, "hr_lead"),
        ("hr_staff", LEAVE_V2, "내용 보완", "휴가 종류 표 추가", 210, "hr_lead"),
        ("hr_staff", LEAVE_V3, "규정 개정", "취업규칙 개정 반영(3일 이상 부서장 결재)", 60, "hr_lead"),
        ("hr_staff", LEAVE_V4, "절차 변경", "5일 이상 본부장 결재 추가, 잔여 연차 확인 안내", 2),
    ], created_days=330)
    S.request_publish(conn, leave, U["hr_staff"], "본부장 결재 기준이 이번 달부터 적용됩니다.", at=_ago(1, 16))

    manual("HR", "채용·온보딩", "신규 입사자 온보딩 체크리스트", "hr_lead", ["온보딩", "신규입사", "입사", "교육"], [
        ("hr_lead", ONBOARDING, "최초 작성", "온보딩 절차 표준화", 90, "hr_lead"),
    ])
    manual("HR", "인사발령", "인사발령 처리 매뉴얼", "hr_lead", ["인사발령", "전보", "권한회수"], [
        ("hr_lead", TRANSFER, "최초 작성", "발령 후속 조치 정리", 400, "hr_lead"),
    ], visibility="department", extra=["GA", "SEC"], review_override=-35)
    rem = manual("HR", "근태·휴가", "재택근무 신청 가이드", "hr_staff", ["재택", "원격근무"], [], created_days=3)
    conn.execute("INSERT INTO manual_drafts(manual_id, user_id, title, content_json, saved_at) VALUES (?,?,?,?,?)",
                 (rem, uid["hr_staff"], "재택근무 신청 가이드", json.dumps(REMOTE_DRAFT, ensure_ascii=False), _ago(0, 9)))

    manual("LN", "개인여신", "개인 신용대출 심사 절차", "ln_staff", ["신용대출", "DSR", "전결", "심사"], [
        ("ln_staff", LOAN_V1, "최초 작성", "심사 절차 문서화", 260, "ln_lead"),
        ("ln_staff", LOAN_V2, "규정 개정", "DSR 산정·전결 기준 추가", 45, "ln_lead"),
    ])
    manual("LN", "담보관리", "담보대출 감정평가 의뢰 방법", "ln_staff", ["감정평가", "담보", "부동산"], [
        ("ln_staff", COLLATERAL, "최초 작성", "감정 의뢰 절차 정리", 340, "ln_lead"),
    ], visibility="department", review_override=12)

    manual("DP", "계좌개설", "예금 계좌 개설 업무 처리", "dp_staff", ["계좌개설", "한도제한계좌", "실명확인", "CDD"], [
        ("dp_staff", ACCOUNT_V1, "최초 작성", "창구 업무 매뉴얼 이관", 300, "dp_staff"),
        ("dp_staff", ACCOUNT_V2, "규정 개정", "고객확인·한도제한계좌 기준 반영", 30, "dp_staff"),
    ])
    manual("DP", "휴면·해지", "휴면계좌 해지 및 잔액 이전", "dp_staff", ["휴면계좌", "휴면예금", "해지"], [
        ("dp_staff", DORMANT_V1, "최초 작성", "", 150, "dp_lead"),
        ("dp_staff", DORMANT_V2, "내용 보완", "비대면 처리 안내 추가", 1),
    ])

    manual("SEC", "사고대응", "개인정보 유출 사고 대응 절차", "sec_lead", ["개인정보", "유출", "사고", "신고"], [
        ("sec_lead", PRIVACY_INCIDENT, "최초 작성", "사고 대응 절차 제정", 120, "sec_lead"),
    ], cycle=6)
    manual("SEC", "단말보안", "업무용 PC 보안 점검 가이드", "sec_lead", ["PC보안", "백신", "USB", "보안점검"], [
        ("sec_lead", PC_SECURITY_V1, "최초 작성", "", 280, "sec_lead"),
        ("sec_lead", PC_SECURITY_V2, "내용 보완", "월간 점검 항목 확대", 75, "sec_lead"),
    ])

    manual("GA", "경비·법인카드", "법인카드 사용 및 정산 방법", "ga_lead", ["법인카드", "경비", "정산", "영수증"], [
        ("ga_lead", CORP_CARD, "최초 작성", "경비 지침 요약", 420, "ga_lead"),
    ], review_override=-20)
    manual("GA", "시설·자산", "사무용품 신청 방법", "ga_staff", ["사무용품", "비품"], [
        ("ga_staff", SUPPLIES, "최초 작성", "", 50, "ga_lead"),
    ])

    # 즐겨찾기·조회수·검색로그·감사로그 예시
    for un, ids in [("hr_staff", [1, 9, 11]), ("ga_staff", [11, 1]), ("ln_staff", [5, 9])]:
        for mid in ids:
            conn.execute("INSERT OR IGNORE INTO favorites VALUES (?,?,?)", (uid[un], mid, _ago(5)))
    for mid in range(1, 13):
        for d in range(0, 14):
            v = (mid * 7 + d * 3) % 11
            if v:
                conn.execute("INSERT OR IGNORE INTO view_stats VALUES (?,?,?)",
                             (mid, (datetime.now() - timedelta(days=d)).date().isoformat(), v))
    for q, n, days in [("퇴직연금", 0, 3), ("출장비 정산", 0, 2), ("연차", 1, 1), ("외화송금", 0, 1), ("법인카드", 1, 0)]:
        conn.execute("INSERT INTO search_logs(at, user_id, query, result_count) VALUES (?,?,?,?)",
                     (_ago(days, 11), uid["ga_staff"], q, n))
    conn.execute("INSERT INTO hr_sync_runs(started_at, finished_at, run_by, created, updated, deactivated, status)"
                 " VALUES (?,?,?,?,?,?,?)", (_ago(7, 2), _ago(7, 2), None, 10, 0, 0, "applied"))
    S.audit(conn, None, "system.seed", "system", None, None, {"note": "예시 데이터 생성"})
