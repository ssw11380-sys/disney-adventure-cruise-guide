import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "./miniRender";

/** 기존 본문이 있어도 현재 조회 실패를 숨기지 않는 화면 회귀. */
const h = vi.hoisted(() => ({
  flags: {} as Record<string, boolean | undefined>,
  failed: false,
  nextFailed: false,
  fetching: false,
  cachedHealth: true,
  limited: false,
  fetchNext: vi.fn(async () => undefined),
  refetch: vi.fn(async () => undefined),
  density: "basic" as string,
  setDensity: vi.fn(async () => undefined),
  /** 가짜 기기 저장소 — 모듈을 새로 불러도(앱 다시 켜기) 남는다 */
  store: new Map<string, string>(),
  notifyArgs: [] as unknown[],
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => h.store.get(k) ?? null,
    setItem: async (k: string, v: string) => void h.store.set(k, v),
    removeItem: async (k: string) => void h.store.delete(k),
    multiGet: async (keys: string[]) => keys.map((k) => [k, h.store.get(k) ?? null]),
    multiSet: async (pairs: [string, string][]) => {
      for (const [k, v] of pairs) h.store.set(k, v);
    },
    multiRemove: async (keys: string[]) => {
      for (const k of keys) h.store.delete(k);
    },
  },
}));
vi.mock("react-native", () => ({
  View: "View", Text: "Text", TextInput: "TextInput", Pressable: "Pressable", ScrollView: "ScrollView", RefreshControl: "RefreshControl", ActivityIndicator: "ActivityIndicator",
  FlatList: (p: { data: unknown[]; renderItem: (arg: {item: unknown; index: number}) => React.ReactNode; ListHeaderComponent: React.ReactNode; ListFooterComponent: React.ReactNode; onEndReached: () => void }) => React.createElement("FlatList", {onEndReached:p.onEndReached}, p.ListHeaderComponent, p.data.map((item,index)=>React.createElement(React.Fragment,{key:index},p.renderItem({item,index}))),p.ListFooterComponent),
  StyleSheet: {create:<T,>(s:T)=>s,hairlineWidth:1}, Alert:{alert:vi.fn()}, Platform:{OS:"android"},
  useWindowDimensions:()=>({width:475,height:751,scale:2.625,fontScale:1}),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "1.4.0", extra: { apiUrl: "https://prod.test" } } } }));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }));
vi.mock("expo-router", () => ({ router: { push: vi.fn() }, useLocalSearchParams: () => ({}) }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.light, useFontScale: () => 1 };
});
// 설정 화면이 읽는 설정 (가짜). 저장 시험은 아래에서 진짜 모듈(vi.importActual)로
vi.mock("@/lib/settings", () => ({
  SORT_OPTIONS: [{ value: "created", label: "등록순" }],
  THEME_OPTIONS: [{ value: "dark", label: "다크" }],
  WIDGET_ROW_OPTIONS: [],
  DENSITY_OPTIONS: [
    { value: "basic", label: "기본" },
    { value: "dense", label: "촘촘" },
  ],
  useSettings: () => ({
    apiUrl: "https://prod.test",
    apiToken: "",
    showKrw: false,
    afterCost: true,
    sort: "created",
    themeMode: "dark",
    widgetRowCurrency: "krw",
    haptics: true,
    density: h.density,
    setDensity: h.setDensity,
    setCredentials: vi.fn(),
  }),
}));
vi.mock("@/api/hooks", () => ({
  AUTO_REFRESH_MAX_PAGES: 3,
  useHealth:()=>({data:h.cachedHealth?{ok:true,limited:h.limited,time:"2026-10-02T10:00:00+09:00",sources:{}}:undefined,isError:h.failed,error:new Error("연결 실패"),isFetching:h.fetching,refetch:h.refetch}),
  useDiscoverRank:()=>({data:{pages:[{market:"KR",category:"tradingValue",page:1,ver:1,hasMore:true,items:[{code:"005930",name:"삼성전자",price:100,changeRate:1,currency:"KRW"}],marketOpen:true,session:"regular",asOf:"2026-10-02T10:00:00+09:00",fxRate:null,source:"시험 자료",note:null}]},isLoading:false,isError:h.failed,isFetchNextPageError:h.nextFailed,isFetching:h.fetching,isFetchingNextPage:false,hasNextPage:true,error:new Error("연결 실패"),refetch:h.refetch,fetchNextPage:h.fetchNext}),
  useNotificationSettings: (on: unknown) => {
    h.notifyArgs.push(on);
    return { data: undefined, refetch: async () => undefined };
  },
  useApi: () => ({ logout: async () => undefined }),
  useFeature: (key: string, fallback = false) => h.flags[key] ?? fallback,
}));
vi.mock("@/lib/uxFlags", async (orig) => ({ ...(await orig<typeof import("@/lib/uxFlags")>()), useUx: () => ({ oneHand: false, firstRun: true, emptyGuide: false, connectionGuide: false, flagsMissing: false }) }));
vi.mock("@/lib/liveStream", () => ({ useLiveStream: () => ({ connected: false, ticks: 0 }) }));
vi.mock("@/lib/errorReport", () => ({ flushErrors: async () => "empty", reportError: async () => undefined }));
vi.mock("@/components/Freshness", () => ({ usePull: () => ({ pulling: false, onPull: h.refetch }) }));
vi.mock("@/components/AppUpdateCard", () => ({ AppUpdateCard: "AppUpdateCard" }));
vi.mock("@/components/NotificationSettingsCard", () => ({ NotificationSettingsCard: "NotificationSettingsCard" }));
vi.mock("@/components/TossOpenApiCard", () => ({ TossOpenApiCard: "TossOpenApiCard" }));
vi.mock("@/components/ScreenInfoCard", () => ({ ScreenInfoCard: "ScreenInfoCard" }));
vi.mock("@/components/WidgetRefreshStatus", () => ({ WidgetRefreshStatus: "WidgetRefreshStatus" }));
vi.mock("@/components/Screen", () => ({ Screen: "Screen", DISCLAIMER: "투자 판단 참고용" }));
vi.mock("@/components/RouteError", () => ({ RouteErrorBoundary: "RouteErrorBoundary" }));
vi.mock("@/components/ui", () => ({ Badge: "Badge", Button: "Button", Card: "Card", Chip: "Chip", Muted: "Muted", Row: "Row", RowWrapContext: React.createContext(false), SectionTitle: (p: { children?: React.ReactNode; right?: React.ReactNode }) => React.createElement("SectionTitle", null, p.children, p.right), Toggle: "Toggle", Segmented: "Segmented", Empty: "Empty", ErrorView: "ErrorView" }));


