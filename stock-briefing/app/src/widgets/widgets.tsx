import React from "react";
import { FlexWidget, TextWidget, type FlexWidgetStyle } from "react-native-android-widget";
import type { Currency, LatestBriefing, RegisteredWithQuote } from "@/api/types";
import { formatPct, formatPrice, toDisplay } from "@/lib/format";

/**
 * 홈 화면 위젯 3종. react-native-android-widget 프리미티브만 쓴다(RN 컴포넌트 불가, 색은 hex/rgba 문자열).
 *  - HoldingsWidget (4x2): 총 평가·오늘 손익 + 종목별 현재가/등락 (최대 6개). 종목을 누르면 상세로, 헤더를 누르면 앱으로.
 *  - BriefingWidget (4x2): 가장 최근 브리핑의 3줄 요약. 누르면 브리핑 상세로.
 *  - AssetWidget (2x1): 총 평가금액과 오늘 손익만 크게.
 * 새로고침 아이콘은 clickAction "REFRESH" 로 태스크 핸들러에 전달된다.
 */

export const WIDGET_NAMES = { holdings: "Holdings", briefing: "Briefing", asset: "Asset" } as const;

const C = {
  bg: "#0F1E45",
  bg2: "#132A5E",
  ink: "#FFFFFF",
  muted: "#B8C4E6",
  line: "rgba(255, 255, 255, 0.12)",
  up: "#FF8A80",
  down: "#8EC5FF",
  gold: "#E1C25B",
} as const;

const DEEP_LINK = "stockbriefing://";

function fxOf(s: RegisteredWithQuote): number | null {
  return s.quote?.fxRate ?? (s.quote?.priceKrw && s.quote.price ? s.quote.priceKrw / s.quote.price : null);
}

function money(n: number | null | undefined, currency: Currency | undefined, fx: number | null, showKrw: boolean, sign = false): string {
  const d = toDisplay(n, currency, fx, showKrw);
  return formatPrice(d.value, d.currency, { sign });
}

export interface Totals {
  value: number;
  day: number;
  profit: number;
  currency: Currency;
  mixed: boolean; // 통화가 섞여 원화 환산이 안 된 경우
}

/** 보유 종목 합계. showKrw 이거나 통화가 하나면 그 통화로, 아니면 원화 환산(환율 있을 때) */
export function totals(stocks: RegisteredWithQuote[], showKrw: boolean): Totals | null {
  const held = stocks.filter((s) => s.evaluation && s.quote);
  if (held.length === 0) return null;
  const currencies = new Set(held.map((s) => s.quote!.currency ?? "KRW"));
  const single = currencies.size === 1 ? ([...currencies][0] as Currency) : null;
  let value = 0, day = 0, profit = 0, mixed = false;
  for (const s of held) {
    const cur = s.quote!.currency ?? "KRW";
    const fx = fxOf(s);
    const conv = (n: number) => (single ? n : cur === "KRW" ? n : fx ? n * fx : null);
    const v = conv(s.evaluation!.marketValue), d = conv(s.quote!.change * (s.quantity ?? 0)), p = conv(s.evaluation!.profit);
    if (v === null || d === null || p === null) {
      mixed = true;
      continue;
    }
    value += v;
    day += d;
    profit += p;
  }
  const currency: Currency = single ?? "KRW";
  if (single === "USD" && showKrw) {
    // 달러만 보유 + 원화 표시: 환율 있는 종목 기준으로 환산
    const fx = fxOf(held[0]!);
    if (fx) return { value: value * fx, day: day * fx, profit: profit * fx, currency: "KRW", mixed };
  }
  return { value, day, profit, currency, mixed };
}

function tone(n: number): `#${string}` {
  return n > 0 ? C.up : n < 0 ? C.down : C.muted;
}

const root: FlexWidgetStyle = {
  height: "match_parent",
  width: "match_parent",
  backgroundGradient: { from: C.bg, to: C.bg2, orientation: "TL_BR" },
  borderRadius: 20,
  padding: 14,
  flexDirection: "column",
};

