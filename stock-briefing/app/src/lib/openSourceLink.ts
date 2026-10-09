import { Alert, Linking } from "react-native";

/** 원문 열기는 한 번만 시도한다. 실패 원문이나 주소를 노출하지 않고 다시 누를 수 있게 안내한다. */
export async function openSourceLink(url: string): Promise<void> {
  try {
    const address = url.trim();
    if (!/^https?:\/\/\S+$/i.test(address)) throw new Error("원문 주소 확인 필요");
    await Linking.openURL(address);
  } catch {
    Alert.alert("원문을 열지 못했습니다", "브라우저 연결을 확인한 뒤 다시 눌러 주세요.");
  }
}
