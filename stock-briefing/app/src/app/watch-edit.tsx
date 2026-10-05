import React, { useEffect, useRef, useState } from "react";
import { Alert, Text, TextInput, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { useApi, useSearch } from "@/api/hooks";
import type { ListedStock, WatchItem } from "@/api/types";
import { Screen } from "@/components/Screen";
import { Button, Card, Muted, SectionTitle, Toggle } from "@/components/ui";
import { watchPriceInput } from "@/lib/watchlist";
import { useWatchlist, useWatchScope } from "@/lib/watchlistHooks";
import { font, space, touch, useTheme } from "@/theme";

export default function WatchEditScreen() {
  const scope = useWatchScope();
  return <WatchEditForm key={scope.join("|")} />;
}
function WatchEditForm() {
  const t = useTheme(), api = useApi(), qc = useQueryClient(), list = useWatchlist();
  const params = useLocalSearchParams<{ code?: string }>();
  const editCode = typeof params.code === "string" ? params.code : null;
  const [text, setText] = useState(""), [debounced, setDebounced] = useState("");
  const search = useSearch(debounced);
  const [selected, setSelected] = useState<{ code: string; name: string; currency: "KRW" | "USD" } | null>(null);
  const [start, setStart] = useState(""), [desired, setDesired] = useState(""), [alerts, setAlerts] = useState(true);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  useEffect(() => { const timer = setTimeout(() => setDebounced(text.trim()), 150); return () => clearTimeout(timer); }, [text]);
  if (editCode && !selected) {
    const item = list.data?.items.find(s => s.code === editCode);
    if (item) { setSelected(item); setStart(String(item.startPrice)); setDesired(String(item.desiredPrice)); setAlerts(item.alerts); }
  }
  const choose = (s: ListedStock) => {
    const existing: WatchItem | undefined = list.data?.items.find(w => w.code === s.code);
    setSelected({ code: s.code, name: s.name, currency: /^\d{6}$/.test(s.code) ? "KRW" : "USD" });
    setStart(existing ? String(existing.startPrice) : s.price ? String(s.price) : "");
    setDesired(existing ? String(existing.desiredPrice) : ""); setAlerts(existing?.alerts ?? true); setError(null);
  };
  const finish = () => { void qc.invalidateQueries({ predicate: q => q.queryKey[1] === "watchlist" }); router.back(); };
  const save = async () => {
    if (!selected || sending.current) return;
    const a = watchPriceInput(start, selected.currency), b = watchPriceInput(desired, selected.currency);
    if (a === null || b === null) { setError(selected.currency === "KRW" ? "두 가격을 1원 이상의 원 단위로 입력하세요" : "두 가격을 $0.01 이상, 소수 둘째 자리까지 입력하세요"); return; }
    sending.current = true; setBusy(true); setError(null);
    try { await api.saveWatch(selected.code, { startPrice: a, desiredPrice: b, alerts }); finish(); }
    catch (e) { setError(e instanceof Error ? e.message : "저장하지 못했습니다. 다시 시도해 주세요"); }
    finally { sending.current = false; setBusy(false); }
  };
  const remove = () => selected && Alert.alert("관심종목에서 빼기", `${selected.name}의 관심 가격과 알림을 지웁니다. 잔고·보고서는 유지됩니다.`, [
    { text: "취소", style: "cancel" }, { text: "빼기", style: "destructive", onPress: async () => {
      if (sending.current) return; sending.current = true; setBusy(true);
      try { await api.removeWatch(selected.code); finish(); } catch (e) { setError(e instanceof Error ? e.message : "지우지 못했습니다"); }
      finally { sending.current = false; setBusy(false); }
    } },
  ]);
  const inputStyle = { color: t.ink, backgroundColor: t.surfaceAlt, borderColor: t.line, borderWidth: 1, padding: space.md, minHeight: touch.min, fontSize: font.body };
  return <Screen><Stack.Screen options={{ title: editCode ? "관심 가격 수정" : "관심종목 담기" }} />
    {!list.available ? <Card><Muted>관심종목 기능을 사용할 수 없습니다.</Muted></Card> : !selected ? <Card>
      {editCode ? <><Muted>{list.isPending ? "저장한 관심 가격을 불러오는 중입니다" : "관심종목을 불러오지 못했거나 이미 삭제되었습니다"}</Muted><Button title="다시 확인" onPress={() => { void list.refetch(); }} /></> : <>
        <SectionTitle>종목 검색</SectionTitle><TextInput value={text} onChangeText={setText} placeholder="국내 종목명 또는 미국 티커" placeholderTextColor={t.muted} accessibilityLabel="관심종목 검색" autoCapitalize="characters" style={inputStyle} />
        {search.pending || text.trim() !== debounced ? <Muted>검색 중입니다</Muted> : null}
        {search.isError ? <><Muted>검색 결과를 받지 못했습니다</Muted><Button title="검색 다시 시도" onPress={() => { void search.refetch(); }} /></> : null}
        {(search.data?.results ?? []).map(s => <Button key={s.code} title={`${s.name} · ${s.code}`} accessibilityLabel={`${s.name} 관심 가격 입력`} variant="secondary" onPress={() => choose(s)} />)}
        {debounced && !search.pending && !search.isError && !(search.data?.results.length) ? <Muted>검색 결과가 없습니다</Muted> : null}
      </>}
    </Card> : <Card>
      <SectionTitle>{selected.name} · {selected.code}</SectionTitle><Muted>{selected.currency === "KRW" ? "모든 가격은 원(KRW) 기준입니다" : "모든 가격은 달러(USD) 기준입니다"}</Muted>
      <Text style={{ color: t.ink, fontSize: font.body }}>관심 시작 가격</Text><TextInput value={start} onChangeText={setStart} editable={!busy} keyboardType="decimal-pad" accessibilityLabel="관심 시작 가격" style={inputStyle} />
      <Text style={{ color: t.ink, fontSize: font.body }}>구매희망 가격</Text><TextInput value={desired} onChangeText={setDesired} editable={!busy} keyboardType="decimal-pad" accessibilityLabel="구매희망 가격" style={inputStyle} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}><Text style={{ flex: 1, color: t.ink, fontSize: font.body }}>관심 시작 대비 5% 구간 알림</Text><Toggle value={alerts} onValueChange={setAlerts} accessibilityLabel="관심 시작 대비 5% 구간 알림" /></View>
      <Muted>±5%, ±10%, ±15% 순서로 새 구간에 도달하면 알립니다. 같은 방향의 같은 구간은 한 번만 알리며, 여러 구간을 건너뛰면 가장 큰 구간 한 건으로 알립니다. 시작 가격을 바꾸면 구간 기록이 새로 시작됩니다.</Muted>
      <Muted>서버가 약 30초 간격으로 확인합니다. 시세 지연·통신 상태에 따라 알림이 늦거나 순간 변동을 놓칠 수 있습니다. 기기 알림 수신은 설정의 알림에서 켜 주세요. 원격 푸시가 없는 설치본은 앱을 닫으면 백그라운드 확인(15분 이상) 때 전달됩니다.</Muted>
      {error ? <Text accessibilityRole="alert" style={{ color: t.danger, fontSize: font.body }}>{error}</Text> : null}
      <Button title="저장" loading={busy} onPress={() => { void save(); }} />
      {editCode ? <Button title="관심종목에서 빼기" disabled={busy} variant="danger" onPress={remove} /> : <Button title="다른 종목 선택" disabled={busy} variant="ghost" onPress={() => { setSelected(null); setStart(""); setDesired(""); }} />}
    </Card>}
  </Screen>;
}
export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteError";
