import { Ionicons } from "@expo/vector-icons";
import Constants from "expo-constants";
import React, { useState } from "react";
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { useHealth } from "@/api/hooks";
import { useLiveStream } from "@/lib/liveStream";
import { AppUpdateCard } from "@/components/AppUpdateCard";
import { NotificationSettingsCard } from "@/components/NotificationSettingsCard";
import { TossOpenApiCard } from "@/components/TossOpenApiCard";
import { Screen } from "@/components/Screen";
import { Badge, Button, Card, Chip, Muted, Row, SectionTitle } from "@/components/ui";
import { formatDateKo } from "@/lib/format";
import { SORT_OPTIONS, useSettings } from "@/lib/settings";
import { font, radius, space, useTheme } from "@/theme";

/**
 * 설정: 표시(원화 환산·정렬) → 알림 → 토스증권 연동 → 앱 업데이트 → 서버 상태 → 고급(서버 주소·토큰, 접힘) → 정보
 * 서버 주소 같은 운영 항목은 맨 아래 "고급"에 두어 일반 사용자는 볼 일이 없게 한다.
 */
export default function SettingsScreen() {
  const t = useTheme();
  const { apiUrl, apiToken, setApiUrl, setApiToken, showKrw, setShowKrw, sort, setSort } = useSettings();
  const health = useHealth();
  const stream = useLiveStream();
  const [advanced, setAdvanced] = useState(false);

  return (
    <Screen refreshing={health.isRefetching} onRefresh={() => void health.refetch()}>
      <Card>
        <SectionTitle>표시</SectionTitle>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <View style={{ flex: 1, paddingRight: space.md }}>
            <Text style={{ color: t.ink, fontSize: font.body, fontWeight: "600" }}>미국 주식 원화로 보기</Text>
            <Muted>현재 환율(하나은행 고시, 1분 갱신)로 환산해 가격·손익·합계를 원화로 표시합니다.</Muted>
          </View>
          <Switch value={showKrw} onValueChange={(v) => void setShowKrw(v)} trackColor={{ true: t.accent }} />
        </View>
        <View style={{ gap: space.xs, marginTop: space.xs }}>
          <Text style={{ color: t.ink, fontSize: font.body, fontWeight: "600" }}>내 종목 기본 정렬</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
            {SORT_OPTIONS.map((o) => (
              <Chip key={o.value} label={o.label} active={sort === o.value} onPress={() => void setSort(o.value)} />
            ))}
          </View>
        </View>
      </Card>

      {health.data ? <NotificationSettingsCard /> : null}
      {health.data ? <TossOpenApiCard /> : null}
      <AppUpdateCard />

      <Card>
        <SectionTitle right={health.data ? <Badge tone="good">연결됨</Badge> : health.isError ? <Badge tone="bad">연결 안 됨</Badge> : null}>서버 상태</SectionTitle>
        {health.isError ? (
          <Text style={{ color: t.danger, fontSize: font.small }}>{health.error instanceof Error ? health.error.message : String(health.error)}</Text>
        ) : health.data ? (
          <View>
            <Row label="서버 시각" value={formatDateKo(health.data.time, true)} />
            <Row label="시세" value={health.data.sources.quotes ?? "-"} />
            <Row label="실시간" value={health.data.sources.realtime ?? "-"} />
            <Row label="앱 스트리밍" value={stream.connected ? `연결됨 · 체결 ${stream.ticks}건 반영` : "연결 안 됨 (3초 폴링으로 동작)"} />
            <Row label="뉴스" value={health.data.sources.news ?? "-"} />
            <Row label="재무/공시" value={health.data.sources.financials ?? "-"} />
            <Row label="수급" value={health.data.sources.investorFlow ?? "-"} />
            <Row label="브리핑 모델" value={health.data.sources.llm ?? "-"} />
          </View>
        ) : (
          <Muted>확인 중…</Muted>
        )}
      </Card>

      <Card>
        <Pressable onPress={() => setAdvanced((v) => !v)} accessibilityRole="button" style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <SectionTitle style={{ marginBottom: 0 }}>고급</SectionTitle>
          <Ionicons name={advanced ? "chevron-up" : "chevron-down"} size={18} color={t.muted} />
        </Pressable>
        {advanced ? (
          <ApiUrlForm
            key={`${apiUrl}|${apiToken}`}
            apiUrl={apiUrl}
            apiToken={apiToken}
            authRequired={health.data?.authRequired ?? false}
            onSave={async (url, token) => {
              await setApiUrl(url);
              await setApiToken(token);
              await health.refetch();
            }}
            onCheck={() => void health.refetch()}
            checking={health.isFetching}
          />
        ) : (
          <Muted>서버 주소와 접속 토큰. 앱 설치 때 이미 설정되어 있어 보통은 바꿀 필요가 없습니다.</Muted>
        )}
      </Card>

      <Card>
        <SectionTitle>정보</SectionTitle>
        <Row label="앱 버전" value={Constants.expoConfig?.version ?? "-"} />
        <Muted>시세는 토스증권·네이버 증권·Yahoo Finance, 공시는 DART, 브리핑은 Claude 가 작성합니다. 투자 판단의 책임은 본인에게 있으며 투자 권유가 아닙니다.</Muted>
      </Card>
    </Screen>
  );
}

function ApiUrlForm({
  apiUrl,
  apiToken,
  authRequired,
  onSave,
  onCheck,
  checking,
}: {
  apiUrl: string;
  apiToken: string;
  authRequired: boolean;
  onSave: (url: string, token: string) => Promise<void>;
  onCheck: () => void;
  checking: boolean;
}) {
  const t = useTheme();
  const [draft, setDraft] = useState(apiUrl);
  const [tokenDraft, setTokenDraft] = useState(apiToken);
  const dirty = draft.trim().replace(/\/+$/, "") !== apiUrl || tokenDraft.trim() !== apiToken;
  return (
    <View style={{ gap: space.sm }}>
      <Muted>서버 주소</Muted>
      <TextInput
        value={draft}
        onChangeText={setDraft}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        placeholder="https://xxx.up.railway.app"
        placeholderTextColor={t.muted}
        style={[styles.input, { color: t.ink, borderColor: t.line, backgroundColor: t.surfaceAlt }]}
      />
      <Muted>API 토큰</Muted>
      <TextInput
        value={tokenDraft}
        onChangeText={setTokenDraft}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        placeholder={authRequired ? "서버 .env 의 API_TOKEN" : "서버에 API_TOKEN 을 설정한 경우만"}
        placeholderTextColor={t.muted}
        style={[styles.input, { color: t.ink, borderColor: authRequired && !tokenDraft ? t.danger : t.line, backgroundColor: t.surfaceAlt }]}
      />
      <Button title={dirty ? "저장하고 연결 확인" : "연결 확인"} variant="secondary" onPress={() => (dirty ? void onSave(draft, tokenDraft) : onCheck())} loading={checking} />
    </View>
  );
}

const styles = StyleSheet.create({
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm, padding: space.md, fontSize: font.body },
});
