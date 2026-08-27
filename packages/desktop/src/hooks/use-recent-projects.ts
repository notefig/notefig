import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { readKv, useKv, writeKv } from "@/utils/kv-store";
import { formatTimeAgo } from "@/utils/format";
import { useWorkspaceParams } from "@/hooks/use-workspace-params";

const RECENT_PROJECTS_NAMESPACE = "recentProjects";
const MAX_RECENT_PROJECTS = 20;

export interface RecentProject {
  name: string;
  lastOpenedAt: number;
  /**
   * Full in-app URL (pathname + search) last visited inside this project —
   * layout, open tabs, sort, sidebar and modal state all live in the search
   * params, so this one string is the whole restorable session.
   */
  lastUrl?: string;
}

export function deriveProjectName(path: string, name?: string) {
  return name || path.split(/[/\\]/).filter(Boolean).pop() || "Untitled";
}

/**
 * Record the URL the user is currently at inside a project. Runs on every URL
 * change, so it never bumps lastOpenedAt — recency ordering only changes on
 * an explicit open. Creates the row if missing, which also gets projects
 * opened via the native menu or command palette into the recents list.
 */
async function rememberProjectNavigation(path: string, url: string) {
  const existing = await readKv<RecentProject>(RECENT_PROJECTS_NAMESPACE, path);
  if (existing?.lastUrl === url) return;
  await writeKv<RecentProject>(RECENT_PROJECTS_NAMESPACE, path, {
    name: deriveProjectName(path),
    lastOpenedAt: Date.now(),
    ...existing,
    lastUrl: url,
  });
}

/**
 * URL to land on when entering a project: the last visited URL if one is on
 * record (and still points inside this project), else the bare workspace
 * root. Open paths navigate to the bare root; useNavigationPersistence calls
 * this on entry and replace-navigates to the saved URL.
 */
async function projectOpenUrl(path: string): Promise<string> {
  const bare = `/${encodeURIComponent(path)}`;
  const saved = (await readKv<RecentProject>(RECENT_PROJECTS_NAMESPACE, path))
    ?.lastUrl;
  const savedIsInsideProject =
    saved === bare ||
    saved?.startsWith(`${bare}?`) ||
    saved?.startsWith(`${bare}/`);
  return savedIsInsideProject && saved ? saved : bare;
}

/**
 * Keeps the workspace URL — layout, open tabs, sort, sidebar and modal state
 * all live in its search params — persisted per project, and restores it when
 * the project is entered again.
 *
 * Mounted once in Workspace. Every URL change is recorded fire-and-forget on
 * the project's recents row; the one exception is *arriving* at the bare
 * workspace root, which is what every open path (welcome list, folder picker,
 * command palette, native menu) navigates to. Recording that would wipe the
 * saved session, so entry at the bare root instead replace-navigates to the
 * saved URL. Once inside the project a bare URL is the user's own doing
 * (e.g. closing the last tab) and is recorded like any other.
 */
export function useNavigationPersistence(): { isEntrySettled: boolean } {
  const { workspacePath } = useWorkspaceParams();
  const location = useLocation();
  const navigate = useNavigate();
  const enteredProjectRef = useRef<string | null>(null);
  // False until the entry decision resolved: entering at the bare root, the
  // saved URL is looked up asynchronously and the layout is empty for that
  // beat — consumers (scratchpad auto-open) must not judge it yet.
  const [isEntrySettled, setIsEntrySettled] = useState(false);

  useEffect(() => {
    if (!workspacePath) return;
    const fullPath = location.pathname + location.search;
    const entering = enteredProjectRef.current !== workspacePath;
    enteredProjectRef.current = workspacePath;
    if (entering) setIsEntrySettled(false);

    const atBareRoot =
      !location.search && !location.pathname.slice(1).includes("/");
    if (entering && atBareRoot) {
      void projectOpenUrl(workspacePath).then((savedUrl) => {
        if (savedUrl !== fullPath) {
          navigate(savedUrl, { replace: true });
        } else {
          void rememberProjectNavigation(workspacePath, fullPath);
        }
        setIsEntrySettled(true);
      });
      return;
    }

    setIsEntrySettled(true);
    void rememberProjectNavigation(workspacePath, fullPath);
  }, [workspacePath, location.pathname, location.search, navigate]);

  return { isEntrySettled };
}

export interface RecentProjectDisplay extends RecentProject {
  path: string;
  lastModified: string;
}

export function useRecentProjects() {
  const { values, set, remove } = useKv<RecentProject>(
    RECENT_PROJECTS_NAMESPACE,
  );

  function addRecentProject(path: string, name?: string) {
    // Spread the existing row so a re-open keeps its saved lastUrl.
    const newEntry: RecentProject = {
      ...values[path],
      name: deriveProjectName(path, name),
      lastOpenedAt: Date.now(),
    };

    set(path, newEntry);

    const entries = Object.entries(values);
    if (entries.length > MAX_RECENT_PROJECTS) {
      const sorted = entries.sort(
        (a, b) => a[1].lastOpenedAt - b[1].lastOpenedAt,
      );
      const toRemove = sorted.slice(0, entries.length - MAX_RECENT_PROJECTS);
      for (const [key] of toRemove) {
        remove(key);
      }
    }
  }

  function removeRecentProject(path: string) {
    remove(path);
  }

  function getRecentProjects(): RecentProjectDisplay[] {
    return Object.entries(values)
      .map(([path, data]) => ({
        path,
        name: data.name,
        lastOpenedAt: data.lastOpenedAt,
        lastModified: formatTimeAgo(data.lastOpenedAt),
      }))
      .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  }

  function clearRecentProjects() {
    const allKeys = Object.keys(values);
    for (const key of allKeys) {
      remove(key);
    }
  }

  return {
    recentProjects: getRecentProjects(),
    addRecentProject,
    removeRecentProject,
    clearRecentProjects,
  };
}
