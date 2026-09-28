import { router } from "expo-router";
import React, { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useFeature } from "@/api/hooks";
import { Screen } from "@/components/Screen";
import { Button, Card, Empty, Muted, Toggle } from "@/components/ui";
import { useChartPrefs, useMaLines } from "@/lib/chartPrefs";
import { draftOf, linesOfDraft, maColorName, MA_COLORS, periodErrors, resetDraft, type MaDraft, type MaLine } from "@/lib/maLines";
import { font, fontCap, radius, space, touch, useFontScale, useTheme } from "@/theme";
import { foldScreens } from "@/tokens";

/**
 * 이동평균선 기간·색 (3-39, 기능 플래그 maCustom — 차트 칩 '설정'·설정 > 표시 '차트 이동평균선'에서 온다).
 * 선 6개마다 기간 입력(2~240) · 보이기 스위치 · 색 8개(44×44 단추 4개씩 두 줄). 고친 값은 이 화면 안 초안에만 두고 [저장]을 눌러야
 * 기기에 적는다(lib/chartPrefs useMaLines — 종목·지수 상세와 전체 화면 차트가 같은 캐시를 들어 돌아가면 바로 새 선). 저장하지 않고 나가면 버린다.
 * 기간은 입력칸 글자가 원본이다: 오류(범위·겹침)와 저장할 기간을 늘 지금 보이는 글자로 계산한다 (lib/maLines periodErrors · linesOfDraft)
 */

/** 기간 입력칸 폭 (글자 100%). 큰 글씨는 글자 배율(최대 fontCap.row)만큼 넓힌다 — 100% 64 · 130% 83 · 140% 이상 90 */
const INPUT_W = 64;
/** 색 단추 안 테두리 원 · 색 원 지름 (단추 자체는 44×44 = touch.min) */
const RING = 36;
const SWATCH = 28;
/** 선 이름 앞 색 점 지름 */
const DOT = 10;
/** 색 단추 두 줄 (차례 0~3 / 4~7) */
const SWATCH_ROWS = [0, 1].map((r) => Array.from({ length: MA_COLORS / 2 }, (_, c) => r * (MA_COLORS / 2) + c));

export default function ChartLinesScreen() {
  const on = useFeature("maCustom", false);
  // 차트 칩·설정 줄은 플래그가 켜졌을 때만 있어, 꺼진 채 들어올 길은 주소(딥링크)뿐 — 안내 하나만 ('설정 열기' 가지 없음)
  if (!on)
    return (
      <Screen>
        <Empty title="지금은 이동평균선 설정을 쓸 수 없습니다" hint="차트 아래 이동평균 칩(5·10·20·60·120·200)으로 켜고 끌 수 있습니다." />
      </Screen>
    );
  return <ChartLinesBody />;
}

interface DraftState {
  /** 초안을 만든 저장값(또는 처음 선) — 늦게 읽힌 저장값으로 바뀌었는지 볼 때 */
  from: MaLine[];
  draft: MaDraft;
  /** 사용자가 손댔는지 (손댄 뒤에는 늦게 온 저장값으로 덮지 않는다) */
  touched: boolean;
}

