import { Ionicons } from "@expo/vector-icons";
import Constants from "expo-constants";
import React, { useState } from "react";
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useFeature, useHealth, useNotificationSettings } from "@/api/hooks";
import { useLiveStream } from "@/lib/liveStream";
import { AppUpdateCard } from "@/components/AppUpdateCard";
import { usePull } from "@/components/Freshness";
import { flushErrors, reportError } from "@/lib/errorReport";
import { NotificationSettingsCard } from "@/components/NotificationSettingsCard";
import { ScreenInfoCard } from "@/components/ScreenInfoCard";
import { TossOpenApiCard } from "@/components/TossOpenApiCard";
import { Screen } from "@/components/Screen";
import { Badge, Button, Card, Chip, Muted, Row, RowWrapContext, SectionTitle, Toggle } from "@/components/ui";
import { FOLD_COL_GAP, settingsColumnMax, settingsTwoColumns } from "@/lib/foldScreens";
import { formatDateKo } from "@/lib/format";
import { SORT_OPTIONS, THEME_OPTIONS, useSettings, WIDGET_ROW_OPTIONS } from "@/lib/settings";
import { useFoldLayout } from "@/lib/useFoldLayout";
import { useSticky } from "@/lib/useSticky";
import { useBoxWidth } from "@/lib/useBoxWidth";
import { isWide } from "@/lib/windowClass";
import { font, radius, space, touch, useTheme } from "@/theme";
import { WIDGET_REFRESH_HELP } from "@/widgets/pushPolicy";

/**
 * 설정: 표시(원화 환산·정렬) → 알림 → 토스증권 연동 → 앱 업데이트 → 서버 상태 → 고급(서버 주소·토큰 / 화면 정보, 각각 접힘) → 정보
 * 서버 주소 같은 운영 항목은 맨 아래 "고급"에 두어 일반 사용자는 볼 일이 없게 한다.
 * 화면 정보는 접는 폰에서 창 크기·글자 배율을 재어 붙여 넣는 측정용 (기능 플래그 없이 늘 보인다)
 * 넓은 창(3-42, 기능 플래그 foldLayout + 폭 600 이상)에서 두 칸이 들어가면 카드 두 칸: 왼쪽 표시·알림·정보 | 오른쪽 토스·업데이트·서버·서버 연결·화면 정보.
 * 칸 폭이 곧 버튼 최대 폭이고, 이름과 스위치 사이가 가깝다. 가운데로 모으는 좁은 한 칸(읽기 폭)은 쓰지 않는다
 */
