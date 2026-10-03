import { useLocalSearchParams } from "expo-router";
import React, { useEffect, useState } from "react";
import { Platform, Text, View } from "react-native";
import { useFeature } from "@/api/hooks";
import { Screen } from "@/components/Screen";
import { Button, Card, Chip, Muted, SectionTitle, Toggle } from "@/components/ui";
import { useAccountView, useSessionVersion } from "@/lib/account";
import { useSettings } from "@/lib/settings";
import { sessionIdentityVersion } from "@/lib/session";
import { font, space, useTheme } from "@/theme";
import { loadCachedWidgetData, readPnlMode, type WidgetData } from "@/widgets/data";
import { fontScaleNow } from "@/widgets/fontScale";
import { assertWidgetPreferenceScope, defaultWidgetPreferences, readWidgetPreferences, saveWidgetPreferences, widgetPreferenceScope, type WidgetPreferenceScope, type WidgetPreferences } from "@/widgets/preferences";
import { renderFor } from "@/widgets/render";
import { WIDGET_NAMES } from "@/widgets/widgets";

type InstalledWidget = { widgetId: number; widgetName: string; width: number; height: number };
const LABELS: Record<string, string> = { [WIDGET_NAMES.holdings]: "내 종목 시세", [WIDGET_NAMES.asset]: "총 평가금액", [WIDGET_NAMES.briefing]: "브리핑", [WIDGET_NAMES.market]: "지수·환율" };

