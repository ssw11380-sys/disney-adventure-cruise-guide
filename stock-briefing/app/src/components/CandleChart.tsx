import * as Haptics from "expo-haptics";
import React, { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Polyline, Svg } from "react-native-svg";
import { CandlestickChart } from "react-native-wagmi-charts";
import type { Candle, CandlePeriod, Currency } from "@/api/types";
import { formatPrice } from "@/lib/format";
import { font, radius, space, useTheme } from "@/theme";
import { Segmented } from "./ui";

/**
 * 캔들 차트 (react-native-wagmi-charts) + 이동평균선 + 과거 구간 이동.
 *  - 부모는 긴 시계열(일봉 최대 800개 등)을 넘기고, 여기서 보이는 구간(window)과 위치(offset)를 관리한다.
 *  - 이동평균은 전체 시계열로 계산해 두고 보이는 구간만 그린다 (구간 첫 봉부터 바로 선이 보이도록).
 *  - 이평선은 wagmi 캔들과 같은 좌표계(x = index*step + step/2, y = 도메인 선형 보간)로 SVG 위에 겹쳐 그린다.
 */

const MA_PERIODS = [5, 20, 60, 120] as const;
const MA_COLORS: Record<(typeof MA_PERIODS)[number], string> = { 5: "#22c55e", 20: "#ef4444", 60: "#f59e0b", 120: "#8b5cf6" };
const WINDOWS: Record<CandlePeriod, number[]> = { D: [60, 120, 250], W: [52, 104, 260], M: [36, 60, 120] };
const UNIT: Record<CandlePeriod, string> = { D: "일", W: "주", M: "월" };

