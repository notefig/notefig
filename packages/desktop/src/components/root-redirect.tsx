import { Navigate } from "react-router-dom";
import { useAppSettings } from "@/hooks/use-app-settings";

export function RootRedirect() {
  const { settings, isReady } = useAppSettings();

  // KV hydrates asynchronously; deciding before it's ready would read
  // lastPath as null on every cold boot and always land on /welcome.
  if (!isReady) {
    return null;
  }

  if (settings.lastPath) {
    return <Navigate to={settings.lastPath} replace />;
  }

  return <Navigate to="/welcome" replace />;
}
