import { StatusBar } from "expo-status-bar";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Keyboard, ScrollView, StyleSheet, Text, View, useWindowDimensions, type TextInput } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { heroLayout, revealScrollY } from "@/lib/loginHero";
import { authColors as C, authFont, authLayout, fontCap, space } from "@/tokens";
import { AuthBackground, AuthDisclaimer, AuthLogo, AuthRevealContext, MiniStairs, type AuthReveal } from "./AuthParts";
import { LoginHero } from "./LoginHero";

/**
 * 로그인·회원가입 화면 틀 (계정 A단계, hero-spec.md 4·8장). 늘 어두운 바탕.
 *  - 한 칸(휴대폰·접은 폴드·펼친 폴드 세로): 위 그림(로그인) 또는 로고 + 작은 정지 계단 머리(회원가입), 아래 입력 묶음(가운데, 최대 폭 420),
 *    맨 아래 footer('서버 설정')와 고지 문구. 창이 높아 남는 높이는 40% 를 입력 묶음 위, 60% 를 아래에 둔다
 *  - 두 칸(창 폭 840 이상이고 가로가 더 김 — 펼친 폴드8 933×704): 왼쪽 그림(회원가입은 움직이지 않는 마지막 장면) · 오른쪽 입력(폭 420, 세로 가운데)
 *  - 키보드: 한 칸 로그인은 그림을 로고 한 줄(72dp)로 접고, 누른 칸(비밀번호면 [로그인] 버튼까지)이 키보드 위에 보이게 스크롤한다.
 *    키보드 높이만큼 아래를 비워 끝까지 스크롤할 수 있다. 두 칸은 그림을 접지 않고 오른쪽만 스크롤
 *  - 큰 글씨로 넘치면 화면 전체가 스크롤된다
 */
