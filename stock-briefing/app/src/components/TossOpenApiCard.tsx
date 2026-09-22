import { useMutation, useQueryClient } from "@tanstack/react-query";
import React, { useState } from "react";
import { Alert, Linking, Pressable, Share, Text, View } from "react-native";
import { useApi, useTossStatus } from "@/api/hooks";
import { useSettings } from "@/lib/settings";
import { formatDateKo, formatPrice } from "@/lib/format";
import { font, space, useTheme } from "@/theme";
import { Badge, Button, Card, Muted, Row, SectionTitle } from "./ui";

/**
 * 설정 > 토스증권 연동 카드.
 *  - 키 미설정: 발급 절차 안내 + 서버 공인 IP(허용 IP 등록용)
 *  - 키 설정: 토큰/실시간 상태, 허용 IP 차단 경고, 보유 종목 가져오기
 */
export function TossOpenApiCard() {
  const t = useTheme();
  const api = useApi();
  const qc = useQueryClient();
  const { apiUrl } = useSettings();
  const status = useTossStatus();
  const [lastImport, setLastImport] = useState<string | null>(null);
  const importHoldings = useMutation({
    mutationFn: api.importTossHoldings,
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: [apiUrl, "stocks"] });
      void qc.invalidateQueries({ queryKey: [apiUrl, "briefings"] });
      const lines = r.holdings.map((h) => `${h.name} ${h.quantity}주 · 평단 ${formatPrice(h.avgPrice, h.currency)}`);
      setLastImport(`${r.accounts}개 계좌에서 ${r.holdings.length}종목 (새로 ${r.added.length}, 갱신 ${r.updated.length})`);
      Alert.alert("보유 종목 가져오기 완료", lines.length ? lines.join("\n") : "보유 중인 주식이 없습니다.");
    },
    onError: (e) => Alert.alert("가져오기 실패", e instanceof Error ? e.message : String(e)),
  });

  const s = status.data;
  const ip = s?.outboundIp ?? null;
  // 클립보드 네이티브 모듈 없이(OTA 호환) 공유 시트로 IP 를 넘긴다. 아래 IP 텍스트는 길게 눌러 복사할 수도 있다.
  const copyIp = async () => {
    if (!ip) return;
    try {
      await Share.share({ message: ip, title: "토스증권 허용 IP" });
    } catch {
      Alert.alert("서버 IP", ip);
    }
  };

  return (
    <Card>
      <SectionTitle
        right={
          !s ? null : !s.configured ? (
            <Badge>미설정</Badge>
          ) : s.client?.ipBlocked ? (
            <Badge tone="bad">IP 차단됨</Badge>
          ) : s.realtime?.connected ? (
            <Badge tone="good">실시간 연결됨</Badge>
          ) : s.client?.lastOkAt ? (
            <Badge tone="good">연결됨</Badge>
          ) : (
            <Badge tone="warn">확인 중</Badge>
          )
        }
      >
        토스증권 연동
      </SectionTitle>
      {status.isError ? (
        <Text style={{ color: t.danger, fontSize: font.small }}>{status.error instanceof Error ? status.error.message : String(status.error)}</Text>
      ) : !s ? (
        <Muted>상태 확인 중…</Muted>
      ) : !s.configured ? (
        <View style={{ gap: space.sm }}>
          <Muted>토스증권 공식 Open API 를 연결하면 토스 앱과 같은 실시간 시세, 수급, 보유 종목 자동 등록이 됩니다. 한 번만 하면 됩니다.</Muted>
          <Text style={{ color: t.ink, fontSize: font.small }}>1. PC 브라우저(또는 휴대폰 브라우저의 “데스크톱 사이트”)로 토스증권 WTS에 로그인 → 설정 → Open API → client_id / client_secret 발급</Text>
          <Text style={{ color: t.ink, fontSize: font.small }}>2. 같은 화면 아래 “허용 IP 관리”에 아래 서버 IP 를 등록</Text>
          <Row label="서버 공인 IP" value={<Text selectable style={{ color: t.ink, fontSize: font.small, fontVariant: ["tabular-nums"] }}>{ip ?? "확인 불가"}</Text>} />
          {ip ? <Button title="IP 보내기/복사" variant="secondary" icon="share-outline" onPress={() => void copyIp()} /> : null}
          <Text style={{ color: t.ink, fontSize: font.small }}>3. 발급받은 두 값을 서버 환경 변수 TOSS_CLIENT_ID / TOSS_CLIENT_SECRET 에 넣고 재시작 (Railway → Variables)</Text>
          <Pressable onPress={() => void Linking.openURL("https://tossinvest.com")} accessibilityRole="link">
            <Text style={{ color: t.accent, fontSize: font.small }}>토스증권 WTS 열기</Text>
          </Pressable>
        </View>
      ) : (
        <View style={{ gap: space.xs }}>
          <Row label="서버 공인 IP" value={<Text selectable style={{ color: t.ink, fontSize: font.small, fontVariant: ["tabular-nums"] }}>{ip ?? "확인 불가"}</Text>} />
          <Row label="토큰 발급" value={s.client?.tokenIssuedAt ? formatDateKo(s.client.tokenIssuedAt, true) : "-"} />
          <Row label="마지막 성공" value={s.client?.lastOkAt ? formatDateKo(s.client.lastOkAt, true) : "-"} />
          <Row label="실시간 구독" value={s.realtime ? `${s.realtime.connected ? "연결됨" : "끊김"} · ${s.realtime.subscribed.length}종목` : "-"} />
          {s.client?.ipBlocked ? (
            <View style={{ gap: space.xs }}>
              <Text style={{ color: t.danger, fontSize: font.small }}>토스증권이 이 서버의 요청을 차단했습니다(403). 허용 IP 목록에 {ip ?? "서버 IP"} 를 등록하세요. Railway 무료 플랜은 서버 IP 가 재배포 때 바뀔 수 있어 그때마다 다시 등록해야 합니다.</Text>
              {ip ? <Button title="IP 보내기/복사" variant="secondary" icon="share-outline" onPress={() => void copyIp()} /> : null}
            </View>
          ) : null}
          {s.client?.lastError && !s.client.ipBlocked ? <Text style={{ color: t.danger, fontSize: font.small }}>{s.client.lastError}</Text> : null}
          {s.realtime?.lastError ? <Muted>실시간: {s.realtime.lastError}</Muted> : null}
          <Button title="토스증권 보유 종목 가져오기" icon="download-outline" onPress={() => importHoldings.mutate()} loading={importHoldings.isPending} />
          {lastImport ? <Muted>{lastImport}</Muted> : null}
          <Muted>보유 중인 종목이 수량·평단과 함께 등록됩니다. 토스에 없는 관심 종목은 그대로 둡니다.</Muted>
        </View>
      )}
      <Button title="상태 다시 확인" variant="secondary" icon="refresh" onPress={() => void status.refetch()} loading={status.isFetching} />
    </Card>
  );
}
