import { useLocalSearchParams } from "expo-router";
import React, { useState } from "react";
import { JournalList } from "@/components/journal/JournalList";
import { ReturnsView } from "@/components/journal/ReturnsView";
import { TaxView } from "@/components/journal/TaxView";
import { Screen } from "@/components/Screen";
import { Button, Empty, Segmented } from "@/components/ui";
import { SERVER_SECTION, TOKEN_FIELD, URL_FIELD } from "@/lib/connectionError";
import { parseStockCode } from "@/lib/freshness";
import { JOURNAL, kstDate } from "@/lib/journal";
import { useJournalOn } from "@/lib/journalFlag";
import { useNow } from "@/lib/useNow";
import { useSettingsGuide } from "@/lib/settingsLink";
import { useFoldLayout } from "@/lib/useFoldLayout";
import { useUx } from "@/lib/uxFlags";

type Tab = (typeof JOURNAL.tabs)[number]["value"];

/**
 * 매매일지 (3-37, 기능 플래그 tradeJournal · tradeRecords — 앱 fallback 은 둘 다 꺼짐). 설정 카드·잔고 계좌 칸·종목 상세에서 연다.
 * 위 탭: 기록(체결 목록·실현손익·메모) · 수익률(시간가중, 10거래일 뒤) · 양도세 추정(해외주식, 참고용). 주소 /journal?tab=list|returns|tax&code=
 * 폴드 가로(foldLayout 의 twoPane)는 탭마다 두 칸, 그 밖은 한 칸. 사실만 보여 주고 매매·세금 행동을 권하는 말은 쓰지 않는다. 맨 아래 고지
 * 플래그가 꺼져 있으면 서버를 부르지 않는다 (화면 작업 0건)
 */
export default function JournalScreen() {
  const on = useJournalOn();
  const ux = useUx();
  const guide = useSettingsGuide();
  if (!on)
    return (
      <Screen>
        {ux.flagsMissing && guide ? (
          <Empty
            title="서버에 연결되지 않아 매매일지를 볼 수 없습니다"
            hint={`설정 > ${SERVER_SECTION}에서 '${URL_FIELD}'와 '${TOKEN_FIELD}'을 확인해 주세요.`}
            action={<Button title="설정 열기" icon="settings-outline" accessibilityLabel={`설정 열기, ${SERVER_SECTION}`} onPress={guide.onOpenSettings} />}
          />
        ) : (
          <Empty title="지금은 매매일지를 쓸 수 없습니다" hint="잔고 탭에서 계좌 평가를 확인할 수 있습니다." />
        )}
      </Screen>
    );
  return <JournalBody />;
}

function JournalBody() {
  const params = useLocalSearchParams<{ tab?: string; code?: string }>();
  const first: Tab = params.tab === "returns" || params.tab === "tax" ? params.tab : "list";
  const [tab, setTab] = useState<Tab>(first);
  const code = parseStockCode(params.code)?.toUpperCase() ?? null;
  const fold = useFoldLayout();
  const twoPane = fold.on && fold.twoPane;
  // 오늘(한국 날짜)은 1분마다 다시 본다 (자정을 넘겨 켜 둔 화면)
  const now = useNow(60_000);
  const today = kstDate(now);
  const tabs = <Segmented options={[...JOURNAL.tabs]} value={tab} onChange={setTab} />;
  return (
    <Screen top={tabs} scroll={!twoPane} disclaimer>
      {tab === "list" ? (
        <JournalList code={code} twoPane={twoPane} today={today} />
      ) : tab === "returns" ? (
        <ReturnsView twoPane={twoPane} today={today} />
      ) : (
        <TaxView twoPane={twoPane} thisYear={Number(today.slice(0, 4))} />
      )}
    </Screen>
  );
}

// 이 화면에서 난 렌더 오류는 앱을 끄지 않고 "다시 시도" 화면으로 (expo-router)
export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteError";
