import React from "react";
import { Alert, Linking, Pressable, Share, Text, View } from "react-native";
import { useFeature, useTossStatus } from "@/api/hooks";
import { gated } from "@/lib/features";
import type { TossOpenApiStatus } from "@/api/types";
import { formatDateKo } from "@/lib/format";
import { useTossImportFlow } from "@/lib/useTossImportFlow";
import { reconcileLabel } from "@/lib/freshness";
import { font, slopFor, space, useTheme } from "@/theme";
import { Badge, Button, Card, Muted, Row, SectionTitle } from "./ui";

async function openTossWts(): Promise<void> {
  try {
    await Linking.openURL("https://tossinvest.com");
  } catch {
    Alert.alert("토스증권 WTS를 열지 못했습니다", "브라우저 연결을 확인한 뒤 다시 눌러 주세요.");
  }
}

/**
 * 설정 > 토스증권 연동 카드.
 *  - 키 미설정: 발급 절차 안내 + 서버 공인 IP(허용 IP 등록용)
 *  - 키 설정: 토큰/실시간 상태, 허용 IP 차단 경고, 보유 종목 가져오기
 */
export function TossOpenApiCard() {
  const t = useTheme();
  const importHoldings = useTossImportFlow();
  const status = useTossStatus();
  // 이미 나간 기능(3-13)이라 서버 값을 못 받았으면 켜진 것으로
  const reconcileOn = useFeature("tossReconcile", true);

  const s = status.data;
  // 대조 기능이 꺼져 있으면 서버가 준 대조 값도 쓰지 않는다 (3-15)
  const rec = gated(reconcileOn, s?.reconcile);
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
          <Text style={{ color: t.ink, fontSize: font.small }}>3. 발급받은 두 값을 서버 설정에 넣고 서버를 다시 시작합니다 (서버 관리자 작업)</Text>
          <Pressable onPress={() => void openTossWts()} accessibilityRole="link" accessibilityLabel="토스증권 WTS 열기" hitSlop={slopFor(font.small + space.xs)}>
            <Text style={{ color: t.accent, fontSize: font.small }}>토스증권 WTS 열기</Text>
          </Pressable>
        </View>
      ) : (
        <View style={{ gap: space.xs }}>
          <Row label="서버 공인 IP" value={<Text selectable style={{ color: t.ink, fontSize: font.small, fontVariant: ["tabular-nums"] }}>{ip ?? "확인 불가"}</Text>} />
          <Row label="토큰 발급" value={s.client?.tokenIssuedAt ? formatDateKo(s.client.tokenIssuedAt, true) : "-"} />
          <Row label="마지막 성공" value={s.client?.lastOkAt ? formatDateKo(s.client.lastOkAt, true) : "-"} />
          <Row label="실시간 구독" value={s.realtime ? `${s.realtime.connected ? "연결됨" : "끊김"} · ${s.realtime.subscribed.filter((k) => !k.startsWith("personal:")).length}종목` : "-"} />
          <Row label="자동 동기화" value={syncLabel(s.sync)} />
          {s.sync?.lastError ? <Text style={{ color: t.danger, fontSize: font.small }}>자동 동기화 실패: {s.sync.lastError}</Text> : null}
          {rec ? (
            <Row label="시세·계좌 대조" value={<Text style={{ color: rec?.alert ? t.warn : t.ink, fontSize: font.small, fontVariant: ["tabular-nums"] }}>{reconcileLabel(rec, (iso) => formatDateKo(iso, true))}</Text>} />
          ) : null}
          {rec?.alert && (rec.qtyStreak ?? 0) >= 3 ? (
            <Text style={{ color: t.warn, fontSize: font.small }}>보유 수량이 토스와 다른 종목이 {rec.qtyStreak}회 연속 있습니다({rec.last?.qtyMismatch?.join(", ")}). 아래 &quot;지금 계좌 동기화&quot;로 다시 맞춰 보세요.</Text>
          ) : rec?.alert ? (
            <Text style={{ color: t.warn, fontSize: font.small }}>종목 시세 추정액이 토스 계좌와 {rec.streakOver}회 연속 0.1% 넘게 다릅니다. 종목 시세의 출처·시각이 토스 계좌 평가 기준과 달라서일 수 있습니다.</Text>
          ) : null}
          {rec?.week.n ? <Muted>최근 7일 {rec.week.n}회 중 {rec.week.withinPct}%가 0.1% 이내</Muted> : null}
          {s.client?.ipBlocked ? (
            <View style={{ gap: space.xs }}>
              <Text style={{ color: t.danger, fontSize: font.small }}>허용 IP 차단(403). 토스증권 허용 IP에 {ip ?? "서버 IP"} 등록 필요</Text>
              {ip ? <Button title="IP 보내기/복사" variant="secondary" icon="share-outline" onPress={() => void copyIp()} /> : null}
            </View>
          ) : null}
          {s.client?.lastError && !s.client.ipBlocked ? <Text style={{ color: t.danger, fontSize: font.small }}>{s.client.lastError}</Text> : null}
          {s.realtime?.lastError ? <Muted>실시간: {s.realtime.lastError}</Muted> : null}
          <Button title="지금 계좌 동기화" icon="sync" onPress={() => void importHoldings.run()} loading={importHoldings.pending} />
          {importHoldings.lastImport ? <Muted>{importHoldings.lastImport}</Muted> : null}
        </View>
      )}
      <Button title="상태 새로고침" variant="secondary" compact icon="refresh" onPress={() => void status.refetch()} loading={status.isFetching} />
    </Card>
  );
}

function syncLabel(sync: NonNullable<TossOpenApiStatus["sync"]> | null | undefined): string {
  if (!sync) return "구버전 서버";
  if (!sync.enabled) return "꺼짐 (서버에서 꺼 둠)";
  const when = sync.lastRunAt ? formatDateKo(sync.lastRunAt, true) : "아직 안 함";
  const c = sync.lastChanges;
  const changes = c ? (c.added || c.updated || c.removed ? ` (+${c.added} / 갱신 ${c.updated}${c.removed ? ` / 매도 ${c.removed}` : ""})` : " (변화 없음)") : "";
  return `${sync.intervalMin}분마다 · 마지막 ${when}${changes}`;
}
