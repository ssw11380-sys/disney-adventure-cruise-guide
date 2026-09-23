import { useQuery } from "@tanstack/react-query";
import React, { useState } from "react";
import { Alert, Linking, Text, View } from "react-native";
import { applyOtaUpdate, checkForAppUpdate, compareVersions, currentVersion, describeRunningUpdate, fetchRelease, type UpdateCheckResult } from "@/lib/appUpdate";
import { formatDateKo } from "@/lib/format";
import { font, space, useTheme } from "@/theme";
import { Badge, Button, Card, Muted, Row, SectionTitle } from "./ui";

/** 설정 > 앱 업데이트: 현재 버전, 새 APK 여부(release.json), OTA 확인/적용 */
export function AppUpdateCard() {
  const t = useTheme();
  const running = describeRunningUpdate();
  // 화면을 열 때 조용히 release.json 만 확인해서 새 버전 배지를 보여준다
  const release = useQuery({ queryKey: ["release"], queryFn: () => fetchRelease(), staleTime: 60 * 60_000, retry: 0 });
  const newer = release.data && compareVersions(release.data.version, currentVersion) > 0 ? release.data : null;

  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const check = async () => {
    setChecking(true);
    setError(null);
    try {
      const r = await checkForAppUpdate();
      setResult(r);
      if (r.kind === "apk") {
        Alert.alert(`새 버전 ${r.release.version}`, `${r.release.notes ?? "새 버전이 있습니다."}\n\n설치 파일(APK)을 내려받아 열면 현재 앱 위에 덮어씌워 설치됩니다. 등록한 종목과 설정은 유지됩니다.`, [
          { text: "나중에", style: "cancel" },
          { text: "다운로드", onPress: () => void Linking.openURL(r.release.apkUrl!) },
        ]);
      } else if (r.kind === "ota") {
        Alert.alert("업데이트 준비 완료", "새 화면/기능을 내려받았습니다. 지금 다시 시작할까요?", [
          { text: "나중에 (다음 실행 때 적용)", style: "cancel" },
          { text: "지금 다시 시작", onPress: () => void applyOtaUpdate() },
        ]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
      void release.refetch();
    }
  };

  return (
    <Card>
      <SectionTitle right={newer ? <Badge tone="warn">새 버전 {newer.version}</Badge> : result?.kind === "none" ? <Badge tone="good">최신</Badge> : null}>앱 업데이트</SectionTitle>
      <Row label="현재 버전" value={currentVersion} />
      <Row label="빌드" value={running.createdAt ? formatDateKo(running.createdAt, true) : running.updateId} />
      {newer ? (
        <View style={{ gap: space.xs }}>
          <Text style={{ color: t.ink, fontSize: font.small }}>
            새 버전 {newer.version}
            {newer.publishedAt ? ` (${formatDateKo(newer.publishedAt)})` : ""}이 있습니다.{newer.notes ? ` ${newer.notes}` : ""}
          </Text>
          {newer.apkUrl ? <Button title={`새 버전 ${newer.version} 설치 (APK)`} icon="download-outline" onPress={() => void Linking.openURL(newer.apkUrl!)} /> : null}
        </View>
      ) : null}
      <Button title="업데이트 확인" variant="secondary" icon="refresh" onPress={() => void check()} loading={checking} />
      {error ? <Text style={{ color: t.danger, fontSize: font.small }}>{error}</Text> : null}
      {result?.kind === "none" ? (
        <Muted>
          최신 버전입니다.
          {result.warnings.length ? ` (${result.warnings.join(" / ")})` : ""}
        </Muted>
      ) : null}
      {result?.kind === "ota" ? <Button title="지금 다시 시작해서 적용" variant="secondary" icon="play" onPress={() => void applyOtaUpdate()} /> : null}
    </Card>
  );
}