export function AuthFrame({ top, title, lead, footer, children }: { top: "hero" | "header"; title?: string; lead?: string; footer?: React.ReactNode; children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [kb, setKb] = useState(0);
  const kbRef = useRef(0);
  const scrollRef = useRef<ScrollView>(null);
  const contentRef = useRef<View>(null);
  const scroll = useRef({ y: 0, h: 0 });
  const pending = useRef<{ input: TextInput | null; below: number } | null>(null);

  /** 누른 칸을 키보드 위로 (키보드가 떠 있을 때만) */
  const revealNow = useCallback(() => {
    const p = pending.current;
    const content = contentRef.current;
    const sv = scrollRef.current;
    if (!p?.input || !content || !sv || kbRef.current <= 0) return;
    try {
      p.input.measureLayout(
        content,
        (_x, y, _w, h) => {
          const to = revealScrollY({ y, h, below: p.below, scrollY: scroll.current.y, viewportH: scroll.current.h, kb: kbRef.current });
          if (to !== null) sv.scrollTo({ y: to, animated: true });
        },
        () => undefined,
      );
    } catch {
      /* 웹·측정 실패: 사용자가 직접 스크롤 */
    }
  }, []);
  const reveal = useMemo<AuthReveal>(
    () => ({
      focus: (input, below) => {
        pending.current = { input, below };
        if (kbRef.current > 0) setTimeout(revealNow, 50);
      },
    }),
    [revealNow],
  );
  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", (e) => {
      kbRef.current = e.endCoordinates?.height ?? 0;
      setKb(kbRef.current);
    });
    const hide = Keyboard.addListener("keyboardDidHide", () => {
      kbRef.current = 0;
      setKb(0);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  // 키보드가 뜨고 그림을 접은 뒤(배치가 끝난 뒤) 누른 칸을 보이게
  useEffect(() => {
    if (kb <= 0) return;
    const t = setTimeout(revealNow, 80);
    return () => clearTimeout(t);
  }, [kb, revealNow]);

  const kbOpen = kb > 0;
  // 입력할 때마다 화면이 다시 그려져도 같은 배치(같은 객체)를 넘긴다 → 그림은 다시 그리지 않는다
  const L = useMemo(() => heroLayout(width, height, { top: insets.top, bottom: insets.bottom }, top === "hero" && kbOpen), [width, height, insets.top, insets.bottom, top, kbOpen]);
  const onScroll = (e: { nativeEvent: { contentOffset: { y: number } } }) => {
    scroll.current.y = e.nativeEvent.contentOffset.y;
  };
  const onLayout = (e: { nativeEvent: { layout: { height: number } } }) => {
    scroll.current.h = e.nativeEvent.layout.height;
  };
  const heading = title ? (
    <View style={styles.heading}>
      <Text style={styles.title} accessibilityRole="header" maxFontSizeMultiplier={fontCap.chrome}>
        {title}
      </Text>
      {lead ? (
        <Text style={styles.lead} maxFontSizeMultiplier={fontCap.chrome}>
          {lead}
        </Text>
      ) : null}
    </View>
  ) : null;
  const form = (
    <View style={{ gap: authLayout.fieldGap }}>
      {heading}
      {children}
    </View>
  );
  const bottomPad = Math.max(insets.bottom, space.md) + kb;

  if (L.mode === "two") {
    return (
      <AuthRevealContext value={reveal}>
        <View style={styles.root}>
          <StatusBar style="light" />
          <AuthBackground />
          <View style={styles.row}>
            <LoginHero layout={L} animate={top === "hero"} />
            <ScrollView
              ref={scrollRef}
              style={{ width: authLayout.rightW }}
              contentContainerStyle={{ flexGrow: 1, justifyContent: "center", paddingHorizontal: L.gutter, paddingTop: insets.top + space.xl, paddingBottom: bottomPad }}
              keyboardShouldPersistTaps="handled"
              onScroll={onScroll}
              onLayout={onLayout}
              scrollEventThrottle={32}
            >
              <View ref={contentRef}>
                {form}
                {footer ? <View style={styles.footerTwo}>{footer}</View> : <View style={styles.footerGap} />}
                <AuthDisclaimer />
              </View>
            </ScrollView>
          </View>
        </View>
      </AuthRevealContext>
    );
  }
  return (
    <AuthRevealContext value={reveal}>
      <View style={styles.root}>
        <StatusBar style="light" />
        <AuthBackground />
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={{ flexGrow: 1, paddingBottom: bottomPad }}
          keyboardShouldPersistTaps="handled"
          onScroll={onScroll}
          onLayout={onLayout}
          scrollEventThrottle={32}
        >
          <View ref={contentRef} style={styles.grow}>
            {top === "hero" ? (
              <LoginHero layout={L} />
            ) : (
              <View style={[styles.header, { paddingTop: insets.top + authLayout.headerTop, width: L.formW }]}>
                <AuthLogo size={L.logoSize} subtitle={false} />
                <MiniStairs />
              </View>
            )}
            <View style={{ flex: 2, minHeight: top === "hero" ? authLayout.heroGap : authLayout.headerTop }} />
            <View style={{ width: L.formW, alignSelf: "center" }}>{form}</View>
            <View style={{ flex: 3, minHeight: authLayout.fieldGap }} />
            {footer ? <View style={{ width: L.formW, alignSelf: "center" }}>{footer}</View> : null}
            <AuthDisclaimer />
          </View>
        </ScrollView>
      </View>
    </AuthRevealContext>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bgBottom },
  row: { flex: 1, flexDirection: "row" },
  grow: { flexGrow: 1 },
  header: { alignSelf: "center", flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between" },
  heading: { gap: space.xs, marginBottom: space.xs },
  title: { color: C.ink, fontSize: authFont.title, fontWeight: "700", letterSpacing: -0.2 },
  lead: { color: C.muted, fontSize: authFont.check },
  footerTwo: { marginTop: space.md },
  footerGap: { height: authLayout.groupGap },
});
