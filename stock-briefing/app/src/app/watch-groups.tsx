import Ionicons from "@expo/vector-icons/Ionicons";
import { router } from "expo-router";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { AccessibilityInfo, Alert, Pressable, ScrollView, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useStocks } from "@/api/hooks";
import type { RegisteredWithQuote } from "@/api/types";
import { Screen } from "@/components/Screen";
import { TwoPane } from "@/components/TwoPane";
import { Button, Card, Chip, Empty, ErrorView, Loading, Muted, SectionTitle } from "@/components/ui";
import { WatchGroupNameSheet } from "@/components/WatchGroupNameSheet";
import { moveWithin, WatchMenuHost, type WatchMenuTarget } from "@/components/WatchRowSheet";
import { haptic } from "@/lib/haptics";
import { splitHoldings } from "@/lib/portfolio";
import { SORT_OPTIONS, useSettings } from "@/lib/settings";
import { useFoldLayout } from "@/lib/useFoldLayout";
import { isWide } from "@/lib/windowClass";
import { dragShift, dragTarget } from "@/lib/watchDrag";
import { deleteGroupMessage, NONE_NAME, stockSub, WATCH_GROUP_LIMIT, watchModel, type WatchGroup, type WatchModel } from "@/lib/watchGroups";
import { useWatchGroups } from "@/lib/watchGroupsQuery";
import { VIEW_DEFAULT, type WatchSelected } from "@/lib/watchView";
import { font, layout, space, touch, useTheme } from "@/theme";

/**
 * '관심 그룹·순서' (3-34, 기능 플래그 watchGroups — 잔고 관심 칸 칩 줄의 [그룹·순서]에서 온다).
 *  - 그룹 카드: 그룹 만들기(12개까지)·이름 바꾸기·지우기(종목은 관심으로 남고 그룹 없음 맨 끝)·순서(↑↓). '그룹 없음'은 늘 맨 끝이라 옮기거나 지울 수 없다
 *  - 종목 순서 카드: 편집할 그룹을 칩으로 고르고, 줄 왼쪽 ≡ 를 길게(250ms) 눌러 끌거나 ↑·↓ 버튼·⋯(그룹 옮기기 · 맨 위로 · 맨 아래로)으로 순서를 바꾼다.
 *    화면 읽기는 끌기 대신 버튼과 줄의 '동작'(위로 · 아래로 · 맨 위로 · 맨 아래로 · 그룹 옮기기)으로 같은 일을 하고, 옮긴 뒤 '삼성전자를 반도체 1번째로 옮겼습니다'
 *  - 저장은 누르는 즉시 화면에 보이고 서버에 차례로 보낸다 (components/WatchGroupsProvider). 실패하면 '저장하지 못했습니다' 창 + 서버 값으로 되돌림
 *  - 넓은 창: 2단(twoPane)이면 왼쪽 그룹 · 오른쪽 종목 순서, 2단이 아닌 넓은 창(펼친 세로 704)은 읽기 폭 720 가운데
 *  - 보유 중인 종목은 여기에 없다 (관심 종목만). 끌 때 화면 끝 자동 스크롤은 없다 — 긴 목록은 ↑·↓·맨 위로·맨 아래로
 */
export default function WatchGroupsScreen() {
  const wg = useWatchGroups();
  if (wg.status === "off")
    return (
      <Screen>
        <Empty
          title="지금은 관심 그룹 기능이 꺼져 있습니다"
          action={<Button title="돌아가기" variant="secondary" onPress={() => (router.canGoBack() ? router.back() : router.dismissTo("/"))} />}
        />
      </Screen>
    );
  if (wg.status === "error")
    return (
      <Screen>
        <ErrorView error={wg.error} onRetry={wg.refetch} />
      </Screen>
    );
  if (wg.status === "loading")
    return (
      <Screen>
        <Loading />
      </Screen>
    );
  return <WatchGroupsBody />;
}

/** 처음 편집할 그룹: 잔고에서 고른 칩(그룹이면 그 그룹, 그룹 없음이면 그룹 없음), '전체'였으면 첫 그룹, 그룹이 없으면 그룹 없음 */
function initialGroup(selected: WatchSelected, groups: readonly WatchGroup[]): number | null {
  if (typeof selected === "number" && groups.some((g) => g.id === selected)) return selected;
  if (selected === "none") return null;
  return groups[0]?.id ?? null;
}

