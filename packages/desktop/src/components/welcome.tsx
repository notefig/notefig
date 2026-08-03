import { useState, useEffect, useRef } from "react";
import {
  Plus,
  Github,
  Settings,
  Book,
  Moon,
  Sun,
  Monitor,
  FileText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { pickDirectory, pickFile } from "@/utils/fs";
import { buildLooseFileUrl } from "@/utils/loose-workspace";
import { isWeb } from "@/utils/platform";
import { FsError } from "@/adapters/platform-adapter.interface";
import { toast } from "sonner";
import { PlainLogo } from "@/components/logo";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { useSearchParams } from "react-router-dom";
import { useTheme } from "@/components/theme-provider";
import { useAppSettings } from "@/hooks/use-app-settings";
import { SettingsModal } from "@/components/editor/settings-modal";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useRecentProjects } from "@/hooks/use-recent-projects";
import { DebugPanel } from "./debug-panel";

function ThemeToggle() {
  const { setTheme } = useTheme();
  const { setTheme: persistTheme } = useAppSettings();

  const handleThemeChange = (theme: "light" | "dark" | "system") => {
    setTheme(theme);
    persistTheme(theme);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="w-9 h-9">
          <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
          <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
          <span className="sr-only">Toggle theme</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => handleThemeChange("light")}>
          <Sun className="h-4 w-4 mr-2" />
          Light
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => handleThemeChange("dark")}>
          <Moon className="h-4 w-4 mr-2" />
          Dark
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => handleThemeChange("system")}>
          <Monitor className="h-4 w-4 mr-2" />
          System
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

import { platformAdapter } from "@/adapters";

function openExternalLink(url: string) {
  platformAdapter.openExternal(url);
}

const projectButtonStyles = `
  group flex w-full items-center justify-between 
  rounded-lg border px-4 py-3 
  transition-all 
  text-left
  focus-visible:outline-none 
  focus-visible:ring-2 
  focus-visible:ring-primary 
`;

