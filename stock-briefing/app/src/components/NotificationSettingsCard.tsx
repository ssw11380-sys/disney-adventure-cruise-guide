import { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import React, { useEffect, useState } from "react";
import { Alert, Platform, Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { useApi, useNotificationMutations, useNotificationSettings } from "@/api/hooks";
import { getStoredToken, PushSetupError, registerForPush, unregisterPush } from "@/lib/notifications";
import { font, radius, space, useTheme } from "@/theme";
import { Button, Card, Loading, Muted, Row, SectionTitle } from "./ui";

/**
 * 설정 > 알림 카드.
 * - "이 기기에서 알림 받기": 권한 요청 → Expo 푸시 토큰 → 서버 등록 (끄면 서버에서 삭제)
 * - 오전/오후 시간(한국 시간)과 켜기/끄기, 평일만
 * - 테스트 알림
 */
export function NotificationSettingsCard() {
  const t = useTheme();
  const api = useApi();
  const settings = useNotificationSettings();
  const { updateSettings, sendTest } = useNotificationMutations();
  const [token, setToken] = useState<string | null>(null);
  const [tokenLoaded, setTokenLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void getStoredToken().then((v) => {
      if (alive) {
        setToken(v);
        setTokenLoaded(true);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  const toggleDevice = async (on: boolean) => {
    setBusy(true);
    setSetupError(null);
    try {
      if (on) {
        const tk = await registerForPush(api);
        setToken(tk);
      } else {
        await unregisterPush(api);
        setToken(null);
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
          <Muted>{!tokenLoaded ? "확인 중…" : token ? `등록됨 · ${token.slice(0, 24)}…` : "브리핑이 생성되면 요약 3줄이 푸시로 옵니다"}</Muted>
        </View>
        <Switch value={!!token} onValueChange={(v) => void toggleDevice(v)} disabled={busy || !tokenLoaded} trackColor={{ true: t.accent }} />
      </View>
      {setupError ? <Text style={{ color: t.danger, fontSize: font.small }}>{setupError}</Text> : null}

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
            <Text style={{ color: t.ink, fontSize: font.body, flex: 1 }}>평일만 (월~금)</Text>
            <Switch value={s.weekdaysOnly} onValueChange={(v) => patch({ weekdaysOnly: v })} trackColor={{ true: t.accent }} />
          </View>
          {s.schedule?.jobs.map((j) => (
            <Row key={j.session} label={`다음 ${j.session === "morning" ? "오전" : "오후"} 실행`} value={j.nextRun ? new Date(j.nextRun).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "short", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" }) : "-"} />
          ))}
          <Muted>시간은 한국 시간 기준이며 브리핑 생성 시각이자 알림 시각입니다. 변경 즉시 서버 스케줄에 반영됩니다.</Muted>
        </View>
      ) : null}

      <Button
        title="테스트 알림 보내기"
        variant="secondary"
        icon="notifications-outline"
        loading={sendTest.isPending}
        onPress={() =>
          sendTest.mutate(undefined, {
            onSuccess: (r) => Alert.alert("전송 완료", `${r.sent}대 전송, ${r.failed}대 실패${r.disabled.length ? `, ${r.disabled.length}대 비활성화` : ""}`),
            onError: (e) => Alert.alert("전송 실패", e instanceof Error ? e.message : String(e)),
          })
        }
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