function WatchGroupsBody() {
  const wg = useWatchGroups();
  const fold = useFoldLayout();
  const stocks = useStocks();
  const { sort, setSort } = useSettings();
  const groups = wg.layout.groups;
  const list = stocks.data;
  const model = useMemo(() => (list ? watchModel(splitHoldings(list).watch, wg.layout, VIEW_DEFAULT, true) : null), [list, wg.layout]);
  const [picked, setPicked] = useState<{ id: number | null } | null>(null);
  // 고른 그룹이 지워졌으면 처음 값으로
  const editing = picked && (picked.id === null || groups.some((g) => g.id === picked.id)) ? picked.id : initialGroup(wg.view.selected, groups);
  const [naming, setNaming] = useState<{ mode: "create" } | { mode: "rename"; group: WatchGroup } | null>(null);
  const [menu, setMenu] = useState<WatchMenuTarget | null>(null);
  const [dragging, setDragging] = useState(false);

  const counts = new Map(model?.buckets.map((b) => [b.groupId, b.stocks.length]) ?? []);
  const groupCard = (
    <GroupCard
      groups={groups}
      counts={counts}
      onCreate={() => setNaming({ mode: "create" })}
      onRename={(g) => setNaming({ mode: "rename", group: g })}
      onDelete={(g) =>
        Alert.alert(`‘${g.name}’ 그룹 지우기`, deleteGroupMessage(counts.get(g.id) ?? 0), [
          { text: "취소", style: "cancel" },
          { text: "지우기", style: "destructive", onPress: () => wg.ops.remove(g.id) },
        ])
      }
      onMove={(from, to) => {
        const ids = groups.map((g) => g.id);
        const [id] = ids.splice(from, 1);
        ids.splice(to, 0, id!);
        haptic("select");
        wg.ops.order(ids);
        AccessibilityInfo.announceForAccessibility(`${groups[from]!.name} 그룹을 ${to + 1}번째로 옮겼습니다`);
      }}
    />
  );
  const sortLabel = SORT_OPTIONS.find((o) => o.value === sort)?.label ?? "정렬";
  const orderCard = (
    <OrderCard
      model={model}
      loading={!list}
      editing={editing}
      groups={groups}
      sortNote={
        sort === "created" ? null : (
          <View style={styles.notice}>
            <Muted>지금 잔고는 ‘{sortLabel}’ 순으로 보고 있어, 여기서 정한 순서는 정렬을 ‘등록순’으로 바꾸면 보입니다.</Muted>
            <View style={styles.noticeActions}>
              <Button title="등록순으로 보기" variant="secondary" compact onPress={() => void setSort("created")} />
            </View>
          </View>
        )
      }
      onPick={(id) => setPicked({ id })}
      onMenu={(s) => setMenu({ stock: s, step: "menu" })}
      onDragging={setDragging}
    />
  );
  const sheets = (
    <>
      {naming ? (
        <WatchGroupNameSheet
          mode={naming.mode}
          groups={groups}
          {...(naming.mode === "rename" ? { initial: naming.group.name, exceptId: naming.group.id } : null)}
          onSubmit={(name) => (naming.mode === "rename" ? wg.ops.rename(naming.group.id, name) : wg.ops.create(name))}
          onDone={(res) => {
            if (res.created) setPicked({ id: res.created.id });
          }}
          onClose={() => setNaming(null)}
        />
      ) : null}
      <WatchMenuHost target={menu} model={model} mine variant="editor" onClose={() => setMenu(null)} />
    </>
  );
  if (fold.twoPane)
    return (
      <Screen scroll={false}>
        <TwoPane
          left={
            <ScrollView contentContainerStyle={styles.pane}>{groupCard}</ScrollView>
          }
          right={
            <ScrollView contentContainerStyle={styles.pane} scrollEnabled={!dragging}>
              {orderCard}
            </ScrollView>
          }
        />
        {sheets}
      </Screen>
    );
  return (
    <Screen scroll={false}>
      <ScrollView contentContainerStyle={[styles.pane, fold.on && isWide(fold) ? styles.readable : null]} scrollEnabled={!dragging}>
        {groupCard}
        {orderCard}
      </ScrollView>
      {sheets}
    </Screen>
  );
}

/** ↑ · ↓ · ⋯ 같은 44×44 아이콘 버튼 (끝에서는 흐리게 · 사용 불가) */
function IconBtn({ icon, label, disabled, onPress }: { icon: keyof typeof Ionicons.glyphMap; label: string; disabled?: boolean; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [styles.iconBtn, { opacity: disabled ? 0.3 : pressed ? 0.6 : 1 }]}
    >
      <Ionicons name={icon} size={font.h2} color={t.sub} />
    </Pressable>
  );
}

