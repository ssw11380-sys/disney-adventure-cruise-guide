import { scoreWordingProblems } from "../analysis/scoreWording.js";

/**
 * 수급 탭 (3-33, 플래그 flowTab) 서버 글과 문구 검사. 화면에 보이는 글은 앱(app/src/lib/flowText.ts)이 거의 다 만들고,
 * 서버는 미국 종목 안내·꺼짐·실패 같은 짧은 글만 만든다. 모든 글은 flowWordingProblems 를 통과해야 한다 (test/investorFlow.test.ts)
 */
export const FLOW_TEXT = {
  usReason: "미국 주식은 투자자별 매매 자료가 공개되지 않습니다",
  off: "수급 탭 기능이 꺼져 있습니다",
  upstream: "수급 자료를 받지 못했습니다",
  noOpenApi: "토스 Open API 키가 없어 비교하지 않았습니다",
  noTossWeb: "토스증권 웹 자료를 받지 못해 비교하지 않았습니다",
} as const;

/**
 * 수급을 판단·해석하는 낱말 (세력·개미·매집·유입·이탈·강세·신호 …). 수급 탭은 '산 주식 수 − 판 주식 수' 사실만 보이고
 * 그것이 좋다·나쁘다·주가가 어떻게 된다는 뜻을 붙이지 않는다
 */
export const FLOW_JUDGE_RE = /(세력|개미|매집|쓸어|몰려|몰리|이탈|유입|탈출|수급 (?:개선|악화|양호|불안)|긍정|부정|강세|약세|호재|악재|신호|청신호|빨간불|파란불|심상치)/;

/** 자료 이름이라 검사 전에 지우는 말 ('매수·매도'가 그 안에서 걸리므로) — 순매수·순매도(칸 이름), 공매도(미국 안내의 자료 이름) */
export const FLOW_TERMS_RE = /순매수|순매도|공매도/g;

/**
 * 수급 글에서 걸리는 낱말 (없으면 빈 배열). 지표 점수 검사기(투자 권유·예측 말)에 수급 판단 낱말을 더한 것.
 * 자료 이름(FLOW_TERMS_RE)은 사실을 가리키는 이름이라 검사 전에 지운다
 */
export function flowWordingProblems(text: string): string[] {
  const t = text.replace(FLOW_TERMS_RE, "");
  const out = scoreWordingProblems(t);
  const judged = t.match(new RegExp(FLOW_JUDGE_RE.source, "g"));
  if (judged) out.push(...judged);
  return out;
}
