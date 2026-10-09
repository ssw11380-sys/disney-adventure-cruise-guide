import type { Quote } from "../domain/types.js";
import { formatRate } from "../notifications/digest.js";
import { forbiddenIn, numberTokens, RIEUL_FINAL } from "./accountNumbers.js";
import type { BriefingSnapshot } from "./collector.js";

/**
 * 종목 브리핑 AI 글 안전하게 (브리핑 2차 6, 플래그 briefingSafeWording). 순수 함수만 둔다.
 *  - 금지어 검사(findBanned): 매매 지시·권유, 평가 꼬리표, 지지·저항 같은 가격 신호, 다음 세션·해석, 전망·추측 말이 든 줄을 찾는다
 *  - 요약은 두 줄: 첫 줄은 시세로 만든 가격 줄(codeSummaryLine), 둘째 줄은 검사를 통과한 모델 한 줄 또는 개수 줄(countLine)
 *  - 상세는 걸린 줄(제목이면 그 절 전체)을 뺀다(cleanDetail). 숫자 대조(unknownNumbers)는 로그에만 쓴다
 * 계좌 브리핑 검사기(checkNarrative)를 그대로 쓰지 않는다 — 뉴스·수급 칸의 사실 문장까지 걸리기 때문
 */

/** 종목 브리핑 글에서 그 줄을 빼는 말. 수급 사실(순매수·매수세·매도 우위·매도 물량·공개매수)과 '지지부진'·'지지율'·'고려아연'은 걸리지 않게 */
export const BRIEFING_BANNED = new RegExp(
  [
    // 1) 매매 지시·권유·행동 제안
    "(?<!순|공개)매수(?!세|잔량| ?우위)",
    "(?<!순)매도(?!세|잔량| ?우위| ?물량)",
    "추천|권유|권장|권합|목표 ?주가|목표가|손절|익절|진입|관망|분할 ?매|저가 ?매|차익 ?실현",
    "비중을? ?(?:늘|줄|확대|축소|조절|낮|높)",
    "고려(?:해|하|할)|기회|타이밍|유망|저평가|고평가|매력",
    "세요|십시오|바랍니다",
    // 2) 평가 꼬리표
    "\\((?:긍정|부정|중립)\\)|(?:긍정|부정)적 ?(?:영향|요인|신호)",
    // 3) 가격 신호 (맨 '지지'·'저항'은 뒤에 가격·확인·돌파·이탈이 올 때만)
    "지지선|저항선|지지대|저항대|지지와 저항|지지\\/저항|(?:지지|저항) ?구간",
    "(?:지지|저항)(?=\\s*(?:\\$|\\d|확인|돌파|이탈|테스트))",
    "돌파 ?시|이탈 ?시|뚫으면|깨지면|확인할 가격|주목할 가격|과매수|과매도|골든 ?크로스|데드 ?크로스",
    // 4) 다음 세션·해석
    "체크 ?포인트|다음 세션에서 볼|지켜볼|보유자 관점|그 의미",
    // 5) 전망·추측 (받침 ㄹ + 전망·듯·것: '오를 전망'·'할 듯'·'늘 것')
    "(?:오를|내릴|상승할|하락할|반등할) ?(?:것|가능성|수)",
    "것으로 (?:보입|예상|전망)|전망됩니다|예상됩니다|가능성이 (?:높|크)",
    `[${RIEUL_FINAL}] ?(?:전망|듯|것)`,
    "겠(?:습|다)|여력|기대(?:됩|된|감)|우려",
  ].join("|"),
  "g",
);

/** 걸린 말 또는 null. 출처(source)에 그대로 있는 '더 긴 말'의 일부면 넘어간다 (forbiddenIn 과 같은 규칙) */
export function findBanned(text: string, source: string): string | null {
  return forbiddenIn(text, source, BRIEFING_BANNED);
}

/** 검사에 쓰는 스냅숏 칸 (시세·뉴스·공시) */
export type WordingSnapshot = Pick<BriefingSnapshot, "quote" | "news" | "disclosures">;

/** 출처 글: 뉴스 제목·요약과 공시 제목을 줄바꿈으로 이은 글 (없으면 빈 글) */
export function sourceText(s: WordingSnapshot): string {
  return [...(s.news ?? []).flatMap((n) => [n.title, n.summary ?? ""]), ...(s.disclosures ?? []).map((d) => d.title)]
    .filter((x) => x.length > 0)
    .join("\n");
}

