import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { readKv, useKv, writeKv } from "@/utils/kv-store";
import { SETTINGS_NAMESPACE } from "@/hooks/use-app-settings";
import { formatTimeAgo } from "@/utils/format";
import { useWorkspaceParams } from "@/hooks/use-workspace-params";
import { platformAdapter } from "@/adapters";
import { LAYOUT_PARAM, extractTabIds, parseLayout } from "@/utils/layout-codec";
import { isFileTabId } from "@/tabs/tab-id";
import type { LayoutNode } from "@/components/dockable";
import {
  createInitialLayout,
  removeTabFromLayout,
} from "@/utils/dockable-layout";
import {
  cleanupLegacyAgentConfigDir,
  resolveScratchpadOnDisk,
  sweepScratchpadsOnDisk,
} from "@/entities/scratchpads";
import { refetchWorkspaceMetadata } from "@/entities/files";

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

/** The last visited URL when it still points inside this project, else
 * the project's bare root. */
async function savedEntryBase(path: string): Promise<string> {
  const bare = `/${encodeURIComponent(path)}`;
  const saved = (await readKv<RecentProject>(RECENT_PROJECTS_NAMESPACE, path))
    ?.lastUrl;
  const savedIsInsideProject =
    saved === bare ||
    saved?.startsWith(`${bare}?`) ||
    saved?.startsWith(`${bare}/`);
  return savedIsInsideProject && saved ? saved : bare;
}

/** Drop file tabs whose files no longer exist on disk. */
async function pruneDeadFileTabs(layout: LayoutNode[]): Promise<LayoutNode[]> {
  const fileTabs = extractTabIds(layout).filter(isFileTabId);
  if (fileTabs.length === 0) return layout;
  const checks = await platformAdapter.fs.exists(fileTabs);
  return checks
    .filter((check) => !check.exists)
    .reduce((pruned, check) => removeTabFromLayout(pruned, check.path), layout);
}

/**
 * The URL a project entry lands on, computed ONCE from disk truth before
 * navigating — the single writer of the entry layout, so nothing can race
 * or clobber it (MET-135). Start from the last visited URL (if it still
 * points inside this project), drop file tabs whose files no longer
 * exist, and if no tabs survive, land in a scratchpad: abandoned empty
 * ones are swept away and the most recent survivor — or a fresh untitled
 * one — is baked into the layout. All on plain adapter fs; collections
 * are not consulted.
 */
async function computeProjectEntryUrl(path: string): Promise<string> {
  const base = await savedEntryBase(path);
  const [pathname, search = ""] = base.split("?");
  const params = new URLSearchParams(search);
  let layout = await pruneDeadFileTabs(parseLayout(params.get(LAYOUT_PARAM)));

  cleanupLegacyAgentConfigDir(path);

  const restoredTabs = extractTabIds(layout);
  if (restoredTabs.length > 0) {
    // Non-empty entry: sweep empty leftovers in the background, restore
    // as-is.
    void sweepScratchpadsOnDisk(path, restoredTabs).then(() =>
      refetchWorkspaceMetadata(path),
    );
  } else {
    // A scratchpad-resolution failure must degrade to a plain empty entry,
    // never reject computeProjectEntryUrl — an unhandled rejection here
    // strands the app at the bare root with no recorded URL (this is how
    // the metadata-Date wire bug presented: entry silently never resolved).
    try {
      await sweepScratchpadsOnDisk(path, []);
      // Off means off: an empty entry lands on the empty state — neither
      // creates a scratchpad nor auto-opens an existing one.
      const scratchpadOnStartup =
        (await readKv<boolean>(SETTINGS_NAMESPACE, "scratchpadOnStartup")) !==
        false;
      const scratchpad = scratchpadOnStartup
        ? await resolveScratchpadOnDisk(path)
        : null;
      if (scratchpad) layout = createInitialLayout(scratchpad);
    } catch (error) {
      console.error("[scratchpads] entry resolution failed:", error);
    }
    // The sweep/resolve mutated disk behind the collections' back; start
    // the re-walk NOW so the stale-tab pruner (gated on metadata fetching)
    // waits for rows that include the scratchpad we just baked in.
    void refetchWorkspaceMetadata(path);
  }

  if (layout.length === 0) {
    params.delete(LAYOUT_PARAM);
  } else {
    params.set(LAYOUT_PARAM, JSON.stringify(layout));
  }
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
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
export function useNavigationPersistence(): void {
  const { workspacePath } = useWorkspaceParams();
  const location = useLocation();
  const navigate = useNavigate();
  const enteredProjectRef = useRef<string | null>(null);
  const currentUrlRef = useRef("");
  currentUrlRef.current = location.pathname + location.search;

  useEffect(() => {
    if (!workspacePath) return;
    const fullPath = location.pathname + location.search;
    const entering = enteredProjectRef.current !== workspacePath;
    enteredProjectRef.current = workspacePath;

    const atBareRoot =
      !location.search && !location.pathname.slice(1).includes("/");
    if (entering && atBareRoot) {
      void computeProjectEntryUrl(workspacePath).then((entryUrl) => {
        // The user opened tabs (or left the project) while the entry URL
        // was being computed — their navigation wins, never clobber it.
        const [nowPathname, nowSearch = ""] = currentUrlRef.current.split("?");
        const nowHasTabs = new URLSearchParams(nowSearch).get(LAYOUT_PARAM);
        if (nowPathname !== location.pathname || nowHasTabs) return;
        if (entryUrl !== fullPath) {
          navigate(entryUrl, { replace: true });
        } else {
          void rememberProjectNavigation(workspacePath, fullPath);
        }
      });
      return;
    }

    void rememberProjectNavigation(workspacePath, fullPath);
  }, [workspacePath, location.pathname, location.search, navigate]);
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
