import React from "react";
import { Alert } from "react-native";
import { useTossImport } from "@/api/hooks";
import { Button } from "@/components/ui";
import { haptic } from "@/lib/haptics";

/**
 * 빈 잔고의 하나뿐인 행동 버튼 — 토스증권이 연결된 서버일 때 (3-24, 기능 플래그 emptyGuide).
 * 토스가 연결된 새 사용자에게 가장 필요한 일은 계좌 종목을 불러오는 것이라, 설정으로 보내지 않고 바로 가져온다
 * (설정 > 토스증권 연동의 '지금 계좌 동기화'와 같은 요청). 끝나면 잔고가 새로 그려지고, 결과는 알림 창 한 줄
 */
export function TossImportButton() {
  const imp = useTossImport();
  const run = () =>
    imp.mutate(undefined, {
      onSuccess: (r) => {
        haptic("success");
        Alert.alert("토스 계좌 불러오기 완료", r.holdings.length ? `${r.accounts}개 계좌에서 ${r.holdings.length}종목을 불러왔습니다.` : "보유 중인 주식이 없습니다. 종목은 검색해서 추가할 수 있습니다.");
      },
      onError: (e) => {
        haptic("error");
        Alert.alert("불러오기 실패", e instanceof Error ? e.message : String(e));
      },
    });
  return <Button title="토스 계좌 불러오기" icon="sync" loading={imp.isPending} onPress={run} style={{ flex: 1 }} />;
}