export default function SettingsScreen() {
  const t = useTheme();
  const { apiUrl, apiToken, setCredentials, showKrw, setShowKrw, sort, setSort, themeMode, setThemeMode, afterCost, setAfterCost, widgetRowCurrency, setWidgetRowCurrency } = useSettings();
  // 다듬은 잔고 위젯(widgetPolish)에서만 쓰는 설정이라 플래그가 켜져 있을 때만 보인다
  const widgetPolishOn = useFeature("widgetPolish", false);
  const health = useHealth();
  // 알림·토스 카드는 토큰이 맞는 서버에서만 보인다 (토큰이 없으면 서버가 401 을 주므로 묻지 않는다)
  const full = !!health.data && !health.data.limited;
  const notifySettings = useNotificationSettings(full);
  const stream = useLiveStream();
  const [advanced, setAdvanced] = useState(false);
  // 당겨서 새로고침: 서버 상태와, 알림 카드가 보이면 알림 설정('다음 실행' 시각)도 함께 (BH-16)
  const { pulling, onPull } = usePull(() => Promise.all([health.refetch(), full ? notifySettings.refetch() : undefined]));
  // 서버 연결 입력 중인 주소·토큰: 한 칸 ↔ 두 칸, 폰 접기 ↔ 펴기로 카드가 새로 그려져도 지워지지 않게 화면이 들고 있는다.
  // 저장된 값이 바뀌면(저장·다른 곳에서 변경) 새 값으로 다시 시작하고, 사용자가 '서버 연결'을 접으면 저장하지 않은 입력을 버린다
  // (지금과 같다 — 다시 펴면 저장된 주소·토큰)
  const saved = `${apiUrl}|${apiToken}`;
  const [draft, setDraft] = useState({ saved, url: apiUrl, token: apiToken });
  const form = draft.saved === saved ? draft : { saved, url: apiUrl, token: apiToken };
  if (form !== draft) setDraft(form);
  // 넓은 창(3-42, 플래그 foldLayout + 폭 600 이상): '화면' 칩을 '잔고 정렬'처럼 이름 아래 왼쪽에 (진단 38), 카드는 두 칸이 들어가면 두 칸.
  // 좁은 창(접은 화면)·플래그 꺼짐은 지금 그대로
  const fold = useFoldLayout();
  const wide = fold.on && isWide(fold);
  // 설정 탭이 실제로 받은 폭 (카드 틀에 onLayout, 재기 전에는 창 폭 − 왼쪽 세로 탭 막대).
  // 두 칸 기준선 근처에서는 바로 전 배치를 지킨다 (히스테리시스 — 창을 끌 때 한 칸·두 칸이 번갈아 바뀌지 않게).
  // 좁은 창에서는 바로 전 배치를 지운다(null) — 접은 화면에서 펴면 처음 연 것과 같은 배치
  const [boxW, onLayout] = useBoxWidth(fold.rail);
  const twoSticky = useSticky(wide ? boxW : null, (w) => (settingsTwoColumns(w) ? 1 : 0));
  const two = wide && twoSticky === 1;
  // 두 칸의 한 칸 최대 폭: 이름과 스위치가 멀어지지 않게 (남는 폭은 두 칸 사이로만)
  const colMax = settingsColumnMax();
  const chips = (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.s }}>
      {THEME_OPTIONS.map((o) => (
        <Chip key={o.value} label={o.label} accessibilityLabel={`화면 ${o.label}`} active={themeMode === o.value} onPress={() => void setThemeMode(o.value)} />
      ))}
    </View>
  );

  const display = (
    <Card>
      <SectionTitle>표시</SectionTitle>
      {wide ? (
        <View style={{ gap: space.s, paddingVertical: space.s }}>
          <Text style={styles.label(t.ink)}>화면</Text>
          {chips}
        </View>
      ) : (
        <View style={styles.line}>
          <Text style={styles.label(t.ink)}>화면</Text>
          {chips}
        </View>
      )}
      <View style={styles.line}>
        <View style={{ flex: 1, paddingRight: space.md }}>
          <Text style={styles.label(t.ink)}>해외주식 원화 표시</Text>
          <Muted style={{ fontSize: font.tiny }}>토스증권 적용 환율 기준</Muted>
        </View>
        <Toggle value={showKrw} onValueChange={(v) => void setShowKrw(v)} accessibilityLabel="해외주식 원화 표시" />
      </View>
      <View style={styles.line}>
        <View style={{ flex: 1, paddingRight: space.md }}>
          <Text style={styles.label(t.ink)}>수수료·세금 차감 평가</Text>
          <Muted style={{ fontSize: font.tiny }}>토스 앱과 같은 평가금액·손익 (토스 연동 종목)</Muted>
        </View>
        <Toggle value={afterCost} onValueChange={(v) => void setAfterCost(v)} accessibilityLabel="수수료·세금 차감 평가" />
      </View>
      <View style={{ gap: space.s, paddingTop: space.s }}>
        <Text style={styles.label(t.ink)}>잔고 정렬</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.s }}>
          {SORT_OPTIONS.map((o) => (
            <Chip key={o.value} label={o.label} accessibilityLabel={`잔고 정렬 ${o.label}`} active={sort === o.value} onPress={() => void setSort(o.value)} />
          ))}
        </View>
      </View>
      <View style={{ gap: space.xxs, paddingTop: space.sm }}>
        <Text style={styles.label(t.ink)}>홈 화면 위젯 갱신</Text>
        <Muted style={{ fontSize: font.tiny }}>{WIDGET_REFRESH_HELP}</Muted>
      </View>
      {widgetPolishOn ? (
        <View style={{ gap: space.s, paddingTop: space.sm }}>
          <View style={{ gap: space.xxs }}>
            <Text style={styles.label(t.ink)}>위젯 종목 금액</Text>
            <Muted style={{ fontSize: font.tiny }}>잔고 위젯 종목 줄의 수익 금액 통화. 원화는 위젯 합계와 같은 기준</Muted>
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.s }}>
            {WIDGET_ROW_OPTIONS.map((o) => (
              <Chip key={o.value} label={o.label} accessibilityLabel={`위젯 종목 금액 ${o.label}`} active={widgetRowCurrency === o.value} onPress={() => void setWidgetRowCurrency(o.value)} />
            ))}
          </View>
        </View>
      ) : null}
    </Card>
  );

  const server = (
    <Card>
      <SectionTitle
        right={health.data?.limited ? <Badge tone="bad">토큰 필요</Badge> : health.data ? <Badge tone="good">정상</Badge> : health.isError ? <Badge tone="bad">연결 끊김</Badge> : null}
      >
        서버
      </SectionTitle>
      {health.isError ? (
        <Text style={{ color: t.danger, fontSize: font.small }}>{health.error instanceof Error ? health.error.message : String(health.error)}</Text>
      ) : health.data?.limited ? (
        <Text style={{ color: t.danger, fontSize: font.small }}>서버에 연결됐지만 토큰이 없거나 맞지 않습니다. 아래 서버 연결에서 토큰을 입력하세요.</Text>
      ) : health.data ? (
        <View>
          <Row label="서버 시각" value={formatDateKo(health.data.time, true)} />
          <Row label="시세" value={health.data.sources?.quotes ?? "-"} />
          <Row label="실시간" value={health.data.sources?.realtime ?? "-"} />
          <Row label="앱 스트리밍" value={stream.connected ? `연결 · ${stream.ticks}건` : "폴링 3초"} />
          <Row label="뉴스" value={health.data.sources?.news ?? "-"} />
          <Row label="재무/공시" value={health.data.sources?.financials ?? "-"} />
          <Row label="수급" value={health.data.sources?.investorFlow ?? "-"} />
          <Row label="브리핑 모델" value={health.data.sources?.llm ?? "-"} />
          {health.data.appErrors ? (
            <Row label="앱 오류 (7일)" value={`${health.data.appErrors.total}건${health.data.appErrors.fatal ? ` · 강제 종료 ${health.data.appErrors.fatal}건` : ""}`} />
          ) : null}
        </View>
      ) : (
        <Muted>확인 중…</Muted>
      )}
    </Card>
  );

  const connect = (
    <Card>
      <Pressable
        onPress={() => {
          // 접으면 저장하지 않은 입력을 버린다 (지금과 같다)
          if (advanced) setDraft({ saved, url: apiUrl, token: apiToken });
          setAdvanced(!advanced);
        }}
        accessibilityRole="button"
        accessibilityLabel="서버 연결"
        accessibilityState={{ expanded: advanced }}
        style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: touch.min }}
      >
        <SectionTitle style={{ marginBottom: 0 }}>서버 연결</SectionTitle>
        <Ionicons name={advanced ? "chevron-up" : "chevron-down"} size={18} color={t.muted} />
      </Pressable>
      {advanced ? (
        <ApiUrlForm
          apiUrl={apiUrl}
          apiToken={apiToken}
          draft={form.url}
          tokenDraft={form.token}
          onDraft={(url, token) => setDraft({ saved, url, token })}
          authRequired={health.data?.authRequired ?? false}
          onSave={async (url, token) => {
            // 주소·토큰을 한 번에 — 따로 바꾸면 새 서버로 옛 토큰이 먼저 나간다 (BH-27)
            await setCredentials(url, token);
            await health.refetch();
          }}
          onCheck={() => void health.refetch()}
          checking={health.isFetching}
        />
      ) : null}
      {advanced ? (
        <Button
          title="오류 수집 시험 보내기"
          variant="secondary"
          compact
          style={{ marginTop: space.sm }}
          onPress={() =>
            void reportError("test", new Error(`오류 수집 시험 (설정 화면) ${new Date().toISOString().slice(11, 19)}`))
              .then(() => flushErrors())
              .then((r) =>
                r === "sent" || r === "empty"
                  ? Alert.alert("보냈습니다", "서버의 앱 오류 기록에 '시험'으로 남습니다. 합계에는 들어가지 않습니다.")
                  : Alert.alert("보내지 못했습니다", r === "dropped" ? "서버가 보고 형식을 받지 않았습니다 (서버 버전 확인)." : "서버에 연결되지 않았습니다. 기기에 남겨 두고 다음 실행 때 다시 보냅니다."),
              )
          }
        />
      ) : null}
    </Card>
  );

  const info = (
    <Card>
      <SectionTitle>정보</SectionTitle>
      <Row label="앱 버전" value={Constants.expoConfig?.version ?? "-"} />
      <Row label="시세" value="토스증권 · 네이버 증권" />
      <Row label="공시" value="DART · SEC EDGAR" />
      <Muted style={{ fontSize: font.tiny, marginTop: space.xs }}>투자 판단의 책임은 본인에게 있으며, 본 서비스는 투자 권유가 아닙니다.</Muted>
    </Card>
  );
  const notify = full ? <NotificationSettingsCard /> : null;
  const toss = full ? <TossOpenApiCard /> : null;

  if (wide)
    return (
      <Screen refreshing={pulling} onRefresh={onPull}>
        {/* 넓은 창: 칸이 좁으면 이름·값 줄의 값이 이름 아래 줄로 (큰 글씨에서도 두 칸을 지킨다) */}
        <RowWrapContext.Provider value={true}>
        {/* 두 칸: 왼쪽 표시·알림·정보 | 오른쪽 토스·업데이트·서버·서버 연결·화면 정보. 화면 읽기는 왼쪽 칸을 끝까지 읽고 오른쪽 칸으로.
            칸은 최대 폭(colMax)까지만 넓어지고, 남는 폭은 두 칸 사이로만 (칸은 화면 양 끝에 붙는다 — 가운데로 모으지 않는다).
            두 칸이 안 들어가는 넓은 창(폭 600~687 — 한 칸 최소 폭은 글자 크기와 상관없다)은 같은 틀을 세로로 쌓아 한 칸: 카드 차례는 휴대폰과 같고(정보는 맨 끝),
            한 칸 ↔ 두 칸이 바뀌어도 카드가 같은 자리에 남아 펼침 상태·입력 중인 값이 그대로다 (정보 카드만 옮겨진다 — 상태 없음) */}
        <View style={two ? styles.columns : styles.stacked} onLayout={onLayout}>
          <View style={two ? [styles.column, { maxWidth: colMax }] : styles.stackedPart}>
            {display}
            {notify}
            {two ? info : null}
          </View>
          <View style={two ? [styles.column, { maxWidth: colMax }] : styles.stackedPart}>
            {toss}
            <AppUpdateCard />
            {server}
            {connect}
            <ScreenInfoCard />
            {two ? null : info}
          </View>
        </View>
        </RowWrapContext.Provider>
      </Screen>
    );
  return (
    <Screen refreshing={pulling} onRefresh={onPull}>
      {display}
      {notify}
      {toss}
      <AppUpdateCard />
      {server}
      {connect}
      <ScreenInfoCard />
      {info}
    </Screen>
  );
}

