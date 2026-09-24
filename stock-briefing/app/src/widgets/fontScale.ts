import { PixelRatio } from "react-native";

/**
 * 지금 시스템 글자 크기 배율 (100% = 1). 위젯은 그 순간의 글자 크기로 비트맵을 그리므로, 같은 배율로 배치를 고른다 (3-23).
 * 못 읽으면 1 (테스트·미리보기)
 */
export function fontScaleNow(): number {
  try {
    const s = PixelRatio.getFontScale();
    return Number.isFinite(s) && s > 0 ? s : 1;
  } catch {
    return 1;
  }
}
