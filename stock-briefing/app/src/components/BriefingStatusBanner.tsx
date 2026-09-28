import Ionicons from "@expo/vector-icons/Ionicons";
import React, { useEffect } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useBriefingStatus } from "@/api/hooks";
import type { BriefingStatusProblem } from "@/api/types";
import { problemSpeech, statusView, type StatusView } from "@/lib/briefingStatus";
import { useNow } from "@/lib/useNow";
import { font, slopFor, space, touch, useTheme } from "@/theme";
import { Card } from "./ui";

/**
 * 브리핑 탭의 안내 자리 (플래그 briefingStatus 가 켜졌을 때만 탭이 그린다 — 꺼지면 탭이 예전 안내를 그대로 둔다).
 * 서버 상태를 받으면 새 안내(문제가 없으면 아무것도 안 보임), 받는 중이면 비움, 못 받으면(404·연결 오류) 예전 안내(fallback).
 * refetchRef: 탭의 당겨서 새로고침이 이 상태도 다시 받게 (탭이 훅을 부르지 않아도 되게)
 */
export function BriefingStatusSlot({
  fallback,
  onOpen,
  role,
  refetchRef,
  nowButton = false,
}: {
  fallback: React.ReactNode;
  onOpen: (p: BriefingStatusProblem) => void;
  role: "link" | "button";
  refetchRef?: React.MutableRefObject<(() => Promise<unknown>) | null>;
  /** 브리핑이 하나도 없어 빈 화면의 '지금 만들기'가 수동 생성을 맡는다 (emptyGuide) — 안내가 그 버튼을 가리킨다 */
  nowButton?: boolean;
}) {
  const q = useBriefingStatus(true);
  // '다음 브리핑(16:00)'·'내일 08:30' 을 고르는 시각 (1분마다)
  const now = useNow(60_000);
  const { refetch } = q;
  useEffect(() => {
    if (!refetchRef) return;
    refetchRef.current = () => refetch();
    return () => {
      refetchRef.current = null;
    };
  }, [refetchRef, refetch]);
  if (q.data === null || (q.data === undefined && q.isError)) return <>{fallback}</>;
  const view = statusView(q.data, now, { nowButton });
  return view ? <BriefingStatusBanner view={view} onOpen={onOpen} role={role} /> : null;
}

/**
 * 브리핑 늦음·실패 안내 한 덩어리 (브리핑 3차 2, 플래그 briefingStatus). 차분한 카드 + 왼쪽 가는 막대(늦음·일부·빠짐·만드는 중 = warn,
 * 모두 못 만듦·모델 없음 = danger), 아이콘, 첫 줄(굵게) → 둘째 줄(글 또는 누르는 이름 5개까지 · '외 N종목') → 작은 글.
 *  - 화면 읽기: 첫 묶음이 한 문장('브리핑 안내, …' — 작은 글까지 담는다), 이름마다 따로 링크('테슬라 오전 브리핑, 만들지 못함, 열기'). 작은 글은 두 번 읽지 않게 숨긴다
 *  - 이름은 누르는 곳 44dp 이상 — 보이는 칸은 글자 높이(+위아래 여백)만, 모자란 만큼은 hitSlop 으로 넓힌다(짧은 이름 뒤가 벌어지거나
 *    두 줄로 넘어간 이름 사이가 빈 줄처럼 보이지 않게). 넓이가 모자라면 '이름 ·' 묶음째 다음 줄로 (글자 130·200% 에서도 잘리지 않게 — 줄 수 제한 없음)
 *  - role: 폰·카드 격자는 link(새 화면), 2단은 button(오른쪽 칸에서 고르기)
 */
