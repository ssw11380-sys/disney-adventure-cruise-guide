import { StatusBar } from "expo-status-bar";
import React, { useEffect, useState } from "react";
import { Keyboard, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { heroLayout } from "@/lib/loginHero";
import { authColors as C, authFont, authLayout, fontCap, space } from "@/tokens";
import { AuthBackground, AuthDisclaimer, AuthLogo } from "./AuthParts";
import { LoginHero } from "./LoginHero";

/**
 * 로그인·회원가입 화면 틀 (계정 A단계, hero-spec.md 4장). 늘 어두운 바탕.
 *  - 한 칸(휴대폰·접은 폴드·펼친 폴드 세로): 위 그림(로그인) 또는 작은 글자 머리(회원가입), 아래 입력 묶음(가운데, 최대 폭 420).
 *    창이 높아 남는 높이는 40% 를 입력 묶음 위, 60% 를 아래에 둔다
 *  - 두 칸(창 폭 840 이상이고 가로가 더 김 — 펼친 폴드8 933×704): 왼쪽 그림 · 오른쪽 입력(폭 420, 세로 가운데)
 *  - 키보드가 뜨면 한 칸 그림을 글자 한 줄(72dp)로 접고, 키보드 높이만큼 아래를 비워 입력 칸이 가리지 않게 (화면 전체가 스크롤)
 *  - 큰 글씨로 넘치면 화면 전체가 스크롤된다
 */
export function AuthFrame({ top, title, children }: { top: "hero" | "header"; title?: string; children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [kb, setKb] = useState(0);
  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", (e) => setKb(e.endCoordinates?.height ?? 0));
    const hide = Keyboard.addListener("keyboardDidHide", () => setKb(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  const L = heroLayout(width, height, insets, kb > 0);
  const heading = title ? (
    <Text style={styles.title} accessibilityRole="header" maxFontSizeMultiplier={fontCap.chrome}>
      {title}
    </Text>
  ) : null;
  const form = (
    <View style={{ gap: authLayout.fieldGap }}>
      {L.mode === "two" && top === "header" ? heading : null}
      {children}
    </View>
  );
  if (L.mode === "two") {
    return (
      <View style={styles.root}>
        <StatusBar style="light" />
        <AuthBackground />
        <View style={styles.row}>
          <LoginHero layout={L} />
          <ScrollView
            style={{ width: authLayout.rightW }}
            contentContainerStyle={{ flexGrow: 1, justifyContent: "center", paddingHorizontal: L.gutter, paddingTop: insets.top + space.xl, paddingBottom: Math.max(insets.bottom, space.md) + kb }}
            keyboardShouldPersistTaps="handled"
          >
            {form}
            <AuthDisclaimer />
          </ScrollView>
        </View>
      </View>
    );
  }
  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <AuthBackground />
      <ScrollView contentContainerStyle={{ flexGrow: 1, paddingBottom: Math.max(insets.bottom, space.md) + kb }} keyboardShouldPersistTaps="handled">
        {top === "hero" ? (
          <LoginHero layout={L} />
        ) : (
          <View style={{ paddingTop: insets.top + authLayout.headerTop, width: L.formW, alignSelf: "center", gap: authLayout.groupGap }}>
            <AuthLogo size={L.logoSize} subtitle={false} />
            {heading}
          </View>
        )}
        <View style={{ flex: 2, minHeight: top === "hero" ? authLayout.heroGap : authLayout.headerTop }} />
        <View style={{ width: L.formW, alignSelf: "center" }}>{form}</View>
        <View style={{ flex: 3, minHeight: authLayout.groupGap }} />
        <AuthDisclaimer />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bgBottom },
  row: { flex: 1, flexDirection: "row" },
  title: { color: C.ink, fontSize: authFont.title, fontWeight: "700" },
});