/** 가격 기준 표시: 정규장 기준은 붙이지 않고, 정규장이 아닌 기준은 모두 밝힌다 */
function basisNote(basis: string | undefined): string {
  if (!basis || basis === "KRX 정규장" || basis === "정규장") return "";
  if (basis === "KRX+NXT 통합") return " (NXT 포함)";
  if (basis === "주간거래") return " (주간거래)";
  if (basis === "최근 체결(시간외 포함)") return " (시간외 포함)";
  return ` (${basis})`;
}

/** 가격: 원화 '84,300원', 달러 1 이상 '$1,234.50', 1 미만 '$0.8123' */
function priceText(q: Quote): string {
  if (q.currency === "USD") {
    return q.price >= 1 ? `$${q.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `$${q.price.toFixed(4)}`;
  }
  return `${Math.round(q.price).toLocaleString("ko-KR")}원`;
}

/**
 * 요약 첫 줄: 브리핑 때 받은 시세로 만든 가격 줄 '84,300원 · 전일 대비 +3.56% (NXT 포함)'.
 * 모델이 가격을 옮겨 쓰지 않게 한다 (월요일에 금요일 시간외 가격을 '종가'로 쓰던 것). 시세 지연이면 끝에 '(시세 지연)'
 */
export function codeSummaryLine(quote: Quote | null | undefined): string {
  if (!quote) return "가격 확인 안 됨";
  return `${priceText(quote)} · 전일 대비 ${formatRate(quote.changeRate)}${basisNote(quote.priceBasis)}${quote.stale ? " (시세 지연)" : ""}`;
}

/** 요약 둘째 줄을 못 고를 때: 뉴스·공시 개수 줄 */
export function countLine(s: WordingSnapshot): string {
  const n = s.news === null ? null : s.news.length;
  const m = s.disclosures === null ? null : s.disclosures.length;
  if (n === null && m === null) return "뉴스·공시 확인 안 됨";
  if (m === null) return n! > 0 ? `최근 뉴스 ${n}건` : "새 뉴스 없음";
  if (n === null) return m > 0 ? `공시 ${m}건` : "새 공시 없음";
  const parts = [n > 0 ? `최근 뉴스 ${n}건` : null, m > 0 ? `공시 ${m}건` : null].filter((x): x is string => x !== null);
  return parts.length ? parts.join(" · ") : "새 뉴스·공시 없음";
}

/** 요약은 알림 본문이므로 마크다운 기호를 걷어내고 3줄로 제한 */
export function normalizeSummary(text: string): string {
  return text
    .split(/\r?\n/)
    // 앞의 글머리 기호(-, *, •)나 번호(1. / 2) / 3:)만 걷어낸다. "189만원…" 처럼 숫자로 시작하는 본문은 남겨야 한다.
    .map((l) => l.replace(/^\s*(?:[-*•]\s+|\d{1,2}\s*[.):]\s+)?/, "").replace(/[*_`#]/g, "").trim())
    .filter((l) => l.length > 0)
    .slice(0, 3)
    .join("\n");
}

/** 가격·등락률 숫자 (둘째 줄에 있으면 첫 줄과 겹치거나 어긋나므로 건너뜀) */
const PRICE_NUMBER = /\d[\d,]*(?:\.\d+)?\s*(?:원|%|달러)|\$\s*\d/;

/**
 * 요약 둘째 줄: 모델 요약을 정리한 줄 중 검사에 걸리지 않고, 가격·등락률 숫자가 없고, 첫 줄과 다른 첫 줄.
 * 없으면 개수 줄. from 은 로그용 (모델 줄을 쓴 비율을 보려고)
 */
export function secondLine(s: WordingSnapshot, modelText: string): { line: string; from: "model" | "count" } {
  const first = codeSummaryLine(s.quote);
  const source = sourceText(s);
  const line = normalizeSummary(modelText)
    .split("\n")
    .find((l) => l.length > 0 && findBanned(l, source) === null && !PRICE_NUMBER.test(l) && l !== first);
  return line !== undefined ? { line, from: "model" } : { line: countLine(s), from: "count" };
}

/** 켜졌을 때 저장하는 요약: 가격 줄 + 둘째 줄 */
export function safeSummary(s: WordingSnapshot, modelText: string): string {
  return `${codeSummaryLine(s.quote)}\n${secondLine(s, modelText).line}`;
}

const HEADING = /^## /;
const isBlank = (l: string) => l.trim().length === 0;

/** 앱 마크다운(markdown-it)이 빈칸으로 그리는 이름 붙은 HTML 엔티티 — 나머지 이름 엔티티는 검사할 때 빈 글자로 본다 ('&amp;' 등 몇 개는 그 글자) */
const SPACE_ENTITY = /^(?:nbsp|NonBreakingSpace|ensp|emsp|emsp13|emsp14|numsp|puncsp|thinsp|ThinSpace|hairsp|VeryThinSpace|MediumSpace|ThickSpace|Tab|NewLine)$/;
const CHAR_ENTITY: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntity(m: string, dec: string | undefined, hex: string | undefined, name: string | undefined): string {
  if (dec !== undefined || hex !== undefined) {
    const n = dec !== undefined ? Number(dec) : parseInt(hex!, 16);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "\uFFFD";
  }
  if (name === undefined) return m;
  return SPACE_ENTITY.test(name) ? " " : (CHAR_ENTITY[name] ?? "");
}

/**
 * 검사용 복사본 (1단계 검토 7차): 앱 마크다운으로 그리면 같은 문장으로 보이는 변형을 걷어 낸다 — '지금  사셔도  됩니다'(두 칸·NBSP·탭·전각 공백),
 * '지금 사셔도 **됩니다**'(낱말 하나만 강조 *·_·`), '&nbsp;'·'&#45768;'(엔티티), '<b>…</b>'(태그), '[글](주소)'(링크),
 * 분해해 적은 한글·전각 글자(NFKC), 폭 없는 공백·U+2060 같은 보이지 않는 서식 글자, 한글 채움 글자(빈칸으로 보임), '\*'(역슬래시 꾸밈).
 * 강조 표시를 빼고 빈칸을 한 칸으로 모은 뒤 예외 말·금지어를 본다. 보여 주는 글은 원문 그대로 둔다 (검사할 때만)
 */
export function renderedForCheck(line: string): string {
  return line
    .replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g, decodeEntity)
    .replace(/<\/?[A-Za-z][^<>]*>/g, "")
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
    .normalize("NFKC")
    .replace(/[\u115F\u1160\u3164\uFFA0]/g, " ")
    .replace(/\p{Cf}/gu, "")
    .replace(/\\(?=[!-/:-@[-`{-~])/g, "")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ");
}

/**
 * 상세 글 검사. 줄마다 보고, '## ' 제목 줄이 걸리면 그 제목과 다음 제목 전까지의 줄을 모두, 제목이 아닌 줄이 걸리면 그 줄만 뺀다.
 * 내용 줄(빈 줄 제외)이 모두 빠진 제목도 빼고, 빈 줄이 3줄 넘게 이어지면 1줄로. 뺀 내용 줄이 있으면 끝에 '(문장 검사에서 N줄을 뺐습니다)'.
 * 걸린 것이 없으면 글자 하나 바꾸지 않고 그대로 (dropped 0). banned: 거르는 말 (기본 브리핑 금지어 — AI 가치분석은 더 엄격한 VALUE_AI_BANNED, 'g' 플래그 필요).
 * allow: 검사 전에 빈칸으로 바꿔 두는 사실 말 ('g' 플래그 — AI 가치분석의 '이익 안정성'·'위험가중자산' 등). 없으면 그대로 본다.
 * opts.rendered: 줄을 검사용 복사본(renderedForCheck — 강조 표시 빼고 빈칸 한 칸으로)으로 바꾼 뒤 allow·banned 를 본다 (AI 가치분석).
 * 없으면 줄 그대로 본다 (브리핑 경로는 지금 그대로). 돌려주는 글은 어느 쪽이든 원문 그대로
 */
export function cleanDetail(
  detail: string,
  source: string,
  banned: RegExp = BRIEFING_BANNED,
  allow?: RegExp,
  opts: { rendered?: boolean } = {},
): { text: string; dropped: number } {
  const view = opts.rendered === true ? renderedForCheck : (l: string) => l;
  const hit1 = (raw: string) => {
    const l = view(raw);
    return forbiddenIn(allow ? l.replace(allow, (m) => " ".repeat(m.length)) : l, source, banned);
  };
  const lines = detail.split("\n");
  // 절: 첫 제목 앞 줄들(heading null) + 제목마다 그 아래 줄들
  const sections: Array<{ heading: string | null; body: string[] }> = [{ heading: null, body: [] }];
  for (const l of lines) {
    if (HEADING.test(l)) sections.push({ heading: l, body: [] });
    else sections[sections.length - 1]!.body.push(l);
  }
  let hit = false;
  let dropped = 0;
  const out: string[] = [];
  for (const sec of sections) {
    if (sec.heading !== null && hit1(sec.heading) !== null) {
      hit = true;
      dropped += sec.body.filter((l) => !isBlank(l)).length;
      continue;
    }
    const had = sec.body.filter((l) => !isBlank(l)).length;
    const kept = sec.body.filter((l) => isBlank(l) || hit1(l) === null);
    const keptContent = kept.filter((l) => !isBlank(l)).length;
    if (keptContent < had) {
      hit = true;
      dropped += had - keptContent;
    }
    // 내용 줄이 있었는데 모두 빠진 제목은 뺀다 (제목만 덩그러니 남지 않게)
    if (sec.heading !== null && had > 0 && keptContent === 0) continue;
    if (sec.heading !== null) out.push(sec.heading);
    out.push(...kept);
  }
  if (!hit) return { text: detail, dropped: 0 };
  // 빈 줄이 3줄 넘게 이어지면 1줄로
  const squeezed: string[] = [];
  let run: string[] = [];
  const flush = () => {
    squeezed.push(...(run.length > 3 ? run.slice(0, 1) : run));
    run = [];
  };
  for (const l of out) {
    if (isBlank(l)) run.push(l);
    else {
      flush();
      squeezed.push(l);
    }
  }
  flush();
  let text = squeezed.join("\n").replace(/\s+$/, "");
  if (dropped > 0) text = `${text}\n\n(문장 검사에서 ${dropped}줄을 뺐습니다)`;
  return { text, dropped };
}

/**
 * 직전 브리핑 요약('2026-09-22 오전: …', 다음 브리핑 입력)에서 걸린 줄을 뺀다 — 예전 형식의 '체크포인트·저항' 줄이 다음 입력으로 들어가지 않게.
 * 날짜 머리는 두고, 남은 줄이 없으면 머리 뒤에 '(검사에서 모두 뺌)'. 걸린 것이 없으면 그대로
 */
export function cleanPrevious(summary: string, source: string): string {
  const head = /^\d{4}-\d{2}-\d{2} (?:오전|오후): /.exec(summary)?.[0] ?? "";
  const lines = summary.slice(head.length).split("\n");
  const kept = lines.filter((l) => findBanned(l, source) === null);
  if (kept.length === lines.length) return summary;
  const content = kept.filter((l) => !isBlank(l));
  return content.length ? `${head}${kept.join("\n")}` : `${head}(검사에서 모두 뺌)`;
}

/** 볼 필요 없는 숫자 단위: 연·월, 목록 번호·순위·서수, 기간 */
const SKIP_UNITS = new Set(["년", "월", "rank", "위", "번째", "기간"]);
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * 상세 글 속 숫자 가운데 모델에 넘긴 값(known = data_json·평균 단가·수량·날짜)에 없는 것 (로그만 — 거절하지 않는다).
 * 10 이하 정수와 연·월·순위·기간은 보지 않고, 절댓값을 소수 둘째 자리로 반올림해 아는 값(같게 반올림)과 맞춰 본다.
 * 단위를 바꿔 쓴 수('1.2만 주')는 모름으로 센다
 */
export function unknownNumbers(detail: string, known: string): { count: number; sample: string[] } {
  const knownValues = new Set<number>();
  for (const m of known.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const v = Number(m[0].replace(/,/g, ""));
    if (Number.isFinite(v)) knownValues.add(round2(v));
  }
  const unknown = numberTokens(detail)
    .tokens.filter((t) => t.kind === "num" && !SKIP_UNITS.has(t.unit) && !(Number.isInteger(t.value) && t.value <= 10))
    .filter((t) => !knownValues.has(round2(Math.abs(t.value))));
  return { count: unknown.length, sample: unknown.slice(0, 5).map((t) => t.raw) };
}
