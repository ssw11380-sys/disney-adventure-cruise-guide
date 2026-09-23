import { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import * as Notifications from "expo-notifications";
import React, { useEffect, useState } from "react";
import { Alert, Platform, Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { useApi, useNotificationMutations, useNotificationSettings } from "@/api/hooks";
import { disableLocalBriefingAlerts, enableLocalBriefingAlerts, isLocalModeEnabled, runBriefingCheck } from "@/lib/backgroundBriefings";
import { getStoredToken, PushSetupError, registerForPush, unregisterPush } from "@/lib/notifications";
import { font, radius, space, useTheme } from "@/theme";
import { Button, Card, Loading, Muted, Row, SectionTitle } from "./ui";

/**
 * 설정 > 알림 카드.
 * - "이 기기에서 알림 받기": 권한 요청 → Expo 푸시 토큰 → 서버 등록 (끄면 서버에서 삭제)
 *   FCM(Firebase) 이 아직 연결되지 않아 토큰 발급이 실패하면, 앱이 15~30분마다 서버를 확인해
 *   새 브리핑을 로컬 알림으로 띄우는 "백그라운드 확인" 방식으로 자동 전환한다.
 * - 오전/오후 시간(한국 시간)과 켜기/끄기, 평일만
 * - 테스트 알림
 */
export function NotificationSettingsCard() {
  const t = useTheme();
  const api = useApi();
  const settings = useNotificationSettings();
  const { updateSettings, sendTest } = useNotificationMutations();
  const [token, setToken] = useState<string | null>(null);
  const [localMode, setLocalMode] = useState(false);
  const [tokenLoaded, setTokenLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [showGuide, setShowGuide] = useState(false);

  useEffect(() => {
    let alive = true;
    void Promise.all([getStoredToken(), isLocalModeEnabled()]).then(([v, l]) => {
      if (alive) {
        setToken(v);
        setLocalMode(l);
        setTokenLoaded(true);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  const enabled = !!token || localMode;

  const toggleDevice = async (on: boolean) => {
    setBusy(true);
    setSetupError(null);
    try {
      if (on) {
        try {
          const tk = await registerForPush(api);
          setToken(tk);
          await disableLocalBriefingAlerts();
          setLocalMode(false);
        } catch (e) {
          // FCM 미설정(토큰 발급 실패)이면 백그라운드 확인 방식으로 대체
          if (e instanceof PushSetupError && e.code === "TOKEN") {
            await enableLocalBriefingAlerts();
            setLocalMode(true);
            setSetupError(null);
          } else throw e;
        }
      } else {
        await unregisterPush(api);
        await disableLocalBriefingAlerts();
        setToken(null);
        setLocalMode(false);
      }
    } catch (e) {
      setSetupError(e instanceof PushSetupError || e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const s = settings.data;
  const patch = (p: Parameters<typeof updateSettings.mutate>[0]) =>
    updateSettings.mutate(p, { onError: (e) => Alert.alert("저장 실패", e instanceof Error ? e.message : String(e)) });

  const pickTime = (key: "morningTime" | "afternoonTime") => {
    if (!s) return;
    const [h, m] = s[key].split(":").map(Number);
    const initial = new Date();
    initial.setHours(h ?? 8, m ?? 30, 0, 0);
    if (Platform.OS === "android") {
      DateTimePickerAndroid.open({
        value: initial,
        mode: "time",
        is24Hour: true,
        onChange: (event, date) => {
          if (event.type !== "set" || !date) return;
          patch({ [key]: `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}` });
        },
      });
    } else {
      Alert.prompt?.("시간 입력", "HH:MM (한국 시간)", (v) => {
        if (/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) patch({ [key]: v });
        else Alert.alert("형식 오류", "예: 08:30");
      }, "plain-text", s[key]);
    }
  };

  return (
    <Card>
      <SectionTitle>알림</SectionTitle>

      <View style={styles.switchRow}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: t.ink, fontSize: font.body }}>이 기기에서 알림 받기</Text>
          <Muted>
            {!tokenLoaded
              ? "확인 중…"
              : token
                ? "즉시 푸시 (Firebase 연결됨)"
                : localMode
                  ? "백그라운드 확인 (15~30분 지연)"
                  : "브리핑 생성 시 요약 알림"}
          </Muted>
        </View>
        <Switch value={enabled} onValueChange={(v) => void toggleDevice(v)} disabled={busy || !tokenLoaded} trackColor={{ true: t.accent }} />
      </View>
      {setupError ? <Text style={{ color: t.danger, fontSize: font.small }}>{setupError}</Text> : null}
      {localMode ? (
        <View style={{ gap: space.xs }}>
          <Pressable onPress={() => setShowGuide((v) => !v)} accessibilityRole="button">
            <Text style={{ color: t.accent, fontSize: font.small, fontWeight: "600" }}>{showGuide ? "접기" : "즉시 푸시 설정 방법"}</Text>
          </Pressable>
          {showGuide ? (
            <View style={{ gap: 4 }}>
              <Muted>1. console.firebase.google.com → 프로젝트 만들기 → Android 앱 추가, 패키지명 com.stockbriefing.app → google-services.json 다운로드</Muted>
              <Muted>2. expo.dev → 프로젝트 stock-briefing → Environment variables → 이름 GOOGLE_SERVICES_JSON, 타입 File 로 업로드 (환경: preview)</Muted>
              <Muted>3. Firebase 프로젝트 설정 → 서비스 계정 → 새 비공개 키 생성 → expo.dev → Credentials → Android → FCM V1 service account key 에 업로드</Muted>
              <Muted>4. 앱을 다시 빌드해 설치한 뒤 이 스위치를 껐다 켜면 “즉시 푸시”로 바뀝니다. 위 두 파일을 저에게 알려주시면 빌드는 제가 합니다.</Muted>
            </View>
          ) : null}
        </View>
      ) : null}

      {settings.isLoading ? (
        <Loading />
      ) : settings.isError ? (
        <Text style={{ color: t.danger, fontSize: font.small }}>{settings.error instanceof Error ? settings.error.message : "설정을 불러오지 못했습니다"}</Text>
      ) : s ? (
        <View style={{ gap: space.xs }}>
          <View style={styles.switchRow}>
            <Text style={{ color: t.ink, fontSize: font.body, flex: 1 }}>서버에서 푸시 보내기</Text>
            <Switch value={s.pushEnabled} onValueChange={(v) => patch({ pushEnabled: v })} trackColor={{ true: t.accent }} />
          </View>
          <TimeRow label="오전 브리핑" time={s.morningTime} enabled={s.morningEnabled} onToggle={(v) => patch({ morningEnabled: v })} onPick={() => pickTime("morningTime")} />
          <TimeRow label="오후 브리핑" time={s.afternoonTime} enabled={s.afternoonEnabled} onToggle={(v) => patch({ afternoonEnabled: v })} onPick={() => pickTime("afternoonTime")} />
          <View style={styles.switchRow}>
            <Text style={{ color: t.ink, fontSize: font.body, flex: 1 }}>평일만</Text>
            <Switch value={s.weekdaysOnly} onValueChange={(v) => patch({ weekdaysOnly: v })} trackColor={{ true: t.accent }} />
          </View>
          {s.schedule?.jobs.map((j) => (
            <Row key={j.session} label={`다음 ${j.session === "morning" ? "오전" : "오후"} 실행`} value={j.nextRun ? new Date(j.nextRun).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "short", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" }) : "-"} />
          ))}
        </View>
      ) : null}

      <Button
        title={localMode && !token ? "지금 확인해서 알림 테스트" : "테스트 알림 보내기"}
        variant="secondary"
        icon="notifications-outline"
        loading={sendTest.isPending || busy}
        onPress={() => {
          if (localMode && !token) {
            setBusy(true);
            void Notifications.scheduleNotificationAsync({
              content: { title: "주식 브리핑 테스트 알림", body: "알림이 정상적으로 도착했습니다.\n브리핑이 생성되면 이렇게 도착합니다.", sound: "default" },
              trigger: null,
            })
              .then(() => runBriefingCheck())
              .catch((e) => Alert.alert("테스트 실패", e instanceof Error ? e.message : String(e)))
              .finally(() => setBusy(false));
            return;
          }
          sendTest.mutate(undefined, {
            onSuccess: (r) => Alert.alert("전송 완료", `${r.sent}대 전송, ${r.failed}대 실패${r.disabled.length ? `, ${r.disabled.length}대 비활성화` : ""}`),
            onError: (e) => Alert.alert("전송 실패", e instanceof Error ? e.message : String(e)),
          });
        }}
      />
    </Card>
  );
}

function TimeRow({ label, time, enabled, onToggle, onPick }: { label: string; time: string; enabled: boolean; onToggle: (v: boolean) => void; onPick: () => void }) {
  const t = useTheme();
  return (
    <View style={styles.switchRow}>
      <Text style={{ color: t.ink, fontSize: font.body, flex: 1 }}>{label}</Text>
      <Pressable onPress={onPick} disabled={!enabled} accessibilityRole="button" accessibilityLabel={`${label} 시간 변경`} style={[styles.timeChip, { borderColor: t.line, backgroundColor: t.surfaceAlt, opacity: enabled ? 1 : 0.5 }]}>
        <Text style={{ color: t.ink, fontSize: font.body, fontVariant: ["tabular-nums"], fontWeight: "600" }}>{time}</Text>
      </Pressable>
      <Switch value={enabled} onValueChange={onToggle} trackColor={{ true: t.accent }} />
    </View>
  );
}

const styles = StyleSheet.create({
  switchRow: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: 4 },
  timeChip: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: 6 },
});
