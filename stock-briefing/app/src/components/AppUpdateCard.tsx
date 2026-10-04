import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useUpdates } from "expo-updates";
import React, { useEffect, useRef, useState } from "react";
import { Alert, Linking, Text, View } from "react-native";
import { applyOtaUpdate, checkForAppUpdate, compareVersions, currentVersion, describeRunningUpdate, fetchRelease, updateStatus, type UpdateCheckResult, type UpdateCheckPhase } from "@/lib/appUpdate";
import { formatDateKo } from "@/lib/format";
import { font, space, useTheme } from "@/theme";
import { Badge, Button, Card, Muted, Row, SectionTitle } from "./ui";

async function openApk(url: string): Promise<void> {
  try { await Linking.openURL(url); }
  catch { Alert.alert("설치 파일을 열지 못했습니다", "브라우저 연결을 확인한 뒤 다운로드를 다시 눌러 주세요."); }
}

/** 설치 버전·실제 적용 수정본·다운로드 대기를 구분한다. 정상 조회는 추가 재시도 없이 수행한다. */
export function AppUpdateCard() {
  const t = useTheme();
  const client = useQueryClient();
  const sdk = useUpdates();
  const running = describeRunningUpdate();
  const release = useQuery({ queryKey: ["release"], queryFn: () => fetchRelease(), staleTime: 60 * 60_000, retry: 0 });
  const newer = release.data && compareVersions(release.data.version, currentVersion) > 0 ? release.data : null;
  const alive = useRef(true);
  const checkLock = useRef(false);
  const restartLock = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [phase, setPhase] = useState<UpdateCheckPhase>("checking");
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const downloading = (phase === "downloading" && checking) || sdk.isDownloading;
  const restarting = applying || sdk.isRestarting;
  const busy = checking || sdk.isChecking || downloading || restarting;
  const downloaded = sdk.isUpdatePending ? sdk.downloadedUpdate : undefined;
  const nativePending: Extract<UpdateCheckResult, { kind: "ota" }> | null = downloaded?.type === "rollback"
    ? { kind: "ota", updateId: null, rollback: true }
    : downloaded?.type === "new" && downloaded.updateId && downloaded.updateId !== sdk.currentlyRunning.updateId
      ? { kind: "ota", updateId: downloaded.updateId } : null;
  const pending = nativePending ?? (result?.kind === "ota" ? result : null);
  // 배포 정보가 더 높은 설치 버전을 알린 뒤 이전 '최신' 결과가 남지 않게 한다.
  const effective = newer ? { kind: newer.apkUrl ? "apk" as const : "apk-unavailable" as const, release: newer }
    : result?.kind === "unknown" ? result : pending ?? result;
  const status = updateStatus(busy ? null : effective);
  const phaseText = restarting ? "다시 시작하는 중" : downloading ? "업데이트 다운로드 중" : "업데이트 확인 중";

  const restartForUpdate = async () => {
    if (!alive.current || restartLock.current || checkLock.current || sdk.isChecking || sdk.isDownloading || sdk.isRestarting) return;
    restartLock.current = true;
    setApplying(true);
    try { await applyOtaUpdate(); }
    catch {
      restartLock.current = false;
      if (alive.current) {
        setApplying(false);
        Alert.alert("앱을 다시 시작하지 못했습니다", "잠시 뒤 다시 눌러 주세요. 계속 안 되면 앱을 완전히 닫았다가 다시 열어 주세요.");
      }
    }
  };

  const check = async () => {
    if (checkLock.current || restartLock.current || busy) return;
    checkLock.current = true;
    setChecking(true);
    setPhase("checking");
    setError(null);
    setResult(null);
    try {
      const r = await checkForAppUpdate({
        loadRelease: () => client.fetchQuery({ queryKey: ["release"], queryFn: () => fetchRelease(), staleTime: 0, retry: 0 }),
        onPhase: next => { if (alive.current) setPhase(next); },
      });
      if (!alive.current) return;
      setResult(r);
      setCheckedAt(new Date().toISOString());
      if (r.kind === "apk") {
        Alert.alert(`새 버전 ${r.release.version}`, `${r.release.notes ?? "새 버전이 있습니다."}\n\n설치 파일(APK)을 내려받아 열면 현재 앱 위에 덮어씌워 설치됩니다. 등록한 종목과 설정은 유지됩니다.`, [
          { text: "나중에", style: "cancel" },
          { text: "다운로드", onPress: () => { if (alive.current) void openApk(r.release.apkUrl!); } },
        ]);
      } else if (r.kind === "ota") {
        Alert.alert(r.rollback ? "복구 업데이트 준비 완료" : "업데이트 준비 완료", r.rollback
          ? "기본 설치본으로 복구할 준비가 됐습니다. 다시 시작하면 적용됩니다."
          : "다운로드가 끝났습니다. 다시 시작하면 새 화면과 기능이 적용됩니다.", [
          { text: "나중에", style: "cancel" },
          { text: "지금 다시 시작", onPress: () => void restartForUpdate() },
        ]);
      }
    } catch {
      if (alive.current) setError("업데이트를 확인하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 눌러 주세요.");
    } finally {
      checkLock.current = false;
      if (alive.current) setChecking(false);
    }
  };

  return <Card>
    <SectionTitle right={busy ? <Badge>{phaseText}</Badge> : newer ? <Badge tone="warn">새 설치 버전 {newer.version}</Badge>
      : pending ? <Badge tone="warn">적용 대기</Badge> : status.badge ? <Badge tone={status.badge.tone}>{status.badge.text}</Badge> : null}>앱 업데이트</SectionTitle>
    <Row label="설치 버전" value={currentVersion} />
    <Row label="적용 업데이트" value={running.createdAt ? `${formatDateKo(running.createdAt, true)} · ${running.updateId}` : running.updateId} />
    <Muted>설치 버전이 같아도 화면·기능 업데이트는 별도로 적용됩니다. 위 시각은 현재 실행 중인 수정본입니다.</Muted>
    {checkedAt ? <Row label="확인 시각" value={formatDateKo(checkedAt, true)} /> : null}
    {newer ? <View style={{ gap: space.xs }}>
      <Text style={{ color: t.ink, fontSize: font.small }}>새 설치 버전 {newer.version}{newer.publishedAt ? ` (${formatDateKo(newer.publishedAt)})` : ""}이 있습니다.{newer.notes ? ` ${newer.notes}` : ""}</Text>
      {newer.apkUrl ? <Button title={`새 버전 ${newer.version} 설치 (APK)`} icon="download-outline" disabled={busy} onPress={() => void openApk(newer.apkUrl!)} /> : null}
    </View> : null}
    <Button title={busy ? phaseText : "업데이트 확인"} variant="secondary" icon="refresh" onPress={() => void check()} loading={busy} />
    {error ? <Text style={{ color: t.danger, fontSize: font.small }}>{error}</Text> : null}
    {status.message ? status.failed ? <Text style={{ color: t.danger, fontSize: font.small }}>{status.message}</Text> : <Muted>{status.message}</Muted> : null}
    {pending && !newer ? <>
      <Muted>{pending.rollback ? "기본 설치본으로 복구할 준비가 됐습니다." : "새 업데이트를 내려받았습니다."} 아직 적용 전입니다. 다시 시작하면 적용됩니다.</Muted>
      <Button title="지금 다시 시작해서 적용" variant="secondary" icon="play" onPress={() => void restartForUpdate()} loading={restarting} disabled={busy} />
    </> : null}
  </Card>;
}
