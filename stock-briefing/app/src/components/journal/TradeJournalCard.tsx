import { router } from "expo-router";
import React from "react";
import type { TradeRecordsHealth } from "@/api/types";
import { Button, Card, Muted, Row, SectionTitle } from "@/components/ui";
import { JOURNAL, journalHref } from "@/lib/journal";
import { tradeRecordsLabel } from "@/lib/tradeRecords";
import { space } from "@/theme";

/**
 * 설정 '매매일지' 카드 (3-37, 기능 플래그 tradeJournal · tradeRecords — 켜졌을 때만 설정이 그린다). 토스증권 연동 카드 바로 아래.
 *  - 설명 한 줄 · '기록' 줄(3-36 설정 '매매 기록' 줄과 같은 글) · [매매일지 열기]
 *  - 토스 연동 전이면 설명 아래 '토스증권을 연동하면 장 마감 뒤부터 기록이 쌓여요.' (버튼은 그대로 — 빈 화면 안내로 간다)
 */
export function TradeJournalCard({ records }: { records: TradeRecordsHealth | null | undefined }) {
  const label = tradeRecordsLabel(records);
  return (
    <Card>
      <SectionTitle>{JOURNAL.title}</SectionTitle>
      <Muted>{JOURNAL.cardDesc}</Muted>
      {records && !records.toss ? <Muted>{JOURNAL.cardNoToss}</Muted> : null}
      {label ? <Row label={JOURNAL.cardRecords} value={label} /> : null}
      <Button title={JOURNAL.open} icon="book-outline" variant="secondary" style={{ marginTop: space.xs }} onPress={() => router.push(journalHref() as never)} />
    </Card>
  );
}
