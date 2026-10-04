import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupRenders, render } from "./miniRender";
import type { UseUpdatesReturnType } from "expo-updates";

const h = vi.hoisted(() => ({ alert: vi.fn(), open: vi.fn(), check: vi.fn(), download: vi.fn(), reload: vi.fn(), sdk: {} as Partial<UseUpdatesReturnType> }));
vi.mock("react-native", () => ({ View: "View", Text: "Text", Alert: {alert:h.alert}, Linking:{openURL:h.open} }));
vi.mock("expo-constants", () => ({ default: {expoConfig:{version:"1.5.0"}} }));
vi.mock("expo-updates", () => ({ isEnabled:true, updateId:"running-full", createdAt:new Date("2026-10-04T03:31:00+09:00"), channel:"preview", isEmbeddedLaunch:false,
  checkForUpdateAsync:h.check, fetchUpdateAsync:h.download, reloadAsync:h.reload, useUpdates:()=>h.sdk }));
vi.mock("@/theme", async () => { const t=await import("@/tokens"); return {...t,useTheme:()=>t.dark}; });
vi.mock("@/components/ui", () => ({ Badge:"Badge",Button:"Button",Card:"Card",Muted:"Muted",Row:"Row",SectionTitle:({children,right}:{children:React.ReactNode;right?:React.ReactNode})=><section>{children}{right}</section> }));
const { AppUpdateCard }=await import("@/components/AppUpdateCard");
const clients:QueryClient[]=[];
const info={version:"1.5.0",apkUrl:null,notes:null,publishedAt:null};
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
const deferred=<T,>()=>{let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};};
function fixture(seed=true){
  const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});clients.push(client);
  if(seed)client.setQueryData(["release"],info);
  const element=<QueryClientProvider client={client}><AppUpdateCard/></QueryClientProvider>;
  const r=render(element);
  const button=(title:string)=>r.all().find(x=>x.type==="Button"&&x.props.title===title)!;
  return {r,client,element,button,check:()=>r.act(()=>{(button("업데이트 확인").props.onPress as ()=>void)();})};
}
beforeEach(()=>{
  h.alert.mockReset();h.open.mockReset();h.check.mockReset();h.download.mockReset();h.reload.mockReset();
  h.sdk={isChecking:false,isDownloading:false,isRestarting:false,isUpdatePending:false,currentlyRunning:{updateId:"running-full",isEmbeddedLaunch:false,isEmergencyLaunch:false,emergencyLaunchReason:null}};
  h.check.mockResolvedValue({isAvailable:false,isRollBackToEmbedded:false,reason:"noUpdateAvailableOnServer"});
  h.download.mockResolvedValue({isNew:true,manifest:{id:"next-update"}});h.reload.mockResolvedValue(undefined);
  vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify(info))));
});
afterEach(()=>{cleanupRenders();for(const q of clients)q.clear();clients.length=0;vi.unstubAllGlobals();});