function GroupCard({
  groups,
  counts,
  onCreate,
  onRename,
  onDelete,
  onMove,
}: {
  groups: readonly WatchGroup[];
  counts: Map<number | null, number>;
  onCreate: () => void;
  onRename: (g: WatchGroup) => void;
  onDelete: (g: WatchGroup) => void;
  onMove: (from: number, to: number) => void;
}) {
  const t = useTheme();
  const full = groups.length >= WATCH_GROUP_LIMIT;
  return (
    <Card>
      <SectionTitle right={<Button title="새 그룹" icon="add" variant="secondary" compact disabled={full} accessibilityLabel="새 그룹 만들기" onPress={onCreate} />}>그룹</SectionTitle>
      {groups.length === 0 ? <Muted style={styles.gap}>아직 그룹이 없습니다. ‘새 그룹’으로 반도체·배당처럼 묶어 보세요.</Muted> : null}
      {groups.map((g, i) => {
        const n = counts.get(g.id) ?? 0;
        const menu = () =>
          Alert.alert(g.name, undefined, [
            { text: "이름 바꾸기", onPress: () => onRename(g) },
            { text: "지우기", style: "destructive", onPress: () => onDelete(g) },
            { text: "취소", style: "cancel" },
          ]);
        return (
          <View key={g.id} style={[styles.groupRow, { borderTopColor: t.line }]}>
            <View
              accessible
              accessibilityLabel={`${g.name}, ${n}종목, 그룹 ${i + 1}번째`}
              accessibilityActions={[
                ...(i > 0 ? [{ name: "up", label: "위로 옮기기" }] : []),
                ...(i < groups.length - 1 ? [{ name: "down", label: "아래로 옮기기" }] : []),
                { name: "rename", label: "이름 바꾸기" },
                { name: "delete", label: "지우기" },
              ]}
              onAccessibilityAction={(e) => {
                const a = e.nativeEvent.actionName;
                if (a === "up") onMove(i, i - 1);
                else if (a === "down") onMove(i, i + 1);
                else if (a === "rename") onRename(g);
                else if (a === "delete") onDelete(g);
              }}
              style={styles.grow}
            >
              <Text style={{ color: t.ink, fontSize: font.body, fontWeight: "700" }}>{g.name}</Text>
              <Text style={{ color: t.muted, fontSize: font.small }}>{n}종목</Text>
            </View>
            <IconBtn icon="arrow-up" label={`${g.name} 위로`} disabled={i === 0} onPress={() => onMove(i, i - 1)} />
            <IconBtn icon="arrow-down" label={`${g.name} 아래로`} disabled={i === groups.length - 1} onPress={() => onMove(i, i + 1)} />
            <IconBtn icon="ellipsis-horizontal" label={`${g.name} 그룹 메뉴`} onPress={menu} />
          </View>
        );
      })}
      <View style={[styles.groupRow, { borderTopColor: t.line }]}>
        <View accessible accessibilityLabel={`${NONE_NAME}, ${counts.get(null) ?? 0}종목, 늘 맨 끝`} style={styles.grow}>
          <Text style={{ color: t.sub, fontSize: font.body, fontWeight: "700" }}>{NONE_NAME}</Text>
          <Text style={{ color: t.muted, fontSize: font.small }}>{counts.get(null) ?? 0}종목 · 늘 맨 끝</Text>
        </View>
      </View>
      <Muted style={styles.gap}>{full ? "그룹은 12개까지 만들 수 있습니다" : "그룹은 12개, 이름은 10자까지입니다."}</Muted>
    </Card>
  );
}

