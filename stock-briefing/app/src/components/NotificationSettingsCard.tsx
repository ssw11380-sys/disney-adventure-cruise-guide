import { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import * as Notifications from "expo-notifications";
import React, { useEffect, useState } from "react";
import { Alert, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useApi, useNotificationMutations, useNotificationSettings, useRegisteredStocks } from "@/api/hooks";
import { quietWarnings } from "@/lib/briefingDigest";
import { disableLocalBriefingAlerts, enableLocalBriefingAlerts, isLocalModeEnabled, runBriefingCheck } from "@/lib/backgroundBriefings";
import { getStoredToken, PushSetupError, registerForPush, unregisterPush } from "@/lib/notifications";
import { font, radius, slopFor, space, touch, useTheme } from "@/theme";
import { Button, Card, Loading, Muted, Row, SectionTitle, Toggle } from "./ui";

/**
 * 설정 > 알림 카드.
 * - "이 기기에서 알림 받기": 권한 요청 → Expo 푸시 토큰 → 서버 등록 (끄면 서버에서 삭제)
 *   FCM(Firebase) 이 아직 연결되지 않아 토큰 발급이 실패하면, 앱이 15~30분마다 서버를 확인해
 *   새 브리핑을 로컬 알림으로 띄우는 "백그라운드 확인" 방식으로 자동 전환한다.
 * - 오전/오후 시간(한국 시간)과 켜기/끄기, 평일만
 * - 3-19 서버부터: 조용한 시간(기본 22~07시), 종목별 알림 끄기. 브리핑 알림은 세션마다 1건으로 묶인다
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
  const [showMuted, setShowMuted] = useState(false);
  // 종목 목록은 "종목별 알림"을 펼쳤을 때만 받는다
  const stocks = useRegisteredStocks(showMuted);

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

  /** 이 기기 알림 켜기·끄기. 성공하면 true */
  const toggleDevice = async (on: boolean): Promise<boolean> => {
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
      return true;
    } catch (e) {
      setSetupError(e instanceof PushSetupError || e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const s = settings.data;
  const toggleAlerts = async (on: boolean) => {
    // 이미 이 기기가 등록돼 있고 서버 발송만 꺼진 경우(예전 스위치 2개 시절)는 기기를 다시 등록하지 않는다
    const ok = on && enabled ? true : await toggleDevice(on);
    // 켜기에 성공했을 때만 서버 발송도 켠다. 설정을 아직 못 받았으면 받아 온 뒤에 판단한다
    if (on && ok) {
      const latest = s ?? (await settings.refetch()).data;
      // 설정을 끝내 못 받았으면 서버 발송을 켜 두는 쪽으로 (스위치가 켜짐으로 보이는데 알림이 안 오지 않게)
      if (!latest || !latest.pushEnabled) patch({ pushEnabled: true });
    }
  };
  // 스위치 표시: 백그라운드 확인(로컬) 모드는 서버 발송 설정과 상관없이 알림이 오므로 그대로 켜짐
  const alertsOn = localMode || (!!token && (s?.pushEnabled ?? true));
  // 지금 등록된 종목 중 끈 것만 센다 (삭제한 종목의 옛 기록은 세지 않게). 목록이 없으면 저장된 수
  const mutedCount = stocks.data ? stocks.data.filter((st) => s?.mutedCodes?.includes(st.code)).length : (s?.mutedCodes?.length ?? 0);
  const patch = (p: Parameters<typeof updateSettings.mutate>[0]) =>
    updateSettings.mutate(p, { onError: (e) => Alert.alert("저장 실패", e instanceof Error ? e.message : String(e)) });

  const pickTime = (key: "morningTime" | "afternoonTime" | "quietStart" | "quietEnd") => {
    const current = s?.[key];
    if (!s || !current) return;
    const [h, m] = current.split(":").map(Number);
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
      }, "plain-text", current);
    }
  };

  return (
    <Card>
      <SectionTitle>알림</SectionTitle>

      <View style={styles.switchRow}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: t.ink, fontSize: font.body }}>브리핑 알림</Text>
          <Muted>
            {!tokenLoaded
              ? "확인 중…"
              : token
                ? "즉시 알림 연결됨"
                : localMode
                  ? "백그라운드 확인 (15~30분 지연)"
                  : "브리핑 생성 시 요약 알림"}
          </Muted>
        </View>
        {/* 알림 스위치는 하나 (3-21): 켜면 이 기기를 등록하고 서버 발송도 켠다. 끄면 이 기기만 뺀다 */}
        <Toggle value={alertsOn} onValueChange={(v) => void toggleAlerts(v)} disabled={busy || !tokenLoaded} accessibilityLabel="브리핑 알림" />
      </View>
      {setupError ? <Text style={{ color: t.danger, fontSize: font.small }}>{setupError}</Text> : null}
      {localMode ? (
        <View style={{ gap: space.xs }}>
          <Pressable onPress={() => setShowGuide((v) => !v)} accessibilityRole="button" accessibilityLabel={showGuide ? "설정 방법 접기" : "즉시 푸시 설정 방법 (관리자용)"} accessibilityState={{ expanded: showGuide }} hitSlop={slopFor(font.small + space.xs)}>
            <Text style={{ color: t.accent, fontSize: font.small, fontWeight: "600" }}>{showGuide ? "접기" : "즉시 푸시 설정 방법 (관리자용)"}</Text>
          </Pressable>
          {showGuide ? (
            <View style={{ gap: space.xs }}>
              <Muted>1. console.firebase.google.com → 프로젝트 만들기 → Android 앱 추가, 패키지명 com.stockbriefing.app → google-services.json 다운로드</Muted>
              <Muted>2. expo.dev → 프로젝트 stock-briefing → Environment variables → 이름 GOOGLE_SERVICES_JSON, 타입 File 로 업로드 (환경: preview)</Muted>
              <Muted>3. Firebase 프로젝트 설정 → 서비스 계정 → 새 비공개 키 생성 → expo.dev → Credentials → Android → FCM V1 service account key 에 업로드</Muted>
              <Muted>4. 앱을 다시 빌드해 설치한 뒤 이 스위치를 껐다 켜면 “즉시 푸시”로 바뀝니다.</Muted>
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
          <TimeRow label="오전 브리핑" time={s.morningTime} enabled={s.morningEnabled} onToggle={(v) => patch({ morningEnabled: v })} onPick={() => pickTime("morningTime")} />
          <TimeRow label="오후 브리핑" time={s.afternoonTime} enabled={s.afternoonEnabled} onToggle={(v) => patch({ afternoonEnabled: v })} onPick={() => pickTime("afternoonTime")} />
          <View style={styles.switchRow}>
            <Text style={{ color: t.ink, fontSize: font.body, flex: 1 }}>평일만</Text>
            <Toggle value={s.weekdaysOnly} onValueChange={(v) => patch({ weekdaysOnly: v })} accessibilityLabel="평일만" />
          </View>
          {/* 3-19: 묶음(briefingDigest)이 켜진 서버에서만 — 꺼져 있으면 서버가 조용한 시간·끈 종목을 쓰지 않는다 */}
          {s.digest === true && s.quietStart && s.quietEnd ? (
            <>
              <View style={styles.switchRow}>
                <Text style={{ color: t.ink, fontSize: font.body, flex: 1 }}>조용한 시간</Text>
                <Toggle value={!!s.quietEnabled} onValueChange={(v) => patch({ quietEnabled: v })} accessibilityLabel="조용한 시간" />
              </View>
              <View style={[styles.switchRow, { paddingTop: 0 }]}>
                <TimeChip time={s.quietStart} enabled={!!s.quietEnabled} label="조용한 시간 시작" onPick={() => pickTime("quietStart")} />
                <Muted>~</Muted>
                <TimeChip time={s.quietEnd} enabled={!!s.quietEnabled} label="조용한 시간 끝" onPick={() => pickTime("quietEnd")} />
                <Muted style={{ flex: 1, fontSize: font.tiny }}>이 사이 브리핑은 알리지 않고 탭에만</Muted>
              </View>
              {quietWarnings(s).map((w) => (
                <Text key={w} style={{ color: t.warn, fontSize: font.tiny }}>
                  {w}
                </Text>
              ))}
              <Pressable onPress={() => setShowMuted((v) => !v)} accessibilityRole="button" accessibilityLabel={`종목별 알림, ${mutedCount > 0 ? `${mutedCount}종목 끔` : "모두 받음"}`} accessibilityState={{ expanded: showMuted }} style={[styles.switchRow, { minHeight: touch.min }]}>
                <Text style={{ color: t.ink, fontSize: font.body, flex: 1 }}>종목별 알림</Text>
                <Muted>{mutedCount > 0 ? `${mutedCount}종목 끔` : "모두 받음"}</Muted>
                <Text style={{ color: t.accent, fontSize: font.small, fontWeight: "600" }}>{showMuted ? "접기" : "바꾸기"}</Text>
              </Pressable>
              {showMuted && stocks.isError ? <Text style={{ color: t.danger, fontSize: font.small }}>종목 목록을 불러오지 못했습니다. 잠시 뒤 다시 열어 주세요.</Text> : null}
              {showMuted && stocks.isLoading ? <Loading /> : null}
              {showMuted
                ? (stocks.data ?? []).map((st) => {
                    const muted = s.mutedCodes?.includes(st.code) ?? false;
                    return (
                      <View key={st.code} style={[styles.switchRow, { paddingLeft: space.md }]}>
                        <Text style={{ color: muted ? t.muted : t.ink, fontSize: font.small, flex: 1 }} numberOfLines={1}>
                          {st.name}
                        </Text>
                        <Toggle value={!muted} accessibilityLabel={`${st.name} 알림`} onValueChange={(on) => patch({ mute: { code: st.code, muted: !on } })} />
                      </View>
                    );
                  })
                : null}
              <Muted style={{ fontSize: font.tiny }}>브리핑 알림은 오전·오후마다 1건으로 묶어 보냅니다 (종목 수와 변동 큰 2종목)</Muted>
            </>
          ) : null}
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

function TimeChip({ time, enabled, label, onPick }: { time: string; enabled: boolean; label: string; onPick: () => void }) {
  const t = useTheme();
  return (
    <Pressable onPress={onPick} disabled={!enabled} accessibilityRole="button" accessibilityLabel={`${label} ${time} 변경`} hitSlop={slopFor(TIME_CHIP_H)} style={[styles.timeChip, { borderColor: t.line, backgroundColor: t.surfaceAlt, opacity: enabled ? 1 : 0.5 }]}>
      <Text style={{ color: t.ink, fontSize: font.body, fontVariant: ["tabular-nums"], fontWeight: "600" }}>{time}</Text>
    </Pressable>
  );
}

function TimeRow({ label, time, enabled, onToggle, onPick }: { label: string; time: string; enabled: boolean; onToggle: (v: boolean) => void; onPick: () => void }) {
  const t = useTheme();
  return (
    <View style={styles.switchRow}>
      <Text style={{ color: t.ink, fontSize: font.body, flex: 1 }}>{label}</Text>
      <Pressable onPress={onPick} disabled={!enabled} accessibilityRole="button" accessibilityLabel={`${label} 시간 ${time} 변경`} hitSlop={slopFor(TIME_CHIP_H)} style={[styles.timeChip, { borderColor: t.line, backgroundColor: t.surfaceAlt, opacity: enabled ? 1 : 0.5 }]}>
        <Text style={{ color: t.ink, fontSize: font.body, fontVariant: ["tabular-nums"], fontWeight: "600" }}>{time}</Text>
      </Pressable>
      <Toggle value={enabled} onValueChange={onToggle} accessibilityLabel={label} />
    </View>
  );
}

/** 시간 칩의 보이는 높이 (글자 약 19 + 위아래 여백 6) — hitSlop 으로 44 까지 */
const TIME_CHIP_H = 31;

const styles = StyleSheet.create({
  switchRow: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.xs },
  timeChip: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: space.s },
});