function Header({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <FlexWidget style={{ width: "match_parent", flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
      <FlexWidget style={{ flexDirection: "row", alignItems: "center", flexGap: 6 }} clickAction="OPEN_APP">
        <TextWidget text="◆" style={{ color: C.gold, fontSize: 10 }} />
        <TextWidget text={title} style={{ color: C.ink, fontSize: 13, fontWeight: "700" }} />
        {subtitle ? <TextWidget text={subtitle} style={{ color: C.muted, fontSize: 10 }} /> : null}
      </FlexWidget>
      <FlexWidget clickAction="REFRESH" style={{ padding: 4 }}>
        <TextWidget text="↻" style={{ color: C.muted, fontSize: 14 }} />
      </FlexWidget>
    </FlexWidget>
  );
}

function updatedLabel(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")} 기준`;
}

export function HoldingsWidget({ stocks, showKrw, fetchedAt, error, height }: { stocks: RegisteredWithQuote[]; showKrw: boolean; fetchedAt: number; error: string | null; height: number }) {
  const t = totals(stocks, showKrw);
  const rowsFit = Math.max(2, Math.min(6, Math.floor((height - 78) / 26)));
  const rows = stocks.filter((s) => s.quote).slice(0, rowsFit);
  return (
    <FlexWidget style={root}>
      <Header title="내 종목" subtitle={updatedLabel(fetchedAt)} />
      {t ? (
        <FlexWidget style={{ width: "match_parent", flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", marginTop: 6, marginBottom: 6 }} clickAction="OPEN_APP">
          <TextWidget text={formatPrice(t.value, t.currency)} style={{ color: C.ink, fontSize: 20, fontWeight: "800" }} />
          <TextWidget text={`오늘 ${formatPrice(t.day, t.currency, { sign: true })}`} style={{ color: tone(t.day), fontSize: 12, fontWeight: "700" }} />
        </FlexWidget>
      ) : null}
      {error ? <TextWidget text={`불러오기 실패: ${error}`} style={{ color: C.muted, fontSize: 11 }} /> : null}
      {rows.length === 0 && !error ? <TextWidget text="등록된 종목이 없습니다. 앱에서 종목을 등록하세요." style={{ color: C.muted, fontSize: 11 }} /> : null}
      {rows.map((s) => {
        const q = s.quote!;
        const fx = fxOf(s);
        return (
          <FlexWidget
            key={s.code}
            clickAction="OPEN_URI"
            clickActionData={{ uri: `${DEEP_LINK}stocks/${s.code}` }}
            style={{ width: "match_parent", flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 4, borderTopWidth: 1, borderTopColor: C.line }}
          >
            <TextWidget text={s.name} truncate="END" maxLines={1} style={{ color: C.ink, fontSize: 12, fontWeight: "600", width: 120 }} />
            <FlexWidget style={{ flexDirection: "row", alignItems: "center", flexGap: 8 }}>
              <TextWidget text={money(q.price, q.currency, fx, showKrw)} style={{ color: C.ink, fontSize: 12, fontWeight: "700" }} />
              <TextWidget text={formatPct(q.changeRate)} style={{ color: tone(q.change), fontSize: 11, fontWeight: "700", width: 58, textAlign: "right" }} />
            </FlexWidget>
          </FlexWidget>
        );
      })}
    </FlexWidget>
  );
}

export function BriefingWidget({ briefings, fetchedAt, error }: { briefings: LatestBriefing[]; fetchedAt: number; error: string | null }) {
  const latest = briefings
    .filter((b) => b.latest && b.latest.status === "ok")
    .sort((a, b) => (a.latest!.createdAt < b.latest!.createdAt ? 1 : -1))[0];
  const b = latest?.latest ?? null;
  const lines = b ? b.summary.split("\n").filter(Boolean).slice(0, 3) : [];
  return (
    <FlexWidget style={root}>
      <Header title="브리핑" subtitle={updatedLabel(fetchedAt)} />
      {b ? (
        <FlexWidget clickAction="OPEN_URI" clickActionData={{ uri: `${DEEP_LINK}briefings/${b.id}` }} style={{ width: "match_parent", flexDirection: "column", marginTop: 6, flexGap: 4 }}>
          <TextWidget text={`${latest!.name} · ${b.date.slice(5).replace("-", "/")} ${b.session === "morning" ? "오전" : "오후"}`} style={{ color: C.gold, fontSize: 11, fontWeight: "700" }} />
          {lines.map((line, i) => (
            <TextWidget key={i} text={`• ${line}`} maxLines={2} truncate="END" style={{ color: C.ink, fontSize: 12, lineHeight: 17 }} />
          ))}
        </FlexWidget>
      ) : (
        <TextWidget text={error ? `불러오기 실패: ${error}` : "아직 브리핑이 없습니다. 평일 08:30·16:00 에 생성됩니다."} style={{ color: C.muted, fontSize: 11, marginTop: 6 }} />
      )}
    </FlexWidget>
  );
}

export function AssetWidget({ stocks, showKrw, fetchedAt, error }: { stocks: RegisteredWithQuote[]; showKrw: boolean; fetchedAt: number; error: string | null }) {
  const t = totals(stocks, showKrw);
  return (
    <FlexWidget style={{ ...root, padding: 12, justifyContent: "center" }} clickAction="OPEN_APP">
      <FlexWidget style={{ width: "match_parent", flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <TextWidget text="◆ 총 평가" style={{ color: C.gold, fontSize: 10, fontWeight: "700" }} />
        <TextWidget text={updatedLabel(fetchedAt)} style={{ color: C.muted, fontSize: 9 }} />
      </FlexWidget>
      {t ? (
        <FlexWidget style={{ width: "match_parent", flexDirection: "column", marginTop: 2 }}>
          <TextWidget text={formatPrice(t.value, t.currency)} maxLines={1} style={{ color: C.ink, fontSize: 19, fontWeight: "800", adjustsFontSizeToFit: true }} />
          <TextWidget text={`오늘 ${formatPrice(t.day, t.currency, { sign: true })} · 총 ${formatPrice(t.profit, t.currency, { sign: true })}`} maxLines={1} truncate="END" style={{ color: tone(t.day), fontSize: 10, fontWeight: "700" }} />
        </FlexWidget>
      ) : (
        <TextWidget text={error ? "불러오기 실패" : "보유 종목 없음"} style={{ color: C.muted, fontSize: 11 }} />
      )}
    </FlexWidget>
  );
}