function OrderCard({
  model,
  loading,
  editing,
  groups,
  sortNote,
  onPick,
  onMenu,
  onDragging,
}: {
  model: WatchModel | null;
  loading: boolean;
  editing: number | null;
  groups: readonly WatchGroup[];
  sortNote: React.ReactNode;
  onPick: (id: number | null) => void;
  onMenu: (s: RegisteredWithQuote) => void;
  onDragging: (on: boolean) => void;
}) {
  const bucket = model?.buckets.find((b) => b.groupId === editing) ?? null;
  const total = model?.buckets.reduce((a, b) => a + b.stocks.length, 0) ?? 0;
  return (
    <Card>
      <SectionTitle>{groups.length ? "종목 순서" : "관심 종목 순서"}</SectionTitle>
      {sortNote}
      {groups.length && model ? (
        <View style={styles.chips}>
          {model.buckets.map((b) => (
            <Chip
              key={String(b.groupId)}
              label={`${b.name} ${b.stocks.length}`}
              active={b.groupId === editing}
              accessibilityLabel={`${b.name} 순서 편집, ${b.stocks.length}종목`}
              onPress={() => onPick(b.groupId)}
            />
          ))}
        </View>
      ) : null}
      {loading || !model ? (
        <Loading />
      ) : total === 0 ? (
        <Muted style={styles.gap}>관심 종목이 없습니다. 종목 화면의 ‘관심 추가’로 모은 뒤 순서를 정할 수 있습니다.</Muted>
      ) : !bucket || bucket.stocks.length === 0 ? (
        <Muted style={styles.gap}>이 그룹에 종목이 없습니다. 다른 그룹 종목의 ⋯ 에서 ‘그룹 옮기기’로 넣으세요.</Muted>
      ) : (
        <OrderList key={String(editing)} model={model} stocks={bucket.stocks} onMenu={onMenu} onDragging={onDragging} />
      )}
      <Muted style={styles.gap}>≡ 를 길게 누른 채 끌어 순서를 바꿀 수 있습니다. ↑·↓ 버튼으로도 됩니다.</Muted>
      <Muted>보유 중인 종목은 여기에 없습니다.</Muted>
    </Card>
  );
}

/** 끄는 중인 줄: 시작 칸 · 손가락이 움직인 거리 · 지금 목표 칸 */
interface Drag {
  from: number;
  dy: number;
  to: number;
}

/**
 * 한 그룹의 종목 순서 목록. 줄 왼쪽 ≡ 를 250ms 길게 누르면 줄이 들리고(진동) 위아래로 따라오며, 다른 줄 가운데를 지날 때마다 자리가 바뀐다(진동).
 * 놓으면 저장. 끄는 동안 바깥 스크롤은 멈춘다 (onDragging)
 */
function OrderList({ model, stocks, onMenu, onDragging }: { model: WatchModel; stocks: RegisteredWithQuote[]; onMenu: (s: RegisteredWithQuote) => void; onDragging: (on: boolean) => void }) {
  const wg = useWatchGroups();
  // 줄 높이 (글자 크기에 따라 다르다): 그릴 때 쓰는 값은 상태, 끄는 동안 콜백이 읽는 값은 ref (둘 다 onLayout 때 적는다)
  const [heights, setHeights] = useState<number[]>([]);
  const heightsRef = useRef<number[]>([]);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const live = useRef<DragHandlers>({ start: () => {}, update: () => {}, end: () => {} });
  useEffect(() => {
    const set = (d: Drag | null) => {
      dragRef.current = d;
      setDrag(d);
    };
    live.current = {
      start: (i) => {
        haptic("press");
        onDragging(true);
        set({ from: i, dy: 0, to: i });
      },
      update: (i, dy) => {
        const to = dragTarget(heightsRef.current.slice(0, stocks.length), i, dy);
        if (dragRef.current && to !== dragRef.current.to) haptic("select");
        set({ from: i, dy, to });
      },
      end: () => {
        const d = dragRef.current;
        if (!d) return;
        set(null);
        onDragging(false);
        if (d.to !== d.from) moveWithin(wg.ops, model, stocks[d.from]!, d.to);
      },
    };
  });
  return (
    <View>
      {stocks.map((s, i) => {
        const shift = drag ? (i === drag.from ? drag.dy : dragShift(heights, drag.from, drag.to, i)) : 0;
        return (
          <OrderRow
            key={s.code}
            stock={s}
            index={i}
            model={model}
            lifted={drag?.from === i}
            shift={shift}
            live={live}
            onLayout={(e) => {
              const h = e.nativeEvent.layout.height;
              heightsRef.current[i] = h;
              setHeights((prev) => (prev[i] === h ? prev : Object.assign([...prev], { [i]: h })));
            }}
            onMenu={() => onMenu(s)}
          />
        );
      })}
    </View>
  );
}

interface DragHandlers {
  start: (i: number) => void;
  update: (i: number, dy: number) => void;
  end: () => void;
}

