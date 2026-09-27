import Ionicons from "@expo/vector-icons/Ionicons";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import React, { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useHealth } from "@/api/hooks";
import { Screen } from "@/components/Screen";
import { Button, Card, Muted } from "@/components/ui";
import { claimFirstRun, markFirstRun } from "@/lib/firstRun";
import { notifyLine, tossLine, WIDGET_STEPS, type Tone } from "@/lib/welcome";
import { font, layout, space, useTheme, type Theme } from "@/theme";

/**
 * 첫 실행 안내 한 화면 (3-24, 기능 플래그 firstRun — 새 사용자에게 한 번 저절로, 설정 > 정보에서 언제든 다시).
 * 세 가지만: 홈 화면 위젯 추가법 · 알림 권한 · 토스증권 연동 상태. 서버 주소·토큰 입력 단계는 없다 (토큰은 APK 에 있다).
 * '시작하기' 한 번(또는 뒤로 가기)으로 닫힌다. 열리는 순간 '본 것'으로 적고 이번 실행의 저절로 열기 몫도 가져가 다시 저절로 뜨지 않는다
 * (설정에서 먼저 열어도 — lib/firstRun claimFirstRun)
 */
export default function WelcomeScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const health = useHealth();
  const [perm, setPerm] = useState<{ status: string | null; canAskAgain: boolean } | null>(null);

  useEffect(() => {
    claimFirstRun();
    void markFirstRun("seen");
    let alive = true;
    Notifications.getPermissionsAsync()
      .then((p) => alive && setPerm({ status: p.status, canAskAgain: p.canAskAgain }))
      .catch(() => alive && setPerm({ status: null, canAskAgain: false }));
    return () => {
      alive = false;
    };
  }, []);

  const ask = async () => {
    try {
      const p = await Notifications.requestPermissionsAsync();
      setPerm({ status: p.status, canAskAgain: p.canAskAgain });
    } catch {
      setPerm({ status: null, canAskAgain: false });
    }
  };
  const done = () => (router.canGoBack() ? router.back() : router.replace("/"));
  const notify = perm ? notifyLine(perm.status, perm.canAskAgain) : { text: "확인 중…", tone: "muted" as Tone, ask: false };
  const toss = tossLine(health);

  return (
    <Screen
      disclaimer
      // 넓은 창(펼친 화면 933dp 등)에서 카드·버튼이 창 폭 전체로 늘어나지 않게 읽기 폭까지만 (휴대폰·접은 화면은 창이 더 좁아 그대로)
      contentStyle={styles.readingW}
      top={
        <View style={[styles.head, { paddingTop: insets.top + space.md, paddingLeft: insets.left + space.lg, paddingRight: insets.right + space.lg, backgroundColor: t.surface, borderBottomColor: t.line }]}>
          <View style={[styles.readingW, { gap: space.xs }]}>
            <Text style={{ color: t.ink, fontSize: font.title, fontWeight: "800" }} accessibilityRole="header">
              처음 사용 안내
            </Text>
            <Muted>세 가지만 확인하면 됩니다. 이 안내는 설정 &gt; 정보에서 다시 볼 수 있습니다.</Muted>
          </View>
        </View>
      }
      bottom={
        <View style={[styles.foot, { backgroundColor: t.surface, borderTopColor: t.line, paddingLeft: insets.left + space.lg, paddingRight: insets.right + space.lg }]}>
          <View style={styles.readingW}>
            <Button title="시작하기" icon="checkmark" onPress={done} accessibilityLabel="안내 닫고 시작하기" />
          </View>
        </View>
      }
    >
      <Section t={t} icon="apps-outline" title="1. 홈 화면에 위젯 추가">
        {WIDGET_STEPS.map((step, i) => (
          <View key={step} style={styles.step}>
            <Text style={[styles.stepNo, { color: t.accent }]} importantForAccessibility="no" accessibilityElementsHidden>
              {i + 1}
            </Text>
            <Text style={{ color: t.ink, fontSize: font.body, flex: 1 }} accessibilityLabel={`${i + 1}단계, ${step}`}>
              {step}
            </Text>
          </View>
        ))}
        <Muted>위젯은 앱을 열면 바로, 닫혀 있으면 장중 약 15분마다 새로 고칩니다.</Muted>
      </Section>
      <Section t={t} icon="notifications-outline" title="2. 알림">
        <StatusText t={t} text={notify.text} tone={notify.tone} />
        {notify.ask ? <Button title="알림 허용" icon="notifications-outline" variant="secondary" onPress={() => void ask()} /> : null}
      </Section>
      <Section t={t} icon="link-outline" title="3. 토스증권 연동">
        <StatusText t={t} text={toss.text} tone={toss.tone} />
        <Muted>연결되어 있으면 보유 종목이 자동으로 잔고에 들어옵니다. 자세한 상태는 설정 &gt; 토스증권 연동에 있습니다.</Muted>
      </Section>
    </Screen>
  );
}

function Section({ t, icon, title, children }: { t: Theme; icon: keyof typeof Ionicons.glyphMap; title: string; children: React.ReactNode }) {
  return (
    <Card>
      <View style={styles.sectionHead}>
        <Ionicons name={icon} size={font.title} color={t.accent} />
        <Text style={{ color: t.ink, fontSize: font.h2, fontWeight: "700", flexShrink: 1 }} accessibilityRole="header">
          {title}
        </Text>
      </View>
      {children}
    </Card>
  );
}

function StatusText({ t, text, tone }: { t: Theme; text: string; tone: Tone }) {
  const color = tone === "good" ? t.live : tone === "warn" ? t.warn : t.muted;
  return <Text style={{ color, fontSize: font.body, fontWeight: "600" }}>{text}</Text>;
}

const styles = StyleSheet.create({
  head: { gap: space.xs, paddingBottom: space.md, borderBottomWidth: StyleSheet.hairlineWidth },
  foot: { paddingVertical: space.sm, borderTopWidth: StyleSheet.hairlineWidth },
  sectionHead: { flexDirection: "row", alignItems: "center", gap: space.sm },
  step: { flexDirection: "row", alignItems: "flex-start", gap: space.sm },
  stepNo: { fontSize: font.body, fontWeight: "800", fontVariant: ["tabular-nums"] },
  // 읽기 폭 (layout.readableMax 720) 가운데 — 창이 더 좁으면 창 폭 그대로
  readingW: { width: "100%", maxWidth: layout.readableMax, alignSelf: "center" },
});

// 이 화면에서 난 렌더 오류는 앱을 끄지 않고 "다시 시도" 화면으로 (expo-router)
export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteError";
