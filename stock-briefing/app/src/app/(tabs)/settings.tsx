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
import { SORT_OPTIONS, THEME_OPTIONS, useSettings } from "@/lib/settings";
import { font, radius, space, useTheme } from "@/theme";

/**
 * 설정: 표시(원화 환산·정렬) → 알림 → 토스증권 연동 → 앱 업데이트 → 서버 상태 → 고급(서버 주소·토큰, 접힘) → 정보
 * 서버 주소 같은 운영 항목은 맨 아래 "고급"에 두어 일반 사용자는 볼 일이 없게 한다.
 */
export default function SettingsScreen() {
  const t = useTheme();
  const { apiUrl, apiToken, setApiUrl, setApiToken, showKrw, setShowKrw, sort, setSort, themeMode, setThemeMode, afterCost, setAfterCost } = useSettings();
  const health = useHealth();
  const stream = useLiveStream();
  const [advanced, setAdvanced] = useState(false);

  return (
    <Screen refreshing={health.isRefetching} onRefresh={() => void health.refetch()}>
      <Card>
        <SectionTitle>표시</SectionTitle>
        <View style={styles.line}>
          <Text style={styles.label(t.ink)}>화면</Text>
          <View style={{ flexDirection: "row", gap: 6 }}>
            {THEME_OPTIONS.map((o) => (
              <Chip key={o.value} label={o.label} active={themeMode === o.value} onPress={() => void setThemeMode(o.value)} />
            ))}
          </View>
        </View>
        <View style={styles.line}>
          <View style={{ flex: 1, paddingRight: space.md }}>
            <Text style={styles.label(t.ink)}>해외주식 원화 표시</Text>
            <Muted style={{ fontSize: font.tiny }}>토스증권 적용 환율 기준</Muted>
          </View>
          <Switch value={showKrw} onValueChange={(v) => void setShowKrw(v)} trackColor={{ true: t.accent, false: t.lineStrong }} thumbColor="#FFFFFF" />
        </View>
        <View style={styles.line}>
          <View style={{ flex: 1, paddingRight: space.md }}>
            <Text style={styles.label(t.ink)}>수수료·세금 차감 평가</Text>
            <Muted style={{ fontSize: font.tiny }}>토스 앱과 같은 평가금액·손익 (토스 연동 종목)</Muted>
          </View>
          <Switch value={afterCost} onValueChange={(v) => void setAfterCost(v)} trackColor={{ true: t.accent, false: t.lineStrong }} thumbColor="#FFFFFF" />
        </View>
        <View style={{ gap: 6, paddingTop: 6 }}>
          <Text style={styles.label(t.ink)}>잔고 정렬</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
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
        <SectionTitle right={health.data ? <Badge tone="good">정상</Badge> : health.isError ? <Badge tone="bad">연결 끊김</Badge> : null}>서버</SectionTitle>
        {health.isError ? (
          <Text style={{ color: t.danger, fontSize: font.small }}>{health.error instanceof Error ? health.error.message : String(health.error)}</Text>
        ) : health.data ? (
          <View>
            <Row label="서버 시각" value={formatDateKo(health.data.time, true)} />
            <Row label="시세" value={health.data.sources.quotes ?? "-"} />
            <Row label="실시간" value={health.data.sources.realtime ?? "-"} />
            <Row label="앱 스트리밍" value={stream.connected ? `연결 · ${stream.ticks}건` : "폴링 3초"} />
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
          <SectionTitle style={{ marginBottom: 0 }}>서버 연결</SectionTitle>
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
        ) : null}
      </Card>

      <Card>
        <SectionTitle>정보</SectionTitle>
        <Row label="앱 버전" value={Constants.expoConfig?.version ?? "-"} />
        <Row label="시세" value="토스증권 · 네이버 증권" />
        <Row label="공시" value="DART · SEC EDGAR" />
        <Muted style={{ fontSize: font.tiny, marginTop: 4 }}>투자 판단의 책임은 본인에게 있으며, 본 서비스는 투자 권유가 아닙니다.</Muted>
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

const styles = {
  ...StyleSheet.create({
    input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm, padding: space.md, fontSize: font.body },
    line: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 6 },
  }),
  label: (color: string) => ({ color, fontSize: font.body, fontWeight: "600" as const }),
};