function OrderRow({
  stock,
  index,
  model,
  lifted,
  shift,
  live,
  onLayout,
  onMenu,
}: {
  stock: RegisteredWithQuote;
  index: number;
  model: WatchModel;
  lifted: boolean;
  shift: number;
  live: React.RefObject<DragHandlers>;
  onLayout: (e: LayoutChangeEvent) => void;
  onMenu: () => void;
}) {
  const t = useTheme();
  const wg = useWatchGroups();
  const p = model.pos.get(stock.code)!;
  const first = p.index === 0;
  const last = p.index === p.count - 1;
  const where = model.hasGroups ? p.groupName : "관심";
  // 제스처 객체는 칸마다 한 번만 만든다 (렌더마다 새로 만들면 끄는 중에 끊긴다). 콜백은 JS 에서 돈다 (잔고 줄 밀기·차트와 같은 방식, 새 네이티브 모듈 없음)
  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .activateAfterLongPress(250)
        .maxPointers(1)
        .onStart(() => live.current?.start(index))
        .onUpdate((e) => live.current?.update(index, e.translationY))
        .onFinalize(() => live.current?.end()),
    [live, index],
  );
  const go = (to: number) => moveWithin(wg.ops, model, stock, to);
  const actions = [
    ...(first ? [] : [{ name: "up", label: "위로 옮기기" }, { name: "top", label: "맨 위로 옮기기" }]),
    ...(last ? [] : [{ name: "down", label: "아래로 옮기기" }, { name: "bottom", label: "맨 아래로 옮기기" }]),
    { name: "group", label: "그룹 옮기기" },
  ];
  return (
    <View
      onLayout={onLayout}
      style={[
        styles.stockRow,
        { borderTopColor: t.line, backgroundColor: lifted ? t.surfaceAlt : t.surface, transform: [{ translateY: shift }, { scale: lifted ? 1.02 : 1 }], zIndex: lifted ? 2 : 0 },
        lifted ? [styles.lifted, { shadowColor: t.shadow }] : null,
      ]}
    >
      <GestureDetector gesture={gesture}>
        <View style={styles.handle} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
          <Ionicons name="reorder-three-outline" size={font.title} color={t.muted} />
        </View>
      </GestureDetector>
      <View
        accessible
        accessibilityLabel={`${stock.name}, ${where} ${p.index + 1}번째, ${p.count}종목 중`}
        accessibilityActions={actions}
        onAccessibilityAction={(e) => {
          const a = e.nativeEvent.actionName;
          if (a === "up") go(p.index - 1);
          else if (a === "down") go(p.index + 1);
          else if (a === "top") go(0);
          else if (a === "bottom") go(p.count - 1);
          else if (a === "group") onMenu();
        }}
        style={styles.grow}
      >
        <Text style={{ color: t.ink, fontSize: font.body, fontWeight: "700" }} numberOfLines={2}>
          {stock.name}
        </Text>
        <Text style={{ color: t.muted, fontSize: font.small }} numberOfLines={1}>
          {stockSub(stock)}
        </Text>
      </View>
      <IconBtn icon="arrow-up" label={`${stock.name} 위로 옮기기`} disabled={first} onPress={() => go(p.index - 1)} />
      <IconBtn icon="arrow-down" label={`${stock.name} 아래로 옮기기`} disabled={last} onPress={() => go(p.index + 1)} />
      <IconBtn icon="ellipsis-horizontal" label={`${stock.name} 메뉴`} onPress={onMenu} />
    </View>
  );
}

const styles = StyleSheet.create({
  pane: { paddingBottom: space.xl, gap: space.sm },
  readable: { width: "100%", maxWidth: layout.readableMax, alignSelf: "center" },
  grow: { flex: 1, minWidth: 0 },
  gap: { marginTop: space.sm },
  notice: { gap: space.xs, marginBottom: space.sm },
  noticeActions: { flexDirection: "row" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.s, paddingVertical: space.sm },
  groupRow: { flexDirection: "row", alignItems: "center", gap: space.xs, minHeight: 56, paddingVertical: space.xs, borderTopWidth: StyleSheet.hairlineWidth },
  stockRow: { flexDirection: "row", alignItems: "center", gap: space.xs, minHeight: 56, paddingVertical: space.xs, borderTopWidth: StyleSheet.hairlineWidth },
  lifted: { elevation: 6, shadowOpacity: 0.3, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
  handle: { width: touch.min, minHeight: touch.min, alignItems: "center", justifyContent: "center" },
  iconBtn: { width: touch.min, minHeight: touch.min, alignItems: "center", justifyContent: "center" },
});
