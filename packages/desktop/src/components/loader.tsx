import { useEffect, useState } from "react";
import { useWorkspaceParams } from "@/hooks/use-workspace-params";
import { useTranslation } from "react-i18next";
import { getSingltonStore } from "../utils/tinybase";
import Logo from "./logo";

function LoadingScreen() {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col items-center justify-center text-center max-w-md h-screen mx-auto px-4">
      <Logo
        size={96}
        animated={true}
        showBackground={false}
        fill="currentColor"
        className="text-foreground mx-auto mb-6"
      />
      <h2 className="text-xl font-semibold mb-3">{t("loading")}</h2>
      <p className="text-muted-foreground">{t("loadingWorkspace")}</p>
    </div>
  );
}

export function Loader({ children }: { children: React.ReactNode }) {
  const { workspacePath } = useWorkspaceParams();
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      if (!workspacePath) {
        return;
      }
      const [store, persister] = await getSingltonStore(workspacePath);
      if (persister.getStats().loads > 0) {
        console.log(store.getTables());
        setIsLoaded(true);
      }
    })();
  }, [workspacePath]);

  return isLoaded ? <>{children}</> : <LoadingScreen />;
}
