import { useWindowDimensions, type ViewStyle } from "react-native";
import { space } from "@/theme";

/** ' · ' 묶음 사이 간격: 글자 크기에 맞춰 넓힌다 (100% xs · 125% 이상 s · 175% 이상 sm) */
export function chunkGap(fontScale: number): number {
  return fontScale >= 1.75 ? space.sm : fontScale >= 1.25 ? space.s : space.xs;
}

/**
 * 좁은 칸·큰 글씨에서 ' · ' 로 나뉜 묶음째 줄을 바꾸는 줄 모양 (계좌 상세 '다가오는 일정'·비중 두 줄, '일정·공시' 화면 공시 줄·계좌 상세 링크 줄이 같이 쓴다)
 */
export function useChunkRow(): ViewStyle {
  const { fontScale } = useWindowDimensions();
  return { flexDirection: "row", flexWrap: "wrap", columnGap: chunkGap(fontScale) };
}