/** 단순 이동평균. 앞쪽 period-1 개는 null */
export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function CandleChart({
  candles,
  period,
  onPeriodChange,
  loading,
  currency = "KRW",
}: {
  candles: Candle[] | undefined;
  period: CandlePeriod;
  onPeriodChange: (p: CandlePeriod) => void;
  loading?: boolean;
  currency?: Currency;
}) {
  const t = useTheme();
  const { width } = useWindowDimensions();
  const chartWidth = Math.min(width - space.lg * 2 - space.lg * 2, 640);
  const height = Math.round(chartWidth * 0.55);
  const [active, setActive] = useState(false);
  const [windowIdx, setWindowIdx] = useState(1);
  const [offset, setOffset] = useState(0); // 최신에서 몇 봉 앞으로 갔는지
  const [hidden, setHidden] = useState<Set<number>>(new Set());

  const all = useMemo(() => candles ?? [], [candles]);
  const windowSize = Math.min(WINDOWS[period][windowIdx] ?? 120, Math.max(all.length, 1));
  const maxOffset = Math.max(all.length - windowSize, 0);
  const off = Math.min(offset, maxOffset);
  const end = all.length - off;
  const start = Math.max(end - windowSize, 0);
  const visible = useMemo(() => all.slice(start, end), [all, start, end]);

  const mas = useMemo(() => {
    const closes = all.map((c) => c.close);
    return MA_PERIODS.map((p) => ({ period: p, values: sma(closes, p).slice(start, end) }));
  }, [all, start, end]);

  const data = useMemo(
    () =>
      visible.map((c) => ({
        timestamp: Date.parse(`${c.date}T09:00:00+09:00`),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    [visible],
  );

  // wagmi 와 같은 도메인 계산(±2.5% 여백)에 이평선 값까지 넣어 선이 잘리지 않게 한다
  const domain = useMemo<[number, number] | undefined>(() => {
    if (visible.length === 0) return undefined;
    const vals: number[] = [];
    for (const c of visible) vals.push(c.high, c.low);
    for (const m of mas) if (!hidden.has(m.period)) for (const v of m.values) if (v !== null) vals.push(v);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const pad = (max - min) * 0.025 || 1;
    return [min - pad, max + pad];
  }, [visible, mas, hidden]);

  const step = visible.length ? chartWidth / visible.length : 0;
  const yOf = (v: number) => (domain ? height - ((v - domain[0]) / (domain[1] - domain[0])) * height : 0);

  const last = visible.at(-1);
  const first = visible[0];
  const change = (p: CandlePeriod) => {
    setOffset(0);
    onPeriodChange(p);
  };
  const shift = (dir: -1 | 1) => setOffset((o) => Math.max(0, Math.min(maxOffset, o + dir * Math.round(windowSize / 2))));

  return (
    <View style={{ gap: space.sm }}>
      <Segmented
        options={[
          { value: "D", label: "일봉" },
          { value: "W", label: "주봉" },
          { value: "M", label: "월봉" },
        ]}
        value={period}
        onChange={change}
      />
      <View style={styles.toolbar}>
        <View style={styles.chips}>
          {WINDOWS[period].map((w, i) => (
            <Pressable key={w} onPress={() => setWindowIdx(i)} accessibilityRole="button" style={[styles.chip, { borderColor: i === windowIdx ? t.accent : t.line, backgroundColor: i === windowIdx ? t.surfaceAlt : "transparent" }]}>
              <Text style={{ color: i === windowIdx ? t.ink : t.muted, fontSize: font.tiny }}>{w}{UNIT[period]}</Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.chips}>
          <Pressable onPress={() => shift(1)} disabled={off >= maxOffset} accessibilityLabel="과거로" style={[styles.chip, { borderColor: t.line, opacity: off >= maxOffset ? 0.4 : 1 }]}>
            <Text style={{ color: t.ink, fontSize: font.tiny }}>◀ 과거</Text>
          </Pressable>
          <Pressable onPress={() => shift(-1)} disabled={off === 0} accessibilityLabel="최신으로" style={[styles.chip, { borderColor: t.line, opacity: off === 0 ? 0.4 : 1 }]}>
            <Text style={{ color: t.ink, fontSize: font.tiny }}>최신 ▶</Text>
          </Pressable>
        </View>
      </View>

      {data.length < 2 ? (
        <View style={[styles.placeholder, { height, borderColor: t.line, backgroundColor: t.surfaceAlt }]}>
          <Text style={{ color: t.muted }}>{loading ? "차트 불러오는 중…" : "차트 데이터가 없습니다"}</Text>
        </View>
      ) : (
        <CandlestickChart.Provider data={data} valueRangeY={domain}>
          <View style={styles.readout}>
            {active ? (
              <>
                <CandlestickChart.DatetimeText
                  style={[styles.readoutText, { color: t.muted }]}
                  format={({ value }) => {
                    "worklet";
                    const d = new Date(value);
                    return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
                  }}
                />
                <View style={styles.readoutRow}>
                  <ReadoutPrice label="시" type="open" />
                  <ReadoutPrice label="고" type="high" />
                  <ReadoutPrice label="저" type="low" />
                  <ReadoutPrice label="종" type="close" />
                </View>
              </>
            ) : (
              <Text style={[styles.readoutText, { color: t.muted }]}>
                {first?.date} ~ {last?.date} · 종가 {formatPrice(last?.close, currency)}
                {off > 0 ? ` · 최신보다 ${off}${UNIT[period]} 전` : ""} · 길게 누르면 값이 보입니다
              </Text>
            )}
          </View>
          <CandlestickChart width={chartWidth} height={height}>
            <CandlestickChart.Candles positiveColor={t.up} negativeColor={t.down} />
            <View pointerEvents="none" style={StyleSheet.absoluteFill}>
              <Svg width={chartWidth} height={height}>
                {mas.map((m) => {
                  if (hidden.has(m.period)) return null;
                  const points = m.values.map((v, i) => (v === null ? null : `${(i * step + step / 2).toFixed(1)},${yOf(v).toFixed(1)}`)).filter(Boolean).join(" ");
                  return points ? <Polyline key={m.period} points={points} fill="none" stroke={MA_COLORS[m.period]} strokeWidth={1.2} /> : null;
                })}
              </Svg>
            </View>
            <CandlestickChart.Crosshair
              color={t.muted}
              onCurrentXChange={() => {
                if (!active) {
                  setActive(true);
                  void Haptics.selectionAsync();
                }
              }}
            />
          </CandlestickChart>
          <View style={styles.legend}>
            {mas.map((m) => {
              const v = m.values.at(-1) ?? null;
              const on = !hidden.has(m.period);
              return (
                <Pressable
                  key={m.period}
                  onPress={() =>
                    setHidden((h) => {
                      const n = new Set(h);
                      if (n.has(m.period)) n.delete(m.period);
                      else n.add(m.period);
                      return n;
                    })
                  }
                  accessibilityRole="button"
                  accessibilityLabel={`${m.period}${UNIT[period]} 이동평균 ${on ? "숨기기" : "보이기"}`}
                  style={[styles.legendItem, { opacity: on ? 1 : 0.35 }]}
                >
                  <View style={[styles.swatch, { backgroundColor: MA_COLORS[m.period] }]} />
                  <Text style={{ color: t.muted, fontSize: font.tiny, fontVariant: ["tabular-nums"] }}>
                    {m.period}
                    {UNIT[period]} {v !== null ? formatPrice(v, currency) : "-"}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </CandlestickChart.Provider>
      )}
    </View>
  );
}

function ReadoutPrice({ label, type }: { label: string; type: "open" | "high" | "low" | "close" }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", gap: 4, alignItems: "baseline" }}>
      <Text style={{ color: t.muted, fontSize: font.tiny }}>{label}</Text>
      <CandlestickChart.PriceText
        type={type}
        precision={0}
        format={({ value }) => {
          "worklet";
          return `${Number(value).toLocaleString("ko-KR")}`;
        }}
        style={[styles.readoutText, { color: t.ink }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  placeholder: { alignItems: "center", justifyContent: "center", borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth },
  readout: { minHeight: 36, justifyContent: "center", gap: 2 },
  readoutRow: { flexDirection: "row", gap: space.md, flexWrap: "wrap" },
  readoutText: { fontSize: font.small, fontVariant: ["tabular-nums"] },
  toolbar: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: space.xs },
  chips: { flexDirection: "row", gap: space.xs },
  chip: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  legend: { flexDirection: "row", flexWrap: "wrap", gap: space.md, marginTop: space.xs },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 4 },
  swatch: { width: 10, height: 3, borderRadius: 2 },
});