export function BriefingStatusBanner({ view, onOpen, role = "link" }: { view: StatusView; onOpen: (p: BriefingStatusProblem) => void; role?: "link" | "button" }) {
  const t = useTheme();
  const bar = view.tone === "danger" ? t.danger : t.warn;
  return (
    <Card style={{ borderLeftWidth: 3, borderLeftColor: bar }}>
      <View style={styles.row}>
        <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={styles.icon}>
          <Ionicons name="information-circle-outline" size={18} color={bar} />
        </View>
        <View style={styles.body}>
          <View accessible accessibilityLabel={view.speech} style={styles.head}>
            <Text style={[styles.title, { color: t.ink }]}>{view.title}</Text>
            {view.line ? <Text style={[styles.line, { color: t.sub }]}>{view.line}</Text> : null}
          </View>
          {view.names.length ? (
            <View style={styles.names}>
              {view.names.map((p, i) => (
                <View key={p.code} style={styles.nameUnit}>
                  {p.briefingId !== null ? (
                    <Pressable onPress={() => onOpen(p)} accessibilityRole={role} accessibilityLabel={problemSpeech(p, view.session)} hitSlop={nameSlop(p.name)} style={styles.nameTap}>
                      <Text style={[styles.name, styles.link, { color: t.accent }]}>{p.name}</Text>
                    </Pressable>
                  ) : (
                    <View style={styles.nameTap} accessible accessibilityLabel={`${p.name} ${view.session} 브리핑, 만들지 못함`}>
                      <Text style={[styles.name, { color: t.ink }]}>{p.name}</Text>
                    </View>
                  )}
                  {i < view.names.length - 1 || view.more ? (
                    <Text importantForAccessibility="no" accessibilityElementsHidden style={[styles.sep, { color: t.muted }]}>
                      ·
                    </Text>
                  ) : null}
                </View>
              ))}
              {view.more ? (
                <View style={styles.moreBox}>
                  <Text style={[styles.more, { color: t.muted }]}>외 {view.more}종목</Text>
                </View>
              ) : null}
            </View>
          ) : null}
          {view.small ? (
            <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={styles.small}>
              {view.small.parts.length ? (
                <View style={styles.chunks}>
                  {view.small.parts.map((p, i) => (
                    <Text key={i} style={[styles.smallText, { color: t.muted }]}>
                      {i < view.small!.parts.length - 1 ? `${p} ·` : p}
                    </Text>
                  ))}
                </View>
              ) : null}
              {view.small.note ? <Text style={[styles.smallText, { color: t.muted }]}>{view.small.note}</Text> : null}
            </View>
          ) : null}
        </View>
      </View>
    </Card>
  );
}

/** 이름 칸의 보이는 크기 (본문 14 한 줄 + 위아래 여백) — 44×44 까지 모자란 만큼은 hitSlop */
export const NAME_H = 28;
export const NAME_MIN_W = 28;
/** 좌우 hitSlop 상한: 이름 사이 거리(간격 8 + 구분점 약 4 + 간격 8 = 20)의 절반 — 이웃 이름과 겹치지 않게 */
const NAME_SIDE_MAX = 10;
/**
 * 이름 글자 폭 어림 — 일부러 좁게(100% 기준 한글 12, 그 밖 7 — 실제는 약 13·8 이상): 좁게 어림할수록 좌우 hitSlop 이 넓어져
 * 누르는 곳이 44 아래로 줄지 않는다. 글자가 커지면 실제 폭이 더 넓어 누르는 곳도 넓어진다
 */
const nameWidth = (name: string) => [...name].reduce((w, c) => w + (c.charCodeAt(0) >= 0x1100 ? 12 : 7), 0);

/** 이름을 누르는 곳이 44×44 이상이 되게 넓히는 hitSlop (위아래 8, 좌우는 짧은 이름만 — '이튼' 8, '테슬라' 4, 긴 이름 0) */
export function nameSlop(name: string): { top: number; bottom: number; left: number; right: number } {
  const v = slopFor(NAME_H);
  const side = Math.min(NAME_SIDE_MAX, Math.max(0, Math.ceil((touch.min - Math.max(nameWidth(name), NAME_MIN_W)) / 2)));
  return { ...v, left: side, right: side };
}

/** 이름을 누르는 곳의 크기 어림 (테스트·설명용): 보이는 칸 + hitSlop */
export function nameTarget(name: string): { width: number; height: number } {
  const s = nameSlop(name);
  return { width: Math.max(nameWidth(name), NAME_MIN_W) + s.left + s.right, height: NAME_H + s.top + s.bottom };
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "flex-start", gap: space.sm },
  // 아이콘을 첫 줄 글자 가운데에 맞춘다 (본문 14 × 줄 20)
  icon: { height: 20, justifyContent: "center" },
  body: { flex: 1, gap: space.xxs },
  head: { gap: space.xxs },
  title: { fontSize: font.body, fontWeight: "700", lineHeight: 20 },
  line: { fontSize: font.small, lineHeight: 17 },
  // 이름 사이는 고르게 (간격 8 · 구분점 · 간격 8), 두 줄로 넘어가면 줄 사이 8
  names: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: space.sm, rowGap: space.sm },
  // '이름 ·' 한 묶음 — 줄은 묶음 사이에서만 바뀐다
  nameUnit: { flexDirection: "row", alignItems: "center", columnGap: space.sm },
  // 보이는 칸은 촘촘하게 (누르는 곳 44×44 는 nameSlop). 글자가 커지면 칸도 따라 커진다 (최소만 정함)
  nameTap: { minHeight: NAME_H, minWidth: NAME_MIN_W, justifyContent: "center", alignItems: "center" },
  moreBox: { minHeight: NAME_H, justifyContent: "center" },
  name: { fontSize: font.body, fontWeight: "600" },
  link: { textDecorationLine: "underline" },
  sep: { fontSize: font.body },
  more: { fontSize: font.small },
  small: { gap: space.xxs },
  chunks: { flexDirection: "row", flexWrap: "wrap", columnGap: space.xs },
  smallText: { fontSize: font.small, lineHeight: 17 },
});
