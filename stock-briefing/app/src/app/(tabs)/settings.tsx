import React, { useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { useHealth } from "@/api/hooks";
import { Screen } from "@/components/Screen";
import { Badge, Button, Card, Muted, Row, SectionTitle } from "@/components/ui";
import { formatDateKo } from "@/lib/format";
import { useSettings } from "@/lib/settings";
import { font, radius, space, useTheme } from "@/theme";

/** 설정: 서버 주소, 서버 상태(데이터 소스/스케줄). 알림 시간 설정은 4단계에서 추가. */
export default function SettingsScreen() {
  const t = useTheme();
  const { apiUrl, setApiUrl } = useSettings();
  const health = useHealth();

  return (
    <Screen refreshing={health.isRefetching} onRefresh={() => void health.refetch()}>
      {/* key 로 저장된 주소가 바뀌면 입력 폼을 다시 만든다 */}
      <ApiUrlForm key={apiUrl} apiUrl={apiUrl} onSave={async (url) => { await setApiUrl(url); await health.refetch(); }} onCheck={() => void health.refetch()} checking={health.isFetching} />

      <Card>
        <SectionTitle right={health.data ? <Badge tone="good">연결됨</Badge> : health.isError ? <Badge tone="bad">연결 안 됨</Badge> : null}>서버 상태</SectionTitle>
        {health.isError ? (
          <Text style={{ color: t.danger, fontSize: font.small }}>{health.error instanceof Error ? health.error.message : String(health.error)}</Text>
        ) : health.data ? (
          <View>
            <Row label="서버 시각" value={formatDateKo(health.data.time, true)} />
            <Row label="시세" value={health.data.sources.quotes ?? "-"} />
            <Row label="뉴스" value={health.data.sources.news ?? "-"} />
            <Row label="재무/공시" value={health.data.sources.financials ?? "-"} />
            <Row label="수급" value={health.data.sources.investorFlow ?? "-"} />
            <Row label="브리핑 모델" value={health.data.sources.llm ?? "-"} />
          </View>
        ) : (
          <Muted>확인 중…</Muted>
        )}
      </Card>

      {health.data?.schedule ? (
        <Card>
          <SectionTitle>브리핑 스케줄</SectionTitle>
          {health.data.schedule.jobs.map((j) => (
            <Row key={j.session} label={j.session === "morning" ? "오전" : "오후"} value={j.nextRun ? `다음 ${formatDateKo(j.nextRun, true)}` : j.cron} />
          ))}
          <Muted>시간대 {health.data.schedule.timezone}. 알림 시간 변경은 다음 단계(푸시 알림)에서 지원됩니다.</Muted>
        </Card>
      ) : null}
    </Screen>
  );
}

function ApiUrlForm({ apiUrl, onSave, onCheck, checking }: { apiUrl: string; onSave: (url: string) => Promise<void>; onCheck: () => void; checking: boolean }) {
  const t = useTheme();
  const [draft, setDraft] = useState(apiUrl);
  const dirty = draft.trim().replace(/\/+$/, "") !== apiUrl;
  return (
    <Card>
      <SectionTitle>서버 주소</SectionTitle>
      <TextInput
        value={draft}
        onChangeText={setDraft}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        placeholder="http://192.168.0.10:3000"
        placeholderTextColor={t.muted}
        style={[styles.input, { color: t.ink, borderColor: t.line, backgroundColor: t.surfaceAlt }]}
      />
      <Muted>실기기에서는 백엔드를 실행한 PC 의 LAN IP 를 입력하세요. Android 에뮬레이터는 10.0.2.2, iOS 시뮬레이터는 localhost.</Muted>
      <Button title={dirty ? "저장하고 연결 확인" : "연결 확인"} onPress={() => (dirty ? void onSave(draft) : onCheck())} loading={checking} />
    </Card>
  );
}

const styles = StyleSheet.create({
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm, padding: space.md, fontSize: font.body },
});
