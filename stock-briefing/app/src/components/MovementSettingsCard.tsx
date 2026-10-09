import React, { useState } from "react";
import { Alert, Platform, Text, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApi } from "@/api/hooks";
import { useWatchScope } from "@/lib/watchlistHooks";
import { Button, Card, Muted, SectionTitle, Toggle } from "@/components/ui";
import { font, space, useTheme } from "@/theme";

export function MovementSettingsCard() {
  const api = useApi(), key = [...useWatchScope(), "settings"], qc = useQueryClient(), t = useTheme();
  const [testing, setTesting] = useState(false);
  const test = async () => {
    setTesting(true);
    try {
      const [Notifications, { ensureAndroidChannel }] = await Promise.all([import("expo-notifications"), import("@/lib/notifications")]);
      if ((await Notifications.getPermissionsAsync()).status !== "granted") { Alert.alert("알림 권한 필요", "아래 기기 알림 수신을 먼저 켜 주세요."); return; }
      await ensureAndroidChannel();
      await Notifications.scheduleNotificationAsync({ content: { title: "[시험] 5% 가격 알림", body: "가격 알림 채널의 수신 시험입니다. 실제 종목의 가격 변동이 아닙니다.", sound: "default", data: { type: "movementTest" } }, trigger: Platform.OS === "android" ? { channelId: "prices" } : null });
    } catch { Alert.alert("알림 시험 실패", "휴대폰 설정에서 이 앱의 알림과 가격 알림 채널을 확인해 주세요."); }
    finally { setTesting(false); }
  };
  const q = useQuery({ queryKey: key, queryFn: api.movementSettings, retry: 0 });
  const change = useMutation({ mutationFn: api.setMovementSettings, onSuccess: value => { qc.setQueryData(key, value); }, onError: (e: Error) => Alert.alert("설정 저장 실패", e.message) });
  return <Card><SectionTitle>5% 구간 알림</SectionTitle>
    {q.data ? <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}><Text style={{ flex: 1, color: t.ink, fontSize: font.body }}>잔고 종목 · 전일 종가 기준</Text><Toggle value={q.data.holdings} disabled={change.isPending} accessibilityLabel="잔고 전일 종가 대비 5% 구간 알림" onValueChange={v => change.mutate(v)} /></View> : <Muted>{q.isError ? "알림 설정을 받지 못했습니다" : "알림 설정 확인 중"}</Muted>}
    {q.isError ? <Button title="다시 확인" onPress={() => { void q.refetch(); }} /> : null}
    <Muted>잔고는 전일 종가 대비 ±5%, ±10%, ±15% 구간마다 거래일별 한 번씩 알립니다. 관심종목은 직접 입력한 시작 가격 기준이며 각 종목에서 켜고 끌 수 있습니다.</Muted>
    <Muted>서버가 약 30초마다 확인합니다. 아래 기기 알림 수신을 켜 주세요. 원격 푸시가 없는 설치본은 앱 사용 중 약 30초마다, 앱을 닫으면 Android 백그라운드 확인(15분 이상) 때 전달되어 늦어질 수 있습니다. 미국 거래시간을 포함해 밤에도 가격 알림이 오며, 브리핑의 조용한 시간과는 별개입니다.</Muted>
    <Button title="가격 알림 수신 시험" variant="secondary" loading={testing} onPress={() => { void test(); }} />
  </Card>;
}
