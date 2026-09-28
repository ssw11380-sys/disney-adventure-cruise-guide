import Ionicons from "@expo/vector-icons/Ionicons";
import Constants from "expo-constants";
import { router, useLocalSearchParams } from "expo-router";
import React, { useEffect, useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View, type LayoutChangeEvent, type ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFeature, useHealth, useNotificationSettings } from "@/api/hooks";
import { useLiveStream } from "@/lib/liveStream";
import { saverLabel } from "@/lib/pollSaver";
import { gated } from "@/lib/features";
import { tradeRecordsLabel } from "@/lib/tradeRecords";
import { condStats } from "@/api/condCache";
import { AccountCard } from "@/components/AccountCard";
import { ApiUrlForm } from "@/components/ApiUrlForm";
import { AppUpdateCard } from "@/components/AppUpdateCard";
import { usePull } from "@/components/Freshness";
import { flushErrors, reportError } from "@/lib/errorReport";
import { NotificationSettingsCard } from "@/components/NotificationSettingsCard";
import { PriceAlertSettingsCard } from "@/components/PriceAlertSettingsCard";
import { ScreenInfoCard } from "@/components/ScreenInfoCard";
import { TossOpenApiCard } from "@/components/TossOpenApiCard";
import { WidgetRefreshStatus } from "@/components/WidgetRefreshStatus";
import { Screen } from "@/components/Screen";
import { Badge, Button, Card, Chip, Muted, Row, RowWrapContext, SectionTitle, Toggle } from "@/components/ui";
import { connectionKind, connectionText, SERVER_SECTION, TOKEN_FIELD } from "@/lib/connectionError";
import { FOLD_COL_GAP, settingsColumnMax, settingsTwoColumns } from "@/lib/foldScreens";
import { formatDateKo } from "@/lib/format";
import { DENSITY_OPTIONS, SORT_OPTIONS, THEME_OPTIONS, useSettings, WIDGET_ROW_OPTIONS } from "@/lib/settings";
import { serverOpenRequest } from "@/lib/settingsLink";
import { useFoldLayout } from "@/lib/useFoldLayout";
import { useSticky } from "@/lib/useSticky";
import { useBoxWidth } from "@/lib/useBoxWidth";
import { useUx } from "@/lib/uxFlags";
import { useAccountView } from "@/lib/account";
import { usePriceAlerts } from "@/lib/priceAlertContext";
import { isWide } from "@/lib/windowClass";
import { font, space, touch, useTheme } from "@/theme";
import { settingsReveal } from "@/tokens";
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
  const { apiUrl, apiToken, setCredentials, showKrw, setShowKrw, sort, setSort, themeMode, setThemeMode, afterCost, setAfterCost, widgetRowCurrency, setWidgetRowCurrency, haptics, setHaptics, density, setDensity, chartHighLow, setChartHighLow } = useSettings();
  // 3-24 플래그: oneHand('누를 때 진동' 스위치), firstRun('처음 사용 안내 다시 보기'), emptyGuide(서버 연결 칸 열기·빈 칸 안내)
  const ux = useUx();
  // 가격 알림 (3-29, 플래그 priceAlerts): 루트 제공자가 내려 준 문맥만 읽는다 (없으면 꺼짐 — 지금 화면 그대로)
  const alerts = usePriceAlerts();
  // 다듬은 잔고 위젯(widgetPolish)에서만 쓰는 설정이라 플래그가 켜져 있을 때만 보인다
  const widgetPolishOn = useFeature("widgetPolish", false);
  // 위젯 자동 갱신 기록 요약·배터리 설정 열기 (위젯 리뷰 2). 기록은 늘 적고 보여 주는 것만 플래그 뒤에
  const widgetLogOn = useFeature("widgetRefreshLog", false);
  // 잔고 촘촘 모드 (3-39): 켜져 있을 때만 '잔고 표시' 기본/촘촘 칩 (꺼져 있으면 저장된 값과 상관없이 잔고는 기본)
  const densityOn = useFeature("densityMode", false);
  // 이동평균선 기간·색 (3-39): 켜져 있을 때만 '차트 이동평균선' 줄 + [설정] → 새 화면 '이동평균선'
  const maOn = useFeature("maCustom", false);
  // 계정 A단계 (플래그 accounts): 맨 위 '계정' 칸. 주인 아닌 계정은 알림·가격 알림·토스 칸과 주인만 쓰는 줄(잔고·위젯·매매 기록·스트림·첫 실행 안내)을
  // 숨기고 알림 설정도 묻지 않는다 (개인 종목 기능은 다음 단계 — 서버도 막는다, 검증 4차)
  const { member } = useAccountView();
  const owner = !member;
  // 차트 최고·최저가 표시 (3-46): 켜져 있을 때만 '차트 최고·최저가 표시' 스위치 (꺼져 있으면 저장된 값과 상관없이 차트는 지금 그대로)
  const hlOn = useFeature("chartHighLow", false);
  const health = useHealth();
  // 알림·토스 카드는 토큰이 맞는 서버에서만 보인다 (토큰이 없으면 서버가 401 을 주므로 묻지 않는다)
  const full = !!health.data && !health.data.limited;
  const notifySettings = useNotificationSettings(full && owner);
  const stream = useLiveStream();
  // 끊겼을 때 데이터 절약 (3-25): 서버 줄에 폴링 방식과 최근 응답 비율
  const saverOn = useFeature("pollSaver", false);
  // 매매 기록 (3-36): 서버가 쌓는 일별 계좌 스냅샷 상태 한 줄 (읽기만). 꺼져 있거나 예전 서버면 줄 없음
  const tradeRecordsOn = useFeature("tradeRecords", false);
  const recordsLabel = owner ? tradeRecordsLabel(gated(tradeRecordsOn, health.data?.tradeRecords)) : null;
  const [advanced, setAdvanced] = useState(false);
  // 3-24 (emptyGuide — 플래그를 못 받은 채 서버에 닿지 않을 때도, lib/uxFlags connectionGuide): 오류 화면·끊김 띠의 '설정 열기'로 오면(주소 검색어 open=server) '서버 연결' 칸을 펼치고 그 칸까지 스크롤한다.
  // 누를 때마다 새 요청이라(at) 사용자가 칸을 접은 뒤 다른 화면에서 또 눌러도 다시 펼친다. 플래그가 꺼져 있으면 검색어를 보지 않는다
  const params = useLocalSearchParams<{ open?: string; at?: string }>();
  // 칸 자리 재기(감싸개·onLayout·넓은 창 key)와 열기 요청은 연결 오류 안내가 한 번 켜지면 이 화면이 떠 있는 동안 유지한다 —
  // 값이 잠깐 꺼졌다 켜져도 '서버 연결' 칸·두 기둥을 다시 만들지 않고(입력 포커스·칸 상태 유지) 스크롤을 한 번 더 하지 않게. 플래그가 꺼져 있으면 늘 false = 지금 그대로
  const [measure, setMeasure] = useState(false);
  if (ux.connectionGuide && !measure) setMeasure(true);
  const openReq = measure ? serverOpenRequest(params) : null;
  const scrollRef = useRef<ScrollView | null>(null);
  // '서버 연결' 칸 자리: 칸이 든 기둥의 y(넓은 창 오른쪽 기둥, 휴대폰은 0) + 기둥 안 칸의 y. pending = 펼친 뒤 한 번 더 스크롤.
  // until = 이 시각까지는 칸 자리가 바뀔 때마다(위쪽 알림·토스·빈 칸 안내 카드가 늦게 그려져 높이가 바뀜) 다시 맞춘다 — 사용자가 끌면 0 으로 멈춘다
  const connectPos = useRef({ col: 0, card: 0, known: false, pending: false, expanded: false, until: 0 });
  const scrollToConnect = () => {
    const p = connectPos.current;
    if (!p.known) return;
    scrollRef.current?.scrollTo({ y: Math.max(0, p.col + p.card - settingsReveal.topGap), animated: true });
  };
  const settling = () => Date.now() < connectPos.current.until;
  const stopSettling = () => {
    connectPos.current.until = 0;
  };
  const revealConnect = () => {
    const p = connectPos.current;
    // 이미 펼쳐져 있고 자리를 알면 바로 스크롤. 아니면 펼친 뒤 칸이 자리를 알려 올 때(처음 그릴 때·펼쳐 높이가 바뀔 때) 스크롤 —
    // 펼치기 전 자리로 한 번 스크롤해도 펼친 모습을 알려 올 때까지 기다린다 (펼치기 전에는 목록이 짧아 끝까지 못 내려갈 수 있다)
    p.pending = true;
    p.until = Date.now() + settingsReveal.settleMs;
    setAdvanced(true);
    if (p.known && p.expanded) {
      p.pending = false;
      scrollToConnect();
    }
  };
  useEffect(() => {
    connectPos.current.expanded = advanced;
  }, [advanced]);
  const revealRef = useRef(revealConnect);
  useEffect(() => {
    revealRef.current = revealConnect;
  });
  useEffect(() => {
    if (openReq) revealRef.current();
  }, [openReq]);
  const onConnectLayout = (e: LayoutChangeEvent) => {
    const p = connectPos.current;
    p.card = e.nativeEvent.layout.y;
    p.known = true;
    if (p.pending || settling()) {
      if (p.expanded) p.pending = false;
      scrollToConnect();
    }
  };
  const onColumnLayout = (e: LayoutChangeEvent) => {
    connectPos.current.col = e.nativeEvent.layout.y;
    if (settling()) scrollToConnect();
  };
  // 당겨서 새로고침: 서버 상태와, 알림 카드가 보이면 알림 설정('다음 실행' 시각)도 함께 (BH-16)
  const { pulling, onPull } = usePull(() => Promise.all([health.refetch(), full && owner ? notifySettings.refetch() : undefined]));
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
  // 휴대폰 화면은 '서버 연결' 칸이 목록에 바로 놓여 기둥이 없다 (넓은 창 오른쪽 기둥의 y 는 넓은 창에서만 잰다)
  useEffect(() => {
    if (!wide) connectPos.current.col = 0;
  }, [wide]);
  const insets = useSafeAreaInsets();
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
      {owner ? (
        <View style={styles.line}>
          <View style={{ flex: 1, paddingRight: space.md }}>
            <Text style={styles.label(t.ink)}>수수료·세금 차감 평가</Text>
            <Muted style={{ fontSize: font.tiny }}>토스 앱과 같은 평가금액·손익 (토스 연동 종목)</Muted>
          </View>
          <Toggle value={afterCost} onValueChange={(v) => void setAfterCost(v)} accessibilityLabel="수수료·세금 차감 평가" />
        </View>
      ) : null}
      {ux.oneHand || alerts.on ? (
        // 3-24 햅틱 끄기 (플래그 oneHand): 끄면 차트 십자선 진동까지 모두 멈춘다. 가격 알림(3-29) 진동도 이 스위치를 따른다
        <View style={styles.line}>
          <View style={{ flex: 1, paddingRight: space.md }}>
            <Text style={styles.label(t.ink)}>누를 때 진동</Text>
            <Muted style={{ fontSize: font.tiny }}>{ux.oneHand ? `${HAPTIC_NOTE}${alerts.on ? " · 가격 알림 진동도 이 스위치를 따릅니다" : ""}` : "가격 알림이 울릴 때 진동"}</Muted>
          </View>
          <Toggle value={haptics} onValueChange={(v) => void setHaptics(v)} accessibilityLabel="누를 때 진동" />
        </View>
      ) : null}
      {owner ? (
        <View style={{ gap: space.s, paddingTop: space.s }}>
          <Text style={styles.label(t.ink)}>잔고 정렬</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.s }}>
            {SORT_OPTIONS.map((o) => (
              <Chip key={o.value} label={o.label} accessibilityLabel={`잔고 정렬 ${o.label}`} active={sort === o.value} onPress={() => void setSort(o.value)} />
            ))}
          </View>
        </View>
      ) : null}
      {densityOn && owner ? (
        // 3-39 잔고 표시 기본 · 촘촘 (플래그 densityMode). 목록(DENSITY_OPTIONS)은 켜져 있을 때만 읽는다
        <View style={{ gap: space.s, paddingTop: space.sm }}>
          <View style={{ gap: space.xxs }}>
            <Text style={styles.label(t.ink)}>잔고 표시</Text>
            <Muted style={{ fontSize: font.tiny }}>촘촘: 종목 줄 높이를 줄이고 계좌 요약을 짧게 해 한 화면에 종목을 더 많이 봅니다 (매입금액·국내/해외는 기본에서)</Muted>
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.s }}>
            {DENSITY_OPTIONS.map((o) => (
              <Chip key={o.value} label={o.label} accessibilityLabel={`잔고 표시 ${o.label}`} active={density === o.value} onPress={() => void setDensity(o.value)} />
            ))}
          </View>
        </View>
      ) : null}
      {maOn ? (
        // 3-39 이동평균선 선 6개의 기간·색 (플래그 maCustom). 차트 칩 '설정'과 같은 화면
        <View style={styles.line}>
          <View style={{ flex: 1, paddingRight: space.md }}>
            <Text style={styles.label(t.ink)}>차트 이동평균선</Text>
            <Muted style={{ fontSize: font.tiny }}>선 6개의 기간(2~240)과 색</Muted>
          </View>
          <Button title="설정" icon="options-outline" variant="secondary" compact accessibilityLabel="이동평균선 기간·색 설정" onPress={() => router.push("/chart-lines")} />
        </View>
      ) : null}
      {hlOn ? (
        // 3-46 차트 최고·최저가 표시 (플래그 chartHighLow). 끄면 차트가 지금 그대로(가격 축 여백 포함). 저장값을 모르면 켬
        <View style={styles.line}>
          <View style={{ flex: 1, paddingRight: space.md }}>
            <Text style={styles.label(t.ink)}>차트 최고·최저가 표시</Text>
            <Muted style={{ fontSize: font.tiny }}>차트에 보이는 구간의 가장 높은 값과 낮은 값에 화살표, 가격·날짜, 지금 가격과의 차이(%)</Muted>
          </View>
          <Toggle value={chartHighLow !== false} onValueChange={(v) => void setChartHighLow(v)} accessibilityLabel="차트 최고·최저가 표시" />
        </View>
      ) : null}
      {owner ? (
        <View style={{ gap: space.xxs, paddingTop: space.sm }}>
          <Text style={styles.label(t.ink)}>홈 화면 위젯 갱신</Text>
          <Muted style={{ fontSize: font.tiny }}>{WIDGET_REFRESH_HELP}</Muted>
          {widgetLogOn ? <WidgetRefreshStatus /> : null}
        </View>
      ) : null}
      {widgetPolishOn && owner ? (
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
        <Text style={{ color: t.danger, fontSize: font.small }}>{serverErrorText(health.error, ux.connectionGuide)}</Text>
      ) : health.data?.limited ? (
        <Text style={{ color: t.danger, fontSize: font.small }}>
          {ux.connectionGuide ? `서버에 연결됐지만 '${TOKEN_FIELD}'이 없거나 맞지 않습니다. 아래 '${SERVER_SECTION}'에서 '${TOKEN_FIELD}'을 확인하세요.` : "서버에 연결됐지만 토큰이 없거나 맞지 않습니다. 아래 서버 연결에서 토큰을 입력하세요."}
        </Text>
      ) : health.data ? (
        <View>
          <Row label="서버 시각" value={formatDateKo(health.data.time, true)} />
          <Row label="시세" value={health.data.sources?.quotes ?? "-"} />
          <Row label="실시간" value={health.data.sources?.realtime ?? "-"} />
          {owner ? <Row label="앱 스트리밍" value={stream.connected ? `연결 · ${stream.ticks}건` : saverOn ? "폴링 3~4초 · 절약" : "폴링 3초"} /> : null}
          {saverOn ? <Row label="시세 받기" value={saverLabel(condStats())} /> : null}
          <Row label="뉴스" value={health.data.sources?.news ?? "-"} />
          <Row label="재무/공시" value={health.data.sources?.financials ?? "-"} />
          <Row label="수급" value={health.data.sources?.investorFlow ?? "-"} />
          <Row label="브리핑 모델" value={health.data.sources?.llm ?? "-"} />
          {recordsLabel ? <Row label="매매 기록" value={recordsLabel} /> : null}
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
      {ux.firstRun && owner ? (
        // 3-24 첫 실행 안내 다시 보기 (플래그 firstRun). 주인 아닌 계정에는 없다 (위젯·알림·토스 이야기라 — 첫 실행 안내도 띄우지 않는다)
        <Button title="처음 사용 안내 다시 보기" icon="help-circle-outline" variant="secondary" compact style={{ marginTop: space.xs }} onPress={() => router.push("/welcome")} />
      ) : null}
      <Muted style={{ fontSize: font.tiny, marginTop: space.xs }}>투자 판단의 책임은 본인에게 있으며, 본 서비스는 투자 권유가 아닙니다.</Muted>
    </Card>
  );
  const notify = full && !member ? <NotificationSettingsCard /> : null;
  // 가격 알림 칸 (3-29): 서버에 연결됐고 켜져 있을 때만, 알림 칸 바로 아래
  const priceAlertCard = full && alerts.on && !member ? <PriceAlertSettingsCard /> : null;
  const toss = full && !member ? <TossOpenApiCard /> : null;
  // 3-24 빈 칸 안내 (플래그 emptyGuide): 서버에 연결되지 않았거나 토큰이 맞지 않아 알림·토스 칸이 비었을 때 까닭과 버튼 하나
  const serverGap =
    ux.connectionGuide && !full && (health.isError || health.data?.limited) ? (
      <Card>
        <SectionTitle>알림 · 토스증권 연동</SectionTitle>
        <Muted>서버에 연결되면 여기에 알림 시간과 토스증권 연동 상태가 나옵니다. 아래 &apos;{SERVER_SECTION}&apos;에서 &apos;서버 주소&apos;와 &apos;{TOKEN_FIELD}&apos;을 확인하세요.</Muted>
        <Button title={`${SERVER_SECTION} 열기`} icon="chevron-down" variant="secondary" onPress={revealConnect} />
      </Card>
    ) : null;
  // '서버 연결' 칸 자리를 잰다 ('설정 열기'로 왔을 때 그 칸까지 스크롤 — 플래그가 꺼져 있으면 감싸지 않는다)
  const connectBox = measure ? <View onLayout={onConnectLayout}>{connect}</View> : connect;

  if (wide)
    return (
      // 넓은 창은 탭 화면 머리를 숨기므로(공통 틀) 상태 표시줄·좌우 화면 여백을 여기서 둔다 (왼쪽은 세로 탭 막대가 있으면 막대가 맡는다)
      <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top, paddingLeft: fold.rail ? 0 : insets.left, paddingRight: insets.right }}>
      <Screen refreshing={pulling} onRefresh={onPull} {...(measure ? { scrollRef, onScrollBeginDrag: stopSettling } : null)}>
        {/* 넓은 창: 칸이 좁으면 이름·값 줄의 값이 이름 아래 줄로 (큰 글씨에서도 두 칸을 지킨다) */}
        <RowWrapContext.Provider value={true}>
        {/* 두 칸: 왼쪽 표시·알림·정보 | 오른쪽 토스·업데이트·서버·서버 연결·화면 정보. 화면 읽기는 왼쪽 칸을 끝까지 읽고 오른쪽 칸으로.
            칸은 최대 폭(colMax)까지만 넓어지고, 남는 폭은 두 칸 사이로만 (칸은 화면 양 끝에 붙는다 — 가운데로 모으지 않는다).
            두 칸이 안 들어가는 넓은 창(폭 600~687 — 한 칸 최소 폭은 글자 크기와 상관없다)은 같은 틀을 세로로 쌓아 한 칸: 카드 차례는 휴대폰과 같고(정보는 맨 끝),
            한 칸 ↔ 두 칸이 바뀌어도 카드가 같은 자리에 남아 펼침 상태·입력 중인 값이 그대로다 (정보 카드만 옮겨진다 — 상태 없음) */}
        {/* 오른쪽 기둥 자리 재기('설정 열기'로 왔을 때 스크롤): 나중에 붙인 onLayout 은 자리가 바뀌기 전까지 알려 오지 않아 플래그를 받는 순간 한 번 새로 그린다 */}
        <View key={measure ? "cols-cg" : undefined} style={two ? styles.columns : styles.stacked} onLayout={onLayout}>
          <View style={two ? [styles.column, { maxWidth: colMax }] : styles.stackedPart}>
            <AccountCard />
            {display}
            {notify}
            {priceAlertCard}
            {serverGap}
            {two ? info : null}
          </View>
          <View style={two ? [styles.column, { maxWidth: colMax }] : styles.stackedPart} {...(measure ? { onLayout: onColumnLayout } : null)}>
            {toss}
            <AppUpdateCard />
            {server}
            {connectBox}
            <ScreenInfoCard />
            {two ? null : info}
          </View>
        </View>
        </RowWrapContext.Provider>
      </Screen>
      </View>
    );
  return (
    <Screen refreshing={pulling} onRefresh={onPull} {...(measure ? { scrollRef, onScrollBeginDrag: stopSettling } : null)}>
      <AccountCard />
      {display}
      {notify}
      {priceAlertCard}
      {toss}
      {serverGap}
      <AppUpdateCard />
      {server}
      {connectBox}
      <ScreenInfoCard />
      {info}
    </Screen>
  );
}

/** 설정 > 표시 '누를 때 진동' 설명 (3-24 글 그대로) */
const HAPTIC_NOTE = "줄 밀기·길게 누르기·정렬·관심 추가·당겨서 새로고침·차트 십자선. 차트 십자선 말고는 휴대폰의 '터치 진동'이 켜져 있어야 울립니다";

/** 서버 칸의 연결 오류 글: 플래그 emptyGuide 가 켜져 있으면 설정 칸 이름에 맞춘 문구 (lib/connectionError), 아니면 오류 글 그대로 */
function serverErrorText(error: unknown, guide: boolean): string {
  const kind = guide ? connectionKind(error) : null;
  if (kind) {
    const c = connectionText(kind);
    return `${c.title}. ${c.hint}`;
  }
  return error instanceof Error ? error.message : String(error);
}

const styles = {
  ...StyleSheet.create({
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