vi.mock("@/lib/account",()=>({useAccountView:()=>({member:false})}));
vi.mock("@/lib/useFoldLayout",()=>({useFoldLayout:()=>({on:false,width:475,height:751,fontScale:1,rail:false})}));
vi.mock("@/lib/settingsLink",()=>({serverOpenRequest:()=>null,useSettingsGuide:()=>({})}));
vi.mock("@/components/AccountCard",()=>({AccountCard:"AccountCard"}));
vi.mock("@/components/discover/DiscoverRow",()=>({DiscoverRow:({item}:{item:{name:string}})=>React.createElement("DiscoverRow",null,item.name),useDiscoverRowH:()=>60}));
vi.mock("@/components/discover/DiscoverTable",()=>({DiscoverTableHead:"DiscoverTableHead",DiscoverTableRow:"DiscoverTableRow"}));
vi.mock("@/components/StockLine",()=>({LineHead:"LineHead"}));
vi.mock("@/components/discover/Skeleton",()=>({SkeletonRows:"SkeletonRows"}));
vi.mock("@/components/discover/ThemeBoard",()=>({ThemeBoard:"ThemeBoard"}));
vi.mock("@/components/discover/shared",()=>({openStock:vi.fn(),StatusLine:"StatusLine",useAddWatch:()=>vi.fn(),useBoxWidth:()=>[475,vi.fn()],useMarks:()=>new Map(),usePull:()=>({pulling:false,onPull:h.refetch})}));
const {default:SettingsScreen}=await import("@/app/(tabs)/settings");
const {default:DiscoverScreen}=await import("@/app/(tabs)/discover");
beforeEach(()=>{h.failed=false;h.nextFailed=false;h.fetching=false;h.cachedHealth=true;h.limited=false;h.fetchNext.mockClear();h.refetch.mockClear();});

describe("기존 자료가 남은 화면의 조회 실패",()=>{
  it("서버 재조회 실패 때 이전 정상 응답으로 정상 배지를 표시하지 않는다",()=>{
    h.failed=true;
    const r=render(<SettingsScreen/>);
    expect(r.text()).not.toContain("정상");
    expect(r.text()).toContain("연결 끊김");
    expect(r.all().filter(n=>n.type==="Badge").some(n=>n.props.tone==="good")).toBe(false);
  });
  it("서버 첫 조회 실패와 정상·토큰 필요 상태를 구분한다",()=>{
    expect(render(<SettingsScreen/>).text()).toContain("정상");
    h.limited=true;
    expect(render(<SettingsScreen/>).text()).toContain("토큰 필요");
    h.cachedHealth=false;h.failed=true;
    expect(render(<SettingsScreen/>).text()).toContain("연결 끊김");
  });
  it("순위 갱신 실패는 기존 행을 유지하며 실패 안내와 재조회 동작을 제공한다",()=>{
    h.failed=true;
    const r=render(<DiscoverScreen/>);
    expect(r.text()).toContain("삼성전자");
    expect(r.text()).toContain("순위를 갱신하지 못했습니다");
    const retry=r.all().find(n=>n.type==="Button"&&n.props.title==="다시 확인");
    expect(retry).toBeDefined();
    (retry!.props.onPress as ()=>void)();
    expect(h.refetch).toHaveBeenCalledTimes(1);
  });
  it("다음 쪽 실패 뒤 자동 스크롤 재요청은 멈추고 사용자가 재시도할 수 있다",()=>{
    h.failed=true;h.nextFailed=true;
    const r=render(<DiscoverScreen/>);
    expect(r.text()).toContain("다음 순위를 불러오지 못했습니다");
    (r.all().find(n=>n.type==="FlatList")!.props.onEndReached as ()=>void)();
    expect(h.fetchNext).not.toHaveBeenCalled();
    const retry=r.all().find(n=>n.type==="Pressable"&&n.props.accessibilityLabel==="다음 순위 다시 불러오기");
    expect(retry).toBeDefined();
    (retry!.props.onPress as ()=>void)();
    expect(h.fetchNext).toHaveBeenCalledWith({cancelRefetch:false});
  });
  it("순위를 갱신 중이면 스크롤 끝 이벤트로 그 조회를 취소하지 않는다",()=>{
    h.fetching=true;
    const r=render(<DiscoverScreen/>);
    (r.all().find(n=>n.type==="FlatList")!.props.onEndReached as ()=>void)();
    expect(h.fetchNext).not.toHaveBeenCalled();
  });
  it("정상 목록은 실패 안내 없이 다음 쪽을 조회한다",()=>{
    const r=render(<DiscoverScreen/>);
    expect(r.text()).not.toContain("못했습니다");
    (r.all().find(n=>n.type==="FlatList")!.props.onEndReached as ()=>void)();
    expect(h.fetchNext).toHaveBeenCalledWith({cancelRefetch:false});
  });
});
