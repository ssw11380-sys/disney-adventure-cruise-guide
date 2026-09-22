// 앱 진입점. expo-router 기본 진입점에 홈 화면 위젯 태스크 핸들러 등록만 덧붙인다.
import "expo-router/entry";
import { registerWidgetTaskHandler } from "react-native-android-widget";
import { widgetTaskHandler } from "./src/widgets/widgetTaskHandler";

registerWidgetTaskHandler(widgetTaskHandler);
