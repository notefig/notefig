import { Navigate } from "react-router-dom";
import { useAppSettings } from "@/hooks/use-app-settings";

export function RootRedirect() {
  const { settings } = useAppSettings();

  if (settings.lastPath) {
    return <Navigate to={settings.lastPath} replace />;
  }

  return <Navigate to="/welcome" replace />;
}
