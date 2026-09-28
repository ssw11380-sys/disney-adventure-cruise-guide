import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import React, { useState } from "react";
import { Text } from "react-native";
import { useHealth } from "@/api/hooks";
import { ApiUrlForm } from "@/components/ApiUrlForm";
import { Screen } from "@/components/Screen";
import { Badge, Card, Muted, SectionTitle } from "@/components/ui";
import { connectionKind, connectionText } from "@/lib/connectionError";
import { checkSaved } from "@/lib/serverCheck";
import { useSettings } from "@/lib/settings";
import { font, space, useTheme } from "@/theme";

/**
 * 서버 설정 (계정 A단계): 로그인 화면의 '서버 설정'에서 로그인 없이 연다. 설정 탭 '서버 연결' 칸과 같은 입력(서버 주소·API 토큰).
 * 서버 상태 확인(/health)은 세션 없이 열리는 주소라 로그인 전에도 된다. 저장하고 연결되면 로그인 화면으로 돌아간다.
 * 저장한 직후의 확인은 **저장한 값으로 직접** 묻는다(lib/serverCheck) — 화면의 health.refetch() 는 아직 옛 토큰의 요청 함수를 들고 있어,
 * 맞는 토큰으로 고쳐도 '토큰 필요'가 최대 60초 남고 로그인 화면으로 돌아가지 않았다 (검증 지적). 받은 결과는 새 주소의 캐시에 넣어 배지도 바로 바뀐다
 */
export default function ServerSettingsScreen() {
  const t = useTheme();
  const { apiUrl, apiToken, setCredentials } = useSettings();
  const health = useHealth();
  const qc = useQueryClient();
  const saved = `${apiUrl}|${apiToken}`;
  const [draft, setDraft] = useState({ saved, url: apiUrl, token: apiToken });
  const form = draft.saved === saved ? draft : { saved, url: apiUrl, token: apiToken };
  if (form !== draft) setDraft(form);
  const kind = health.isError ? connectionKind(health.error) : null;
  const status = health.data?.limited ? (
    <Badge tone="bad">토큰 필요</Badge>
  ) : health.data ? (
    <Badge tone="good">연결됨</Badge>
  ) : health.isError ? (
    <Badge tone="bad">연결 안 됨</Badge>
  ) : null;
  return (
    <Screen>
      <Card>
        <SectionTitle right={status}>서버 연결</SectionTitle>
        <Muted style={{ marginBottom: space.sm }}>이 앱이 쓰는 서버 주소와 API 토큰입니다. 보통은 바꿀 일이 없습니다.</Muted>
        <ApiUrlForm
          apiUrl={apiUrl}
          apiToken={apiToken}
          draft={form.url}
          tokenDraft={form.token}
          onDraft={(url, token) => setDraft({ saved, url, token })}
          authRequired={health.data?.authRequired ?? false}
          onSave={async (url, token) => {
            await setCredentials(url, token);
            const ok = await checkSaved(url, token, (u, data) => qc.setQueryData([u, "health"], data));
            if (ok && router.canGoBack()) router.back();
          }}
          onCheck={() => void health.refetch()}
          checking={health.isFetching}
        />
        {kind ? (
          <Text style={{ color: t.danger, fontSize: font.small }} accessibilityLiveRegion="polite">
            {`${connectionText(kind).title}. ${connectionText(kind).hint}`}
          </Text>
        ) : health.data?.limited ? (
          <Text style={{ color: t.danger, fontSize: font.small }}>서버에 연결됐지만 API 토큰이 없거나 맞지 않습니다.</Text>
        ) : null}
      </Card>
    </Screen>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteError";