export function Welcome() {
  const [loading, setLoading] = useState(false);
  const [, setUrlSearchParams] = useSearchParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const newProjectRef = useRef<HTMLButtonElement>(null);
  const { addRecentProject, recentProjects } = useRecentProjects();

  useEffect(() => {
    const timer = setTimeout(() => {
      newProjectRef.current?.focus();
    }, 100);
    return () => clearTimeout(timer);
  }, []);

  const handleNewDocument = async () => {
    setLoading(true);
    try {
      const selectedPath = await pickDirectory("Select a folder");
      if (selectedPath) {
        addRecentProject(selectedPath);
        const encodedPath = encodeURIComponent(selectedPath);
        navigate(`/${encodedPath}`);
      }
    } catch (error) {
      // null means cancel; a throw means the browser denied the picker.
      if (error instanceof FsError && error.type === "permission_denied") {
        toast.error(t("pickerPermissionDenied"));
      } else {
        throw error;
      }
    } finally {
      setLoading(false);
    }
  };

  const handleOpenFile = async () => {
    setLoading(true);
    try {
      // Desktop-only (web adapters resolve pickFile to null) — a single
      // file edited in the loose sentinel workspace, no folder open.
      const selectedPath = await pickFile("Open File");
      if (selectedPath) {
        navigate(buildLooseFileUrl(selectedPath));
      }
    } finally {
      setLoading(false);
    }
  };

  const handleOpenProject = (path: string) => {
    addRecentProject(path);
    const encodedPath = encodeURIComponent(path);
    navigate(`/${encodedPath}`);
  };

  const handleOpenSettings = () => {
    setUrlSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("settings", "true");
        return next;
      },
      { replace: true },
    );
  };

  const handleOpenDocs = (e: React.MouseEvent) => {
    e.preventDefault();
    openExternalLink("https://metrists.com/docs");
  };

  const handleOpenGitHub = (e: React.MouseEvent) => {
    e.preventDefault();
    openExternalLink("https://github.com/metrists/metrists");
  };

  return (
    <div className="relative flex h-screen flex-col bg-background overflow-hidden texture-surface">
      <DebugPanel />
      <div className="absolute inset-0 flex items-center justify-center opacity-[0.03] pointer-events-none">
        <PlainLogo size={400} className="block dark:hidden text-foreground" />
        <PlainLogo size={400} fill="white" className="hidden dark:block" />
      </div>

      <nav className="relative z-10 flex items-center justify-end px-6 py-5 lg:px-8 gap-2">
        <Button
          variant="ghost"
          size="icon"
          onClick={handleOpenDocs}
          className="text-muted-foreground hover:text-foreground"
        >
          <Book className="h-5 w-5" />
          <span className="sr-only">Documentation</span>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleOpenGitHub}
          className="text-muted-foreground hover:text-foreground"
        >
          <Github className="h-5 w-5" />
          <span className="sr-only">GitHub</span>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleOpenSettings}
          className="text-muted-foreground hover:text-foreground"
        >
          <Settings className="h-5 w-5" />
          <span className="sr-only">Settings</span>
        </Button>
        <ThemeToggle />
      </nav>

      <div className="relative z-0 flex flex-1 flex-col overflow-hidden">
        <div className="flex flex-1 flex-col items-center justify-center px-6 py-12 lg:px-8">
          <div className="w-full max-w-2xl">
            <div className="mb-16 text-center">
              <h1 className="text-5xl md:text-6xl font-serif font-bold tracking-tight text-balance leading-tight">
                {t("welcomeTitle")}
                <span className="block text-primary mt-3 italic">
                  {t("welcomeTitleHighlight")}
                </span>
              </h1>
            </div>

            <ScrollArea className="h-[calc(100vh-400px)] max-h-[400px]">
              <div className="space-y-2 pr-4">
                <button
                  ref={newProjectRef}
                  onClick={handleNewDocument}
                  disabled={loading}
                  className={`
                    ${projectButtonStyles}
                    border-border bg-card text-foreground
                    hover:border-primary hover:bg-accent
                    focus-visible:border-primary focus-visible:bg-accent
                    disabled:opacity-50 disabled:cursor-not-allowed
                  `}
                >
                  <div className="flex flex-1 items-center gap-3 min-w-0">
                    <div className="flex h-10 w-10 items-center justify-center rounded-md bg-muted">
                      <Plus className="h-5 w-5 text-primary" />
                    </div>
                    <div className="min-w-0 flex-1 text-left">
                      <h4 className="truncate text-sm font-medium text-foreground">
                        {loading ? t("opening") : t("newDocument")}
                      </h4>
                      <p className="text-xs text-muted-foreground">
                        {t("createBlankDocument")}
                      </p>
                    </div>
                  </div>
                </button>

                {!isWeb() && (
                  <button
                    onClick={handleOpenFile}
                    disabled={loading}
                    className={`
                      ${projectButtonStyles}
                      border-border bg-card text-foreground
                      hover:border-primary hover:bg-accent
                      focus-visible:border-primary focus-visible:bg-accent
                      disabled:opacity-50 disabled:cursor-not-allowed
                    `}
                  >
                    <div className="flex flex-1 items-center gap-3 min-w-0">
                      <div className="flex h-10 w-10 items-center justify-center rounded-md bg-muted">
                        <FileText className="h-5 w-5 text-primary" />
                      </div>
                      <div className="min-w-0 flex-1 text-left">
                        <h4 className="truncate text-sm font-medium text-foreground">
                          {t("openSingleFile")}
                        </h4>
                        <p className="text-xs text-muted-foreground">
                          {t("openSingleFileDescription")}
                        </p>
                      </div>
                    </div>
                  </button>
                )}

                {recentProjects.length > 0 ? (
                  recentProjects.map((project) => (
                    <button
                      key={project.path}
                      onClick={() => handleOpenProject(project.path)}
                      className={`
                        ${projectButtonStyles}
                        border-border bg-card text-foreground
                        hover:border-primary hover:bg-accent
                        focus-visible:border-primary focus-visible:bg-accent
                      `}
                    >
                      <div className="flex flex-1 items-center gap-3 min-w-0">
                        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-muted">
                          <PlainLogo size={20} className="block dark:hidden" />
                          <PlainLogo
                            size={20}
                            fill="white"
                            className="hidden dark:block"
                          />
                        </div>
                        <div className="min-w-0 flex-1">
                          <h4 className="truncate text-sm font-medium text-foreground">
                            {project.name}
                          </h4>
                          <p className="text-xs text-muted-foreground">
                            {t("modified")} {project.lastModified}
                          </p>
                        </div>
                      </div>
                    </button>
                  ))
                ) : (
                  <div className="text-center py-8 text-muted-foreground">
                    <p className="text-sm">{t("noRecentProjects")}</p>
                    <p className="text-xs mt-1">{t("startByCreatingNew")}</p>
                  </div>
                )}
              </div>
            </ScrollArea>
          </div>
        </div>
      </div>

      <SettingsModal
        direction="ltr"
        onDirectionChange={() => {}}
        onFocusEditor={() => {}}
      />
    </div>
  );
}
