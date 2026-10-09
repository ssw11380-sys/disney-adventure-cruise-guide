import React, { useState } from "react";
import { BackHandler, Pressable, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { Screen } from "@/components/Screen";
import { Button, Card, Muted, SectionTitle } from "@/components/ui";
import { font, space, touch, useTheme } from "@/theme";

export interface SettingsSection { id: string; title: string; detail: string; content: React.ReactNode }
export function SettingsSections({ sections, openServerRequest, refreshing, onRefresh }: { sections: SettingsSection[]; openServerRequest: string | null; refreshing: boolean; onRefresh: () => void }) {
  const t = useTheme();
  const [selected, setSelected] = useState<string | null>(null);
  const current = sections.find(s => s.id === selected);
  const [handled, setHandled] = useState<string | null>(null);
  if (handled !== openServerRequest) { setHandled(openServerRequest); if (openServerRequest) setSelected("server"); }
  useFocusEffect(React.useCallback(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!selected) return false;
      setSelected(null); return true;
    });
    return () => sub.remove();
  }, [selected]));
  return <Screen key={selected ?? "menu"} refreshing={refreshing} onRefresh={onRefresh}>
    {current ? <><Button title="설정 목록으로" icon="chevron-back" variant="ghost" onPress={() => setSelected(null)} /><SectionTitle>{current.title}</SectionTitle>{current.content}</> : <>
      <Card><SectionTitle>설정</SectionTitle><Muted>변경할 항목을 선택하세요.</Muted></Card>
      {sections.map(s => <Pressable key={s.id} accessibilityRole="button" accessibilityLabel={`${s.title}, ${s.detail}`} onPress={() => setSelected(s.id)}
        style={{ minHeight: touch.min, backgroundColor: t.surface, padding: space.lg, borderBottomWidth: 1, borderColor: t.line }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}><Text style={{ flex: 1, color: t.ink, fontSize: font.body, fontWeight: "700" }}>{s.title}</Text><Text style={{ color: t.muted, fontSize: font.body }}>›</Text></View>
        <Muted>{s.detail}</Muted>
      </Pressable>)}
    </>}
  </Screen>;
}
