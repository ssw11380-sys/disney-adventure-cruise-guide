import { Ionicons } from "@expo/vector-icons";
import * as Device from "expo-device";
import React, { useEffect, useState } from "react";
import { Alert, Dimensions, PixelRatio, Pressable, Share, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFeature } from "@/api/hooks";
import { currentVersion, describeRunningUpdate } from "@/lib/appUpdate";
import { screenInfoRows, screenInfoText, type ScreenInfoInput } from "@/lib/screenInfo";
import { font, space, touch, useTheme } from "@/theme";
import { Button, Card, Muted, Row, SectionTitle } from "./ui";

/**
 * 설정 > 화면 정보 (접는 폰 측정, 접힘). 펴면 모델·창 크기·밀도·글자 배율 등을 보여 주고 '공유'로 글을 넘긴다.
 * 접거나 펴거나 돌리면 창 크기 변경을 받아 숫자가 바로 바뀐다. 줄 만들기는 lib/screenInfo.ts.
 * 공유 글 끝에는 홈 화면 위젯 진단(위젯 2차 — widgets/diagnose.ts)을 붙인다. 플래그 widgetFoldFit 이 켜져 있을 때만 (새 기능, fallback 꺼짐 — 끄면 공유 글이 예전과 같다)
 */
export function ScreenInfoCard() {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityLabel="화면 정보"
        accessibilityState={{ expanded: open }}
        style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: touch.min }}
      >
        <SectionTitle style={{ marginBottom: 0 }}>화면 정보</SectionTitle>
        <Ionicons name={open ? "chevron-up" : "chevron-down"} size={18} color={t.muted} />
      </Pressable>
      {/* 펼쳤을 때만 크기 변경을 구독한다 */}
      {open ? <ScreenInfoBody /> : null}
    </Card>
  );
}

/** 화면 전체 크기. 창과 따로 바뀔 수 있어(화면 분할 등) 바뀔 때마다 다시 읽는다 */
function useScreenSize() {
  const [size, setSize] = useState(() => Dimensions.get("screen"));
  useEffect(() => {
    const sub = Dimensions.addEventListener("change", ({ screen }) => setSize(screen));
    return () => sub.remove();
  }, []);
  return size;
}

/** 지금 창·화면 값 (바뀌면 다시 그린다) */
function useScreenInfo(): ScreenInfoInput {
  const win = useWindowDimensions();
  const screen = useScreenSize();
  const insets = useSafeAreaInsets();
  return {
    window: { width: win.width, height: win.height },
    screen: { width: screen.width, height: screen.height },
    // 바깥·안쪽 화면의 밀도가 다를 수 있어 그릴 때마다 읽는다
    density: PixelRatio.get(),
    fontScale: win.fontScale,
    insets,
    manufacturer: Device.manufacturer,
    modelName: Device.modelName,
    osVersion: Device.osVersion,
    apiLevel: Device.platformApiLevel,
    appVersion: currentVersion,
    build: describeRunningUpdate().updateId,
  };
}

function ScreenInfoBody() {
  const t = useTheme();
  const info = useScreenInfo();
  const widgetDiag = useFeature("widgetFoldFit", false);
  const share = async () => {
    // 홈 화면 위젯 진단(위젯 번호·지금 크기·최근 받은 크기 — widgets/diagnose.ts, 그림에는 쓰지 않는 기록)을 끝에 붙인다: 폴드에서 두 화면이 같은 위젯을 쓰는지 폰에서 확인하려고.
    // 플래그 widgetFoldFit 이 켜져 있을 때만 (꺼져 있으면 읽지도 않는다). 부를 때 읽고, 못 읽으면(위젯 모듈 없음 등) 화면 값만
    const widgets = widgetDiag ? await import("@/widgets/diagnose").then((m) => m.widgetReport()).catch(() => [] as string[]) : [];
    const message = [screenInfoText(info), ...widgets].join("\n");
    try {
      await Share.share({ message, title: "화면 정보" });
    } catch {
      // 공유 창을 못 열면 글을 그대로 보여 준다 (보고 옮겨 적을 수 있게)
      Alert.alert("화면 정보", message);
    }
  };
  return (
    <View>
      {screenInfoRows(info).map((r) => (
        <Row
          key={r.label}
          label={r.label}
          value={
            <Text style={[styles.value, { color: t.ink }]} selectable>
              {r.value}
            </Text>
          }
        />
      ))}
      <Muted style={{ fontSize: font.tiny, marginTop: space.sm }}>
        {"접힘/펼침은 앱이 경첩 상태를 직접 알 수 없어 화면 폭으로 짐작합니다. 폰을 접거나 펴거나 돌리면 숫자가 바로 바뀝니다. 아래 '공유'에서 '복사'를 누르면 대화창에 붙여 넣을 수 있습니다."}
      </Muted>
      <Button title="공유" icon="share-social-outline" variant="secondary" compact accessibilityLabel="화면 정보 공유" style={{ marginTop: space.sm }} onPress={() => void share()} />
    </View>
  );
}

const styles = StyleSheet.create({
  // 값이 길면(큰 글씨·바깥 화면) 줄을 넘기지 않고 오른쪽 칸 안에서 줄바꿈
  value: { flexShrink: 1, marginLeft: space.md, textAlign: "right", fontSize: font.small, fontWeight: "600", fontVariant: ["tabular-nums"] },
});
