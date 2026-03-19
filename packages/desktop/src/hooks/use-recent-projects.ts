import { useKv } from "@/utils/kv-store";
import { formatTimeAgo } from "@/utils/format";

const RECENT_PROJECTS_NAMESPACE = "recentProjects";
const MAX_RECENT_PROJECTS = 20;

export interface RecentProject {
  name: string;
  lastOpenedAt: number;
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
    const folderName =
      name || path.split("/").pop() || path.split("\\").pop() || "Untitled";

    const newEntry: RecentProject = {
      name: folderName,
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
