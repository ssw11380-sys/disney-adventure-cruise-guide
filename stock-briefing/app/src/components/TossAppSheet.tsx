import Ionicons from "@expo/vector-icons/Ionicons";
import React, { useRef, useState } from "react";
import { Linking, Modal, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/components/ui";
import { openTossApp, openTossStore, TOSS_APP, tossFindParts, type TossAppTarget } from "@/lib/tossApp";
import { font, radius, space, useTheme } from "@/theme";
import { tossSheet } from "@/tokens";

type Step = "find" | "fail" | "storeFail";

/**
 * 토스 앱 안내 시트 (3-48, 기능 플래그 tossOpen). 가격 알림 시트와 같은 모양: 휴대폰은 아래에 붙이고, 넓은 창은 가운데 최대 560dp.
 *  1. '토스 앱에서 찾기' · '토스 앱 → 증권 → 검색에서 "삼성전자"(005930)을 찾아 주세요.' · '주문은 토스 앱에서 직접 합니다.' · [토스 앱 열기] [닫기]
 *  2. [토스 앱 열기] → Linking.openURL('supertoss://') (토스 앱 자체만 — 종목 경로를 추측해 붙이지 않는다). 열리면 시트를 닫는다
 *  3. 못 열면(토스 앱 없음) 같은 시트에 '토스 앱을 열지 못했습니다. …' + [Play 스토어에서 보기] (market:// → 안 되면 https Play 주소)
 * 이 앱은 주문을 넣지 않고 서버도 부르지 않는다. 바깥(어두운 곳)·뒤로 가기·[닫기]로 닫힌다
 */
export function TossAppSheet({ target, onClose }: { target: TossAppTarget; onClose: () => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const win = useWindowDimensions();
  const [step, setStep] = useState<Step>("find");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const wide = win.width >= tossSheet.maxW + space.xl * 2;
  const parts = tossFindParts(target);
  const failed = step !== "find";

  /** 여는 동안 두 번 누르지 않게. 열었으면 시트를 닫고, 못 열었으면 다음 안내로 */
  const run = async (go: (open: (url: string) => unknown) => Promise<boolean>, failStep: Step) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const ok = await go((url) => Linking.openURL(url));
    busyRef.current = false;
    setBusy(false);
    if (ok) onClose();
    else setStep(failStep);
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.backdrop, { justifyContent: wide ? "center" : "flex-end" }]}>
        {/* 바깥을 누르면 닫힘. 시트를 감싸면 화면 읽기가 시트 전체를 한 덩어리로 읽으므로 뒤에 따로 깐다 (가격 알림·정렬 시트와 같음) */}
        <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: t.scrim }]} onPress={onClose} accessibilityRole="button" accessibilityLabel={TOSS_APP.scrim} />
        <View
          testID="toss-app-sheet"
          style={[
            styles.sheet,
            wide ? styles.sheetFloat : styles.sheetBottom,
            { backgroundColor: t.surface, borderColor: t.lineStrong, paddingBottom: wide ? space.lg : insets.bottom + space.lg },
          ]}
        >
          <Text style={[styles.title, { color: t.ink }]} accessibilityRole="header">
            {TOSS_APP.sheetTitle}
          </Text>
          <Text style={[styles.body, { color: t.ink }]} testID="toss-app-find">
            {parts.before}
            <Text style={styles.strong}>{parts.strong}</Text>
            {parts.after}
          </Text>
          <Text style={[styles.note, { color: t.sub }]}>{TOSS_APP.note}</Text>
          {failed ? (
            // 못 열었을 때: 화면 읽기가 바로 읽도록 알림 영역
            <View style={styles.fail} accessible accessibilityRole="alert" accessibilityLiveRegion="polite" accessibilityLabel={step === "storeFail" ? `${TOSS_APP.fail} ${TOSS_APP.storeFail}` : TOSS_APP.fail}>
              <Ionicons name="alert-circle-outline" size={font.title} color={t.warn} />
              <View style={styles.failText}>
                <Text style={{ color: t.warn, fontSize: font.small }}>{TOSS_APP.fail}</Text>
                {step === "storeFail" ? <Text style={{ color: t.warn, fontSize: font.small }}>{TOSS_APP.storeFail}</Text> : null}
              </View>
            </View>
          ) : null}
          <View style={styles.actions}>
            {failed ? (
              <Button title={TOSS_APP.store} icon="storefront-outline" loading={busy} onPress={() => void run(openTossStore, "storeFail")} />
            ) : (
              <Button title={TOSS_APP.open} icon="open-outline" loading={busy} onPress={() => void run(openTossApp, "fail")} />
            )}
            <Button title={TOSS_APP.close} variant="secondary" onPress={onClose} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, alignItems: "center" },
  sheet: { width: "100%", maxWidth: tossSheet.maxW, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden", paddingHorizontal: space.lg, paddingTop: space.lg, gap: space.sm },
  sheetBottom: { borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg },
  sheetFloat: { borderRadius: radius.lg },
  title: { fontSize: font.h2, fontWeight: "700" },
  body: { fontSize: font.body },
  strong: { fontWeight: "700" },
  note: { fontSize: font.small },
  fail: { flexDirection: "row", alignItems: "flex-start", gap: space.sm, paddingVertical: space.xs },
  failText: { flex: 1, minWidth: 0, gap: space.xxs },
  actions: { gap: space.sm, paddingTop: space.sm },
});
