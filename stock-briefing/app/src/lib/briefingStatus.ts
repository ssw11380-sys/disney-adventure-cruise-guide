import type { BriefingFailureKind, BriefingReasonKind, BriefingStatus, BriefingStatusProblem } from "@/api/types";
import { sentence, speakClock } from "./a11y";

/**
 * 브리핑 늦음·실패 안내 (브리핑 3차 2, 플래그 briefingStatus) — 글·종류 → 말 (순수, React Native 를 부르지 않는다).
 *  - 탭 맨 위 안내 한 덩어리(statusView): 서버 GET /api/briefings/status 의 상태 → 첫 줄(굵게) · 누르는 이름(5개까지) · 작은 줄 · 화면 읽기 한 문장
 *  - 실패 브리핑 카드·목록 줄·상세: 저장된 오류 원문 대신 쉬운 말 (failedLine · failedCardText · failedRunText)
 * 스케줄러는 실패 종목을 다시 만들지 않는다 → '잠시 뒤 다시 만들어집니다'는 쓰지 않는다 (서버 retryAt 이 오면 그때만 — 지금은 늘 null)
 */

/**
 * 저장된 오류 글(`${kind}: ${message}`, 없으면 요약 '브리핑 생성 실패: …') → 종류. 서버 failureKind 와 같은 표 (shared/fixtures/briefingFailure.json)
 */
export function failureKind(error: string | null | undefined): BriefingFailureKind {
  const e = (error ?? "").trim().replace(/^브리핑 생성 실패:\s*/, "");
  if (e.startsWith("config:")) return "setup";
  if (e.startsWith("refusal:") || e.startsWith("truncated:")) return "cutoff";
  if (e.startsWith("api:")) {
    if (/\(429\)|사용량 제한|\(529\)/.test(e)) return "busy";
    if (/\(5\d\d\)|서버 장애|모델 호출 실패/.test(e)) return "outage";
  }
  return "other";
}

/** 이유 한 문장 (안내·상세 카드) */
export const REASON_TEXT: Readonly<Record<BriefingReasonKind, string>> = {
  busy: "AI 서비스가 잠시 붐볐습니다",
  outage: "AI 서비스에 잠시 문제가 있었습니다",
  setup: "서버 설정 문제로 만들지 못했습니다 (관리자 확인 필요)",
  cutoff: "AI가 글을 끝까지 쓰지 못했습니다",
  other: "만드는 중 문제가 생겼습니다",
  restart: "서버가 도중에 다시 시작되어 끝까지 만들지 못했습니다",
};

/** 짧은 이유 (목록 줄·카드 첫 줄 '만들지 못함 · …') */
export const REASON_SHORT: Readonly<Record<BriefingReasonKind, string>> = {
  busy: "AI 서비스가 잠시 붐빔",
  outage: "AI 서비스에 잠시 문제",
  setup: "서버 설정 문제 (관리자 확인 필요)",
  cutoff: "AI가 글을 끝까지 못 씀",
  other: "만드는 중 문제가 생김",
  restart: "서버가 도중에 다시 시작됨",
};

/** 다시 만들기가 실패했지만 전에 만든 브리핑이 남아 있을 때 서버가 붙이는 말 */
const KEPT = "(이전 브리핑은 그대로 둡니다)";

/** ISO 시각 → 한국 시각 "08:39" (못 읽으면 null) */
export function kstClock(iso: string | null | undefined): string | null {
  const t = iso ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(t)) return null;
  return new Date(t + 9 * 3_600_000).toISOString().slice(11, 16);
}

/** ISO 시각의 한국 날짜 YYYY-MM-DD */
const kstDay = (t: number) => new Date(t + 9 * 3_600_000).toISOString().slice(0, 10);
const WEEK = ["일", "월", "화", "수", "목", "금", "토"];

