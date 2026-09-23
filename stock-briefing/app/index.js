// 앱 진입점. expo-router 기본 진입점에 홈 화면 위젯 태스크 핸들러와 백그라운드 브리핑 확인 태스크 등록을 덧붙인다.
import "expo-router/entry";
import { registerWidgetTaskHandler } from "react-native-android-widget";
import { defineBriefingTask } from "./src/lib/backgroundBriefings";
import { widgetTaskHandler } from "./src/widgets/widgetTaskHandler";

registerWidgetTaskHandler(widgetTaskHandler);
defineBriefingTask();
