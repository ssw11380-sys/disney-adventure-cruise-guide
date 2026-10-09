import { Alert, type AlertButton } from "react-native";
import { ApiRequestError, type Api } from "@/api/client";
import type { TossImportResult } from "@/api/types";
import { formatPrice } from "./format";
import { haptic } from "./haptics";

/** 전체 계좌 보유와 앱 연동 대상을 구분한다. holdings에는 제외 종목도 들어 있다. */
export function tossImportSummary(r: TossImportResult) {
  const excluded = [...new Set(r.excluded ?? [])];
  const skipped = new Set(excluded);
  const deferred = [...new Set(r.deferred ?? [])].filter((code) => !skipped.has(code));
  const waiting = new Set(deferred);
  const linked = new Set([...r.added, ...r.updated, ...r.unchanged].filter((code) => !skipped.has(code) && !waiting.has(code)));
  const holdings = [...new Map(r.holdings.map((h) => [h.code, h])).values()];
  const name = (code: string) => {
    const h = holdings.find((item) => item.code === code);
    return h && h.name !== code ? `${h.name} (${code})` : code;
  };
  const summary = `${r.accounts}개 계좌 · ${deferred.length ? "이번 조회" : "보유"} ${holdings.length}종목 · 앱 연동 대상 ${linked.size}종목 · 동기화 제외 ${excluded.length}종목${deferred.length ? ` · 반영 보류 ${deferred.length}종목` : ""}`;
  const lines = [summary];
  if (holdings.length === 0 && deferred.length === 0) lines.push("이번 조회에서 보유 중인 주식이 없습니다. 종목은 검색해서 추가할 수 있습니다.");
  if (excluded.length) {
    lines.push(`동기화 제외 ${excluded.length}종목: ${excluded.map(name).join(", ")}`);
    lines.push("제외 종목은 앱 잔고에 반영하지 않았습니다. 다시 연동할 종목을 직접 선택할 수 있습니다.");
  }
  if (deferred.length) lines.push(`반영 보류 ${deferred.length}종목: ${deferred.map(name).join(", ")}\n일부 계좌 응답을 확인하지 못해 이전 등록·제외 상태를 유지했습니다. 계좌 동기화로 다시 확인해 주세요.`);
  const unknown = holdings.filter((h) => !linked.has(h.code) && !skipped.has(h.code) && !waiting.has(h.code));
  if (unknown.length) lines.push(`반영 여부 확인 필요 ${unknown.length}종목: ${unknown.map((h) => name(h.code)).join(", ")}`);
  lines.push(`새로 추가 ${r.added.length} · 갱신 ${r.updated.length} · 유지 ${r.unchanged.filter((code) => !waiting.has(code)).length}`);
  const written = new Set([...r.added, ...r.updated]);
  for (const h of holdings.filter((item) => linked.has(item.code))) lines.push(written.has(h.code)
    ? `${h.name} · 토스 조회 ${h.quantity}주 · 평단 ${formatPrice(h.avgPrice, h.currency)}`
    : `${h.name} · 기존 등록 유지 (수량·평단은 잔고에서 확인)`);
  if (r.removed?.length) lines.push(`전량 매도 → 관심 종목: ${r.removed.map(name).join(", ")}`);
  return { summary, message: lines.join("\n"), excluded, deferred, name, linked };
}

type ImportApi = Pick<Api, "importTossHoldings" | "registerStock">;
type ImportState = { pending: boolean; lastImport: string | null };
type Restore = { code: string; registered: boolean; exclusionCleared: boolean };