/** 서버 주소·토큰 입력 (입력 중인 값은 설정 화면이 들고 있다 — 카드가 새로 그려져도 남게) */
function ApiUrlForm({
  apiUrl,
  apiToken,
  draft,
  tokenDraft,
  onDraft,
  authRequired,
  onSave,
  onCheck,
  checking,
}: {
  apiUrl: string;
  apiToken: string;
  draft: string;
  tokenDraft: string;
  onDraft: (url: string, token: string) => void;
  authRequired: boolean;
  onSave: (url: string, token: string) => Promise<void>;
  onCheck: () => void;
  checking: boolean;
}) {
  const t = useTheme();
  const setDraft = (url: string) => onDraft(url, tokenDraft);
  const setTokenDraft = (token: string) => onDraft(draft, token);
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
        accessibilityLabel="서버 주소"
        placeholder="https://서버 주소"
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
        accessibilityLabel="API 토큰"
        placeholder={authRequired ? "서버에 설정한 API 토큰" : "서버에 토큰을 설정한 경우만"}
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
    // 큰 글씨에서 오른쪽 칩·스위치가 넘치면 다음 줄로
    line: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", rowGap: space.s, paddingVertical: space.s },
    // 넓은 창 두 칸 (3-42): 칸 폭이 곧 버튼 최대 폭. 칸이 최대 폭에 걸리면 남는 폭은 두 칸 사이로만 (양 끝에 붙는다).
    // 칸 안 카드 사이 간격은 화면(Screen)의 카드 간격과 같다
    columns: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: FOLD_COL_GAP },
    column: { flex: 1, minWidth: 0, gap: space.sm },
    // 넓은 창 한 칸 (두 칸이 안 들어갈 때): 같은 틀을 세로로 쌓는다 — 카드 사이 간격은 화면(Screen)과 같다
    stacked: { gap: space.sm },
    stackedPart: { gap: space.sm },
  }),
  label: (color: string) => ({ color, fontSize: font.body, fontWeight: "600" as const }),
};

// 이 화면에서 난 렌더 오류는 앱을 끄지 않고 "다시 시도" 화면으로 (expo-router)
export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteError";