function ChartLinesBody() {
  const t = useTheme();
  const [prefs] = useChartPrefs();
  const [lines, setLines] = useMaLines(prefs.maPeriods, true);
  const scale = useFontScale(fontCap.row);
  const [state, setState] = useState<DraftState>(() => ({ from: lines, draft: draftOf(lines), touched: false }));
  // 저장값이 늦게 읽혔으면(저장소가 늦게 답함 · chartPrefs.v1 이 늦게 읽혀 처음 선이 바뀜) 손대기 전일 때만 초안을 다시 채운다
  // (렌더 중 이전 값과 비교해 상태를 고치는 방법 — CandleChart 의 stale 처리처럼)
  const stale = !state.touched && state.from !== lines;
  if (stale) setState({ from: lines, draft: draftOf(lines), touched: false });
  const draft = stale ? draftOf(lines) : state.draft;
  // 오류는 그릴 때마다 지금 글자 6개로 새로 (겹친 두 칸 모두 오류 — 서로를 가리킴)
  const errors = periodErrors(draft.texts);
  const blocked = errors.some((e) => e !== null);
  const edit = (fn: (d: MaDraft) => MaDraft) => setState((s) => ({ from: s.from, draft: fn(s.draft), touched: true }));
  const setText = (i: number, text: string) => edit((d) => ({ ...d, texts: d.texts.map((x, j) => (j === i ? text : x)) }));
  const setColor = (i: number, color: number) => edit((d) => ({ ...d, colors: d.colors.map((x, j) => (j === i ? color : x)) }));
  const setOn = (i: number, v: boolean) => edit((d) => ({ ...d, ons: d.ons.map((x, j) => (j === i ? v : x)) }));
  const save = () => {
    // 저장할 기간도 누르는 순간의 글자에서 (입력칸에 보이는 값 = 저장되는 값)
    const next = linesOfDraft(draft);
    if (!next) return;
    setLines(next);
    if (router.canGoBack()) router.back();
    else router.dismissTo("/");
  };
  const inputW = Math.round(INPUT_W * scale);
  return (
    <Screen>
      <Card>
        <View style={styles.column}>
          <Muted>선 6개의 기간과 색을 정합니다. 기간은 2~240 — 일봉은 일, 주봉은 주, 월봉은 달, 분봉은 봉 수입니다. 저장하면 종목·지수 상세와 전체 화면 차트에 같이 쓰이고 이 기기에 남습니다.</Muted>
          {draft.texts.map((text, i) => {
            const name = `선 ${i + 1}`;
            const error = errors[i] ?? null;
            const color = draft.colors[i] ?? i;
            return (
              <View key={`slot${i}`} style={[styles.slot, { borderTopColor: t.line }]}>
                <View style={styles.head}>
                  <View style={[styles.dot, { backgroundColor: t.chart.maPalette[color] }]} />
                  <Text style={[styles.name, { color: t.ink }]}>{name}</Text>
                  <TextInput
                    value={text}
                    onChangeText={(v) => setText(i, v)}
                    keyboardType="number-pad"
                    maxLength={3}
                    maxFontSizeMultiplier={fontCap.row}
                    accessibilityLabel={`${name} 기간`}
                    {...(error ? { accessibilityHint: error } : null)}
                    style={[styles.input, { width: inputW, color: t.ink, backgroundColor: t.surfaceAlt, borderColor: error ? t.danger : t.line }]}
                  />
                  <View style={styles.grow} />
                  <Toggle value={draft.ons[i] ?? false} onValueChange={(v) => setOn(i, v)} accessibilityLabel={`${name} 보이기`} />
                </View>
                {error ? (
                  <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ color: t.danger, fontSize: font.small }}>
                    {error}
                  </Text>
                ) : null}
                <View style={styles.swatches}>
                  {SWATCH_ROWS.map((row, r) => (
                    <View key={`row${r}`} style={styles.swatchRow}>
                      {row.map((k) => {
                        const checked = color === k;
                        return (
                          <Pressable
                            key={k}
                            onPress={() => setColor(i, k)}
                            accessibilityRole="radio"
                            accessibilityLabel={`${name} 색 ${maColorName(t.dark, k)}`}
                            accessibilityState={{ checked }}
                            style={styles.swatchBtn}
                          >
                            <View style={[styles.ring, { borderColor: checked ? t.ink : "transparent" }]}>
                              <View style={[styles.swatch, { backgroundColor: t.chart.maPalette[k] }]} />
                            </View>
                          </Pressable>
                        );
                      })}
                    </View>
                  ))}
                </View>
              </View>
            );
          })}
          <View style={styles.buttons}>
            <Button title="처음 값으로" variant="secondary" style={styles.grow} onPress={() => edit(resetDraft)} />
            <Button title="저장" style={styles.grow} disabled={blocked} onPress={save} />
          </View>
          <Muted style={{ fontSize: font.tiny }}>처음 값으로는 기간·색만 되돌립니다(켜고 끈 것은 그대로). 저장하지 않고 나가면 바꾼 것은 버립니다.</Muted>
        </View>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  // 내용 틀: 설정 카드 한 칸과 같은 최대 폭(400)을 가운데 — 펼친 화면에서 선 이름·입력칸과 스위치가 창 끝까지 벌어지지 않게
  column: { width: "100%", maxWidth: foldScreens.settingsColMax, alignSelf: "center", gap: space.sm },
  slot: { gap: space.xs, paddingTop: space.sm, borderTopWidth: StyleSheet.hairlineWidth },
  // 첫 줄: 줄바꿈 없이 (폭 360 · 글자 200% 에서도 점 + '선 6' + 입력칸 90 + 스위치가 한 줄)
  head: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: touch.min },
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2 },
  name: { fontSize: font.body, fontWeight: "600", flexShrink: 0 },
  input: { minHeight: touch.min, paddingHorizontal: space.sm, fontSize: font.body, textAlign: "right", borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm },
  grow: { flex: 1 },
  swatches: { gap: space.xs },
  swatchRow: { flexDirection: "row", gap: space.xs },
  // 색 단추: 보이는 틀이 곧 44×44 (hitSlop 없음 — 옆 단추와 누르는 곳이 겹치지 않는다)
  swatchBtn: { width: touch.min, minHeight: touch.min, alignItems: "center", justifyContent: "center" },
  ring: { width: RING, height: RING, borderRadius: RING / 2, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  swatch: { width: SWATCH, height: SWATCH, borderRadius: SWATCH / 2 },
  buttons: { flexDirection: "row", gap: space.sm },
});

// 이 화면에서 난 렌더 오류는 앱을 끄지 않고 "다시 시도" 화면으로 (expo-router)
export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteError";