describe("설정 업데이트 화면과 실제 조회 캐시 연결",()=>{
  it("설치 버전과 적용 수정본을 구분하고 수동 확인은 배포 정보를 한 번만 읽는다",async()=>{
    const f=fixture();f.check();await flush();f.r.act(()=>{});
    expect(f.r.all().some(x=>x.props.label==="설치 버전"&&x.props.value==="1.5.0")).toBe(true);
    expect(f.r.all().some(x=>x.props.label==="적용 업데이트"&&String(x.props.value).includes("running-"))).toBe(true);
    expect(f.r.text()).toContain("최신 버전입니다");
    expect(f.r.all().some(x=>x.props.label==="확인 시각")).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();expect(h.check).toHaveBeenCalledOnce();
    expect(f.client.getQueryData(["release"])).toEqual(info);
  });
  it("화면 첫 자동 조회와 수동 확인이 겹쳐도 같은 배포 요청을 공유한다",async()=>{
    const d=deferred<Response>();vi.mocked(fetch).mockImplementation(()=>d.promise);
    const f=fixture(false);f.check();
    expect(fetch).toHaveBeenCalledOnce();expect(h.check).toHaveBeenCalledOnce();
    d.resolve(new Response(JSON.stringify(info)));await flush();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("연속 클릭을 막고 다시 확인하는 동안 이전 최신 표시를 숨긴다",async()=>{
    const f=fixture();f.check();await flush();f.r.act(()=>{});expect(f.r.text()).toContain("최신 버전입니다");
    const d=deferred<{isAvailable:boolean;reason:string}>();h.check.mockReturnValue(d.promise);
    const press=f.button("업데이트 확인").props.onPress as ()=>void;
    f.r.act(()=>{press();press();});
    expect(h.check).toHaveBeenCalledTimes(2);expect(f.r.text()).not.toContain("최신 버전입니다");
    expect(f.button("업데이트 확인 중").props.loading).toBe(true);
    d.resolve({isAvailable:false,reason:"noUpdateAvailableOnServer"});await flush();
  });
  it("다운로드 중과 적용 대기를 구분하고 재시작을 여러 번 누르지 않는다",async()=>{
    const d=deferred<{isNew:boolean;manifest:{id:string}}>();h.check.mockResolvedValue({isAvailable:true});h.download.mockReturnValue(d.promise);
    const f=fixture();f.check();await flush();f.r.act(()=>{});
    expect(f.button("업데이트 다운로드 중").props.loading).toBe(true);expect(h.alert).not.toHaveBeenCalled();
    d.resolve({isNew:true,manifest:{id:"next-update"}});await flush();f.r.act(()=>{});
    expect(f.r.text()).toContain("적용 대기");expect(f.r.text()).toContain("아직 적용 전");
    const press=f.button("지금 다시 시작해서 적용").props.onPress as ()=>void;
    f.r.act(()=>{press();press();});await flush();expect(h.reload).toHaveBeenCalledOnce();
  });
  it("화면을 닫고 다시 열어도 SDK의 받은 업데이트는 적용 대기로 보인다",()=>{
    const f=fixture();f.r.unmount();
    h.sdk={...h.sdk,isUpdatePending:true,downloadedUpdate:{type:"new",updateId:"next-update",createdAt:new Date(),manifest:{id:"next-update"}} as UseUpdatesReturnType["downloadedUpdate"]};
    const next=fixture();expect(next.r.text()).toContain("적용 대기");expect(next.button("지금 다시 시작해서 적용")).toBeDefined();
    expect(h.check).not.toHaveBeenCalled();expect(h.download).not.toHaveBeenCalled();
  });
  it("닫힌 화면의 완료 알림이나 오래된 재시작 버튼은 실행하지 않는다",async()=>{
    const d=deferred<{isNew:boolean;manifest:{id:string}}>();h.check.mockResolvedValue({isAvailable:true});h.download.mockReturnValue(d.promise);
    const f=fixture();f.check();await flush();f.r.unmount();d.resolve({isNew:true,manifest:{id:"next-update"}});await flush();expect(h.alert).not.toHaveBeenCalled();
    h.sdk={...h.sdk,isUpdatePending:true,downloadedUpdate:{type:"rollback",createdAt:new Date()} as UseUpdatesReturnType["downloadedUpdate"]};
    const next=fixture();const press=next.button("지금 다시 시작해서 적용").props.onPress as ()=>void;next.r.unmount();press();expect(h.reload).not.toHaveBeenCalled();
  });
  it("새 설치 버전에 주소가 없으면 최신 문구와 설치 버튼을 내지 않는다",async()=>{
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({...info,version:"1.6.0"})));
    const f=fixture();f.check();await flush();f.r.act(()=>{});
    expect(f.r.text()).toContain("다운로드 주소를 확인하지 못했습니다");expect(f.r.text()).not.toContain("최신 버전입니다");
    expect(f.r.all().some(x=>String(x.props.title).includes("설치 (APK)"))).toBe(false);
  });
  it("기존 다운로드가 있어도 새로운 확인 실패 안내는 숨기지 않는다",async()=>{
    h.sdk={...h.sdk,isUpdatePending:true,downloadedUpdate:{type:"new",updateId:"previously-downloaded",createdAt:new Date(),manifest:{id:"previously-downloaded"}} as UseUpdatesReturnType["downloadedUpdate"]};
    h.check.mockRejectedValue(new Error("offline"));
    const f=fixture();f.check();await flush();f.r.act(()=>{});
    expect(f.r.text()).toContain("화면 업데이트는 확인하지 못했습니다");
    expect(f.r.text()).toContain("아직 적용 전");
    expect(f.button("지금 다시 시작해서 적용")).toBeDefined();
    expect(f.r.text()).not.toContain("최신 버전입니다");
  });
});