/** 알림은 빈 잔고 화면이 사라져도 유지된다. 모든 후속 행동은 원래 계정·서버인지 다시 확인한다. */
export function createTossImportFlow(deps: {
  api: ImportApi;
  isCurrent: () => boolean;
  invalidate: () => void;
}) {
  let state: ImportState = { pending: false, lastImport: null };
  let revision = 0;
  const listeners = new Set<() => void>();
  const set = (next: ImportState) => { state = next; for (const notify of listeners) notify(); };
  const valid = (expected: number, explain = false) => {
    const ok = expected === revision && deps.isCurrent();
    if (!ok && explain) Alert.alert("다시 확인해 주세요", "계정·서버 또는 가져오기 결과가 바뀌었습니다. 현재 화면에서 계좌를 다시 불러와 주세요.");
    return ok;
  };
  const showExcluded = (r: TossImportResult, index: number, expected: number) => {
    if (!valid(expected, true)) return;
    const view = tossImportSummary(r);
    const code = view.excluded[index];
    if (!code) return;
    const buttons: AlertButton[] = [{ text: "닫기", style: "cancel" }];
    if (view.excluded.length > 1) buttons.push({ text: "다음 종목", onPress: () => { void showExcluded(r, (index + 1) % view.excluded.length, expected); } });
    buttons.push({ text: "다시 연동", onPress: () => { void run({ code, registered: false, exclusionCleared: false }, expected); } });
    Alert.alert(`동기화 제외 ${index + 1}/${view.excluded.length}`, `${view.name(code)}\n\n이 종목만 제외를 해제한 뒤 토스 계좌의 수량·평단을 다시 불러옵니다. 다른 제외 종목은 그대로 둡니다.`, buttons);
  };
  const showResult = (r: TossImportResult, expected: number, restore?: Restore) => {
    const view = tossImportSummary(r);
    set({ pending: true, lastImport: view.summary });
    const buttons: AlertButton[] = [{ text: "확인" }];
    if (view.excluded.length) buttons.push({ text: "제외 종목 확인", onPress: () => { void showExcluded(r, 0, expected); } });
    const linked = restore && view.linked.has(restore.code);
    if (view.deferred.length || (restore && !linked && !view.excluded.includes(restore.code))) buttons.push({ text: "동기화 재시도", onPress: () => { void run(restore, expected); } });
    const restoreNotice = !restore ? "" : linked ? `${view.name(restore.code)}: 연동 대상에서 확인했습니다.\n\n`
      : view.excluded.includes(restore.code) ? `${view.name(restore.code)}이 아직 동기화 제외 상태입니다. 복원이 완료되지 않았습니다.\n\n`
        : view.deferred.includes(restore.code) ? `${view.name(restore.code)}의 수량·평단 반영이 보류되었습니다. 복원이 완료되지 않았습니다.\n\n`
        : `${restore.code}의 보유 정보가 이번 응답에 없어 복원을 확인하지 못했습니다.\n\n`;
    haptic(restore && !linked ? "error" : "success");
    Alert.alert(restore && !linked ? "종목 복원 확인 필요" : view.deferred.length ? "계좌 동기화 · 일부 반영 보류" : "토스 계좌 불러오기 완료", restoreNotice + view.message, buttons);
  };
  const run = async (restore?: Restore, expected = revision) => {
    // React가 다시 그리기 전 연속 클릭이나 다른 진입점에서 보낸 중복 요청도 막는다.
    if (state.pending || expected !== revision) return;
    set({ pending: true, lastImport: null });
    let registered = restore?.registered ?? false;
    let exclusionCleared = restore?.exclusionCleared ?? false;
    const request = ++revision;
    try {
      if (!valid(request, true)) return;
      if (restore && !registered) {
        try {
          await deps.api.registerStock({ code: restore.code });
          exclusionCleared = true;
        } catch (error) {
          // 응답을 놓쳤거나 다른 화면에서 먼저 등록한 경우. 다른 409는 복원으로 간주하지 않는다.
          if (!(error instanceof ApiRequestError && error.status === 409 && error.code === "CONFLICT" && error.message === `이미 등록된 종목입니다: ${restore.code}`)) throw error;
        }
        registered = true;
        if (!valid(request)) return;
      }
      const result = await deps.api.importTossHoldings();
      if (!valid(request)) return;
      deps.invalidate();
      if (!valid(request)) return;
      showResult(result, request, restore ? { ...restore, registered, exclusionCleared } : undefined);
    } catch (error) {
      if (!valid(request)) return;
      const message = error instanceof Error ? error.message : String(error);
      haptic("error");
      if (restore && registered) {
        // 등록은 이미 성공했다. 되돌리거나 재등록하지 않고 다음 수동 시도에서 동기화만 한다.
        deps.invalidate();
        Alert.alert(exclusionCleared ? "제외 해제 완료 · 계좌 동기화 실패" : "등록 확인 · 계좌 동기화 실패", `${restore.code}${exclusionCleared ? "의 제외는 해제했지만 수량·평단을 불러오지 못했습니다." : "은 이미 등록되어 있지만 제외 해제와 보유 정보는 확인하지 못했습니다."}\n${message}`, [
          { text: "닫기", style: "cancel" },
          { text: "동기화 재시도", onPress: () => { void run({ code: restore.code, registered: true, exclusionCleared }, request); } },
        ]);
      } else Alert.alert(restore ? "종목 복원 실패" : "불러오기 실패", message);
    } finally {
      set({ ...state, pending: false });
    }
  };
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot: () => state,
    run: () => run(),
  };
}