/** 설정 변경은 이 휴대폰의 선택한 위젯만 다시 그린다. 계좌·시세 조회를 새로 요청하지 않는다. */
export default function WidgetSettingsScreen() {
  const params = useLocalSearchParams<{ id?: string }>();
  const enabled = useFeature("widgetClarity", false);
  const { member } = useAccountView();
  const version = useSessionVersion();
  const { apiUrl, apiToken } = useSettings();
  const t = useTheme();
  const [widgets, setWidgets] = useState<InstalledWidget[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [prefs, setPrefs] = useState<WidgetPreferences>(defaultWidgetPreferences());
  const [prefsId, setPrefsId] = useState<number | null>(null);
  const [scope, setScope] = useState<WidgetPreferenceScope | null>(null);
  const [data, setData] = useState<WidgetData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    if (!enabled || member || Platform.OS !== "android") return;
    void (async () => {
      const owner = await widgetPreferenceScope();
      const { getWidgetInfo } = await import("react-native-android-widget");
      const lists = await Promise.all(Object.values(WIDGET_NAMES).map((name) => getWidgetInfo(name)));
      const list = lists.flat();
      const cached = await loadCachedWidgetData();
      await assertWidgetPreferenceScope(owner);
      if (!current) return;
      setWidgets(list); setScope(owner); setData(cached); setPrefsId(null); setMessage(null);
      const id = Number(params.id);
      setSelected(list.some((item) => item.widgetId === id) ? id : list[0]?.widgetId ?? null);
    })().catch(() => { if (current) setMessage("설치된 위젯을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요."); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [enabled, member, apiUrl, apiToken, version, params.id, retry]);
  useEffect(() => {
    let current = true;
    if (selected === null || !scope) return;
    void readPnlMode().then((fallback) => readWidgetPreferences(selected, fallback, scope))
      .then((value) => { if (current) { setPrefs(value); setPrefsId(selected); } })
      .catch(() => { if (current) { setScope(null); setMessage("위젯 설정을 읽지 못했습니다. 다시 확인한 뒤 저장해 주세요."); } })
      .finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, [selected, scope]);
  const widget = widgets.find((item) => item.widgetId === selected);
  const ownsScope = !!scope && scope.identity === sessionIdentityVersion() && scope.apiUrl === apiUrl;
  const editable = enabled && !member && ownsScope && prefsId === selected && !busy && !loading;
  const change = (patch: Partial<WidgetPreferences>) => { if (editable) { setPrefs((old) => ({ ...old, ...patch })); setMessage(null); } };
  const save = async () => {
    if (!widget || !scope || !editable) return;
    setBusy(true); setMessage(null);
    try {
      const { getWidgetInfo, requestWidgetUpdateById } = await import("react-native-android-widget");
      if (!(await getWidgetInfo(widget.widgetName)).some((item) => item.widgetId === widget.widgetId)) throw new Error("삭제된 위젯");
      await saveWidgetPreferences(widget.widgetId, prefs, scope);
      const cached = await loadCachedWidgetData();
      await assertWidgetPreferenceScope(scope);
      await requestWidgetUpdateById({ widgetName: widget.widgetName, widgetId: widget.widgetId, renderWidget: async (box) => {
        await assertWidgetPreferenceScope(scope);
        const rendered = await renderFor(widget.widgetName, cached, box, { now: Date.now(), fontScale: fontScaleNow(), pnlMode: await readPnlMode() });
        await assertWidgetPreferenceScope(scope);
        return rendered;
      } });
      await assertWidgetPreferenceScope(scope);
      setMessage("이 위젯에 적용했습니다.");
    } catch { setMessage("위젯 설정 저장 또는 화면 반영에 실패했습니다. 위젯과 로그인 상태를 확인하고 다시 시도해 주세요."); }
    finally { setBusy(false); }
  };
  if (!enabled || member || Platform.OS !== "android") return <Screen><Card><Muted>현재 이 계정에서 위젯별 설정을 사용할 수 없습니다.</Muted></Card></Screen>;
  return <Screen><Card>
    <SectionTitle>홈 화면 위젯 선택</SectionTitle>
    <Muted>위젯마다 따로 적용됩니다. 종목을 상단에 고정해도 전체 평가금액은 바뀌지 않습니다. 같은 크기의 위젯은 홈 화면에서 해당 위젯의 설정을 눌러 구분해 주세요.</Muted>
    {loading ? <Muted>설치된 위젯을 확인하고 있습니다.</Muted> : null}
    {!loading && !widgets.length ? <Muted>홈 화면에 위젯을 추가한 뒤 다시 확인해 주세요.</Muted> : null}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.s }}>
      {widgets.map((item, index) => <Chip key={item.widgetId} label={`${LABELS[item.widgetName] ?? "위젯"} ${index + 1} · ${Math.round(item.width)}×${Math.round(item.height)}`} active={selected === item.widgetId} onPress={() => { if (!busy && selected !== item.widgetId) { setPrefsId(null); setBusy(true); setMessage(null); setSelected(item.widgetId); } }} />)}
    </View>
    <Button title="설치된 위젯 다시 확인" variant="secondary" disabled={busy || loading} onPress={() => { setScope(null); setPrefsId(null); setData(null); setWidgets([]); setMessage(null); setLoading(true); setRetry((old) => old + 1); }} />
  </Card>
    {widget?.widgetName === WIDGET_NAMES.holdings && ownsScope && prefsId === selected ? <Card>
      <SectionTitle>이 위젯 표시</SectionTitle>
      <Muted>손익 기준</Muted>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.s }}>
        <Chip label="누적 손익" active={prefs.pnlMode === "cumulative"} onPress={() => change({ pnlMode: "cumulative" })} />
        <Chip label="전일 대비 손익" active={prefs.pnlMode === "day"} onPress={() => change({ pnlMode: "day" })} />
      </View>
      <Muted>종목 순서</Muted>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.s }}>
        <Chip label="평가금액순" active={prefs.sort === "value"} onPress={() => change({ sort: "value" })} />
        <Chip label="이름순" active={prefs.sort === "name"} onPress={() => change({ sort: "name" })} />
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}><Text style={{ color: t.ink, fontSize: font.body, flex: 1 }}>시장 요약 줄 표시</Text><Toggle value={prefs.showMarketLine} onValueChange={(value) => change({ showMarketLine: value })} accessibilityLabel="이 위젯 시장 요약 줄 표시" /></View>
      <SectionTitle>상단 고정 종목</SectionTitle>
      <Muted>최대 20개를 누른 순서대로 먼저 표시합니다. 다시 누르면 고정이 풀립니다. 화면에 들어가는 종목 수는 위젯 크기에 따라 달라집니다.</Muted>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.s }}>
        {(data?.stocks ?? []).map((stock) => { const position = prefs.pinnedCodes.indexOf(stock.code); return <Chip key={stock.code} label={`${position >= 0 ? `${position + 1}. ` : ""}${stock.name}`} active={position >= 0} onPress={() => change({ pinnedCodes: position >= 0 ? prefs.pinnedCodes.filter((code) => code !== stock.code) : [...prefs.pinnedCodes, stock.code].slice(0, 20) })} />; })}
      </View>
      {!data?.stocks.length ? <Muted>앱에서 잔고를 확인한 뒤 다시 열면 종목을 선택할 수 있습니다.</Muted> : null}
      <Button title="이 위젯에 적용" disabled={!editable} loading={busy} onPress={() => void save()} />
    </Card> : widget && widget.widgetName !== WIDGET_NAMES.holdings ? <Card><Muted>손익 기준·종목 순서·시장 요약 줄은 ‘내 종목 시세’ 위젯에서 설정할 수 있습니다. 이 위젯은 크기에 맞춰 정보를 표시합니다.</Muted></Card> : null}
    {message ? <Card><Text accessibilityRole="alert" style={{ color: t.ink, fontSize: font.body }}>{message}</Text></Card> : null}
  </Screen>;
}
