import AsyncStorage from "@react-native-async-storage/async-storage";
import { installSessionStorage, loadSession } from "./session";

/**
 * 세션 모듈(lib/session)에 기기 저장소(AsyncStorage)를 끼우고 바로 읽기 시작한다 (계정 A단계).
 * 앱 루트(_layout)·위젯·백그라운드 작업이 이 모듈을 불러온다 — 어느 쪽에서 JS 가 켜져도 저장된 세션으로 요청한다.
 * AsyncStorage 는 새 네이티브 모듈이 아니다 (이미 APK 에 있음). expo-secure-store 는 APK 에 없어 쓰지 않는다
 */
installSessionStorage(AsyncStorage);
void loadSession();
