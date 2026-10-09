import { useEffect } from "react";
import { AppState } from "react-native";
import { useFeature } from "@/api/hooks";
import { useAccountView } from "@/lib/account";
import { checkMovementNotifications } from "@/lib/movementNotifications";

export function MovementAlertBridge() {
  const on = useFeature("watchlistSteps", false), { member } = useAccountView();
  useEffect(() => {
    if (!on || member) return;
    const check = () => { if (AppState.currentState === "active") void checkMovementNotifications().catch(() => undefined); };
    check();
    const timer = setInterval(check, 30_000), sub = AppState.addEventListener("change", check);
    return () => { clearInterval(timer); sub.remove(); };
  }, [on, member]);
  return null;
}
