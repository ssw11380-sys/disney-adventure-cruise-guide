import * as Haptics from "expo-haptics";
import React, { useMemo, useState } from "react";
import { StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { CandlestickChart } from "react-native-wagmi-charts";
import type { Candle, CandlePeriod, Currency } from "@/api/types";
import { formatPrice } from "@/lib/format";
import { font, radius, space, useTheme } from "@/theme";
import { Segmented } from "./ui";

/**
 * 캔들 차트 (react-native-wagmi-charts). 일/주/월 전환은 부모가 period 상태를 들고 있고,
 * 여기서는 데이터를 그리고 크로스헤어로 가격/날짜를 보여준다.
 */
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

  const data = useMemo(
    () =>
      (candles ?? []).map((c) => ({
        timestamp: Date.parse(`${c.date}T09:00:00+09:00`),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    [candles],
  );

  const last = candles?.at(-1);
  const first = candles?.[0];

  return (
    <View style={{ gap: space.md }}>
      <Segmented
        options={[
          { value: "D", label: "일봉" },
          { value: "W", label: "주봉" },
          { value: "M", label: "월봉" },
        ]}
        value={period}
        onChange={onPeriodChange}
      />
      {data.length < 2 ? (
        <View style={[styles.placeholder, { height, borderColor: t.line, backgroundColor: t.surfaceAlt }]}>
          <Text style={{ color: t.muted }}>{loading ? "차트 불러오는 중…" : "차트 데이터가 없습니다"}</Text>
        </View>
      ) : (
        <CandlestickChart.Provider data={data}>
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
                {first?.date} ~ {last?.date} · 종가 {formatPrice(last?.close, currency)} · 차트를 길게 누르면 값이 보입니다
              </Text>
            )}
          </View>
          <CandlestickChart width={chartWidth} height={height}>
            <CandlestickChart.Candles positiveColor={t.up} negativeColor={t.down} />
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
});