/** 다음 브리핑 시각: 오늘이면 "16:00", 내일이면 "내일 08:30", 그 뒤면 "9/28(월) 08:30" */
export function nextWhen(iso: string | null, now: number): string | null {
  const t = iso ? Date.parse(iso) : Number.NaN;
  const hm = kstClock(iso);
  if (Number.isNaN(t) || !hm) return null;
  const day = kstDay(t);
  if (day === kstDay(now)) return hm;
  if (day === kstDay(now + 86_400_000)) return `내일 ${hm}`;
  const d = new Date(`${day}T12:00:00Z`);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WEEK[d.getUTCDay()]}) ${hm}`;
}

/** 화면 읽기용 다음 브리핑 시각 ("16시", "내일 8시 30분", "9월 28일 월요일 8시 30분") */
function speakWhen(iso: string | null, now: number): string | null {
  const t = iso ? Date.parse(iso) : Number.NaN;
  const hm = kstClock(iso);
  if (Number.isNaN(t) || !hm) return null;
  const day = kstDay(t);
  if (day === kstDay(now)) return speakClock(hm);
  if (day === kstDay(now + 86_400_000)) return `내일 ${speakClock(hm)}`;
  const d = new Date(`${day}T12:00:00Z`);
  return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일 ${WEEK[d.getUTCDay()]}요일 ${speakClock(hm)}`;
}

/** 안내 한 덩어리 (문제가 없으면 statusView 가 null) */
export interface StatusView {
  /** 왼쪽 막대 색: 모두 못 만듦·모델 없음만 danger */
  tone: "warn" | "danger";
  /** 첫 줄 (본문 굵게) */
  title: string;
  /** 누르는 이름 (5개까지, 등록순) */
  names: BriefingStatusProblem[];
  /** 넘친 수 ('외 3종목') — 없으면 0 */
  more: number;
  /** 이름 대신 둘째 줄 글 (늦음·만드는 중·빠짐·모델 없음·모두 못 만듦의 이유) */
  line: string | null;
  /** 작은 글: 첫 조각 묶음(' · ' 로 잇되 묶음째 줄바꿈)과 그 아래 안내 문장 */
  small: { parts: string[]; note: string | null } | null;
  /** 화면 읽기 한 문장 ('브리핑 안내, …') — 이름은 따로 링크 */
  speech: string;
  /** 회차 이름 '오전'·'오후' (이름 링크의 화면 읽기) */
  session: string;
}

/** 이름을 보이는 최대 개수 */
export const NAMES_MAX = 5;

/** 문장 끝 마침표를 떼고 따옴표를 뺀 화면 읽기 조각 */
const said = (s: string | null) => (s ? s.replace(/['"‘’“”]/g, "").replace(/\.$/, "") : null);

/**
 * 서버 상태 → 안내. ok·none 이면 null (아무것도 안 보임).
 * now 는 '다음 브리핑(16:00)'·'내일 08:30' 을 고르는 데만 쓴다
 */
export function statusView(s: BriefingStatus | null | undefined, now: number): StatusView | null {
  if (!s) return null;
  const ses = s.session === "afternoon" ? "오후" : "오전";
  const sched = kstClock(s.scheduledAt);
  const fin = kstClock(s.finishedAt);
  const next = nextWhen(s.nextRunAt, now);
  const nextSaid = speakWhen(s.nextRunAt, now);
  const reason = s.reasonKind ? REASON_TEXT[s.reasonKind] : null;
  const base = { names: [] as BriefingStatusProblem[], more: 0, line: null as string | null, small: null as StatusView["small"], session: ses };
  switch (s.state) {
    case "llmOff": {
      const title = "브리핑 모델이 설정되지 않았습니다";
      const line = "브리핑을 만드는 모델 키가 서버에 설정되지 않아 새 브리핑을 만들 수 없습니다. 관리자에게 알려 주세요.";
      return { ...base, tone: "danger", title, line, speech: sentence(["브리핑 안내", title, said(line)]) };
    }
    case "partial": {
      const n = s.problems.length;
      const title = `${ses} 브리핑 ${s.total}종목 중 ${n}종목을 만들지 못했습니다`;
      const time = s.late && sched && fin ? `예정 ${sched} → ${fin} 완료` : fin ? `${fin} 완료` : null;
      const timeSaid = s.late && sched && fin ? `예정 ${speakClock(sched)}, ${speakClock(fin)} 완료` : fin ? `${speakClock(fin)} 완료` : null;
      // 이름을 누르면 상세의 '이 종목 다시 만들기' (briefingManualRun). 누를 이름이 없거나 꺼져 있으면 다음 예약 브리핑을 말한다
      const canOpen = s.problems.some((p) => p.briefingId !== null);
      const note = s.manualRun && canOpen ? "이름을 누르면 그 종목만 다시 만드는 버튼이 있습니다." : next ? `다음 브리핑(${next})에 새로 만듭니다.` : null;
      const noteSaid = s.manualRun && canOpen ? said(note) : nextSaid ? `다음 브리핑 ${nextSaid}에 새로 만듭니다` : null;
      const parts = [reason ? `이유: ${reason}` : null, time].filter((x): x is string => !!x);
      return {
        ...base,
        tone: "warn",
        title,
        names: s.problems.slice(0, NAMES_MAX),
        more: Math.max(0, n - NAMES_MAX),
        small: parts.length || note ? { parts, note } : null,
        speech: sentence(["브리핑 안내", title, reason ? `이유 ${reason}` : null, timeSaid, noteSaid]),
      };
    }
    case "allFailed": {
      const title = `${ses} 브리핑을 하나도 만들지 못했습니다`;
      const line = reason ? `이유: ${reason}` : null;
      const note = `지금 만들려면 아래 '수동 생성'을 누르세요.${next ? ` 다음 브리핑(${next})에도 새로 만듭니다.` : ""}`;
      const noteSaid = sentence(["지금 만들려면 아래 수동 생성을 누르세요", nextSaid ? `다음 브리핑 ${nextSaid}에도 새로 만듭니다` : null]);
      return { ...base, tone: "danger", title, line, small: { parts: [], note }, speech: sentence(["브리핑 안내", title, reason ? `이유 ${reason}` : null, noteSaid]) };
    }
    case "late": {
      if (!sched || !fin) return null;
      const title = `${ses} 브리핑이 평소보다 늦게 만들어졌습니다`;
      return {
        ...base,
        tone: "warn",
        title,
        line: `예정 ${sched} → ${fin} 완료`,
        small: { parts: [], note: `숫자는 ${fin} 기준입니다.` },
        speech: sentence(["브리핑 안내", title, `예정 ${speakClock(sched)}`, `${speakClock(fin)} 완료`, `숫자는 ${speakClock(fin)} 기준입니다`]),
      };
    }
    case "slow": {
      const title = `${ses} 브리핑을 아직 만드는 중입니다`;
      const progress = `지금 ${s.total}종목 중 ${s.done}종목 끝남`;
      return {
        ...base,
        tone: "warn",
        title,
        line: sched ? `예정 ${sched} · ${progress}` : progress,
        speech: sentence(["브리핑 안내", title, sched ? `예정 ${speakClock(sched)}` : null, progress]),
      };
    }
    case "missed": {
      const title = `오늘 ${ses} 브리핑이 만들어지지 않았습니다`;
      const note = "지금 만들려면 아래 '수동 생성'을 누르세요.";
      return {
        ...base,
        tone: "warn",
        title,
        line: sched ? `예정 ${sched} 에 실행된 기록이 없습니다.` : "실행된 기록이 없습니다.",
        small: { parts: [], note },
        speech: sentence(["브리핑 안내", title, sched ? `예정 ${speakClock(sched)}에 실행된 기록이 없습니다` : "실행된 기록이 없습니다", said(note)]),
      };
    }
    default:
      return null;
  }
}

/** 이름 링크의 화면 읽기: "테슬라 오전 브리핑, 만들지 못함, 열기" */
export function problemSpeech(p: Pick<BriefingStatusProblem, "name">, session: string): string {
  return sentence([`${p.name} ${session} 브리핑`, "만들지 못함", "열기"]);
}

/** 실패 브리핑 목록 줄·카드 첫 줄: "만들지 못함 · AI 서비스가 잠시 붐빔" */
export function failedLine(b: { error: string | null; summary: string }): string {
  return `만들지 못함 · ${REASON_SHORT[failureKind(b.error ?? b.summary)]}`;
}

/** 실패 브리핑 상세 카드: "이 브리핑을 만들지 못했습니다 · 이유: AI 서비스가 잠시 붐볐습니다 (08:36)" */
export function failedCardText(b: { error: string | null; summary: string; createdAt: string }): string {
  const hm = kstClock(b.createdAt);
  return `이 브리핑을 만들지 못했습니다 · 이유: ${REASON_TEXT[failureKind(b.error ?? b.summary)]}${hm ? ` (${hm})` : ""}`;
}

/** 수동 생성·다시 만들기 결과 창의 실패 한 줄 (원문 대신): "SK하이닉스: AI 서비스가 잠시 붐볐습니다 (이전 브리핑은 그대로 둡니다)" */
export function failedRunText(error: string | null | undefined, name?: string): string {
  const text = `${REASON_TEXT[failureKind(error)]}${error?.includes(KEPT) ? ` ${KEPT}` : ""}`;
  return name ? `${name}: ${text}` : text;
}
