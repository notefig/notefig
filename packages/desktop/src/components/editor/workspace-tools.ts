/**
 * The focused workspace's tools as the sidebar draws them — icon and label
 * key per tool, in one leaf so the Everything view's unfolded rows and the
 * tool view's pill tabs cannot drift apart. (A leaf, not an export off a
 * component module: react-refresh downgrades any edit to a module that
 * exports non-components to a full reload.)
 */
import { FileText, GitBranch, Search, Sparkles } from "lucide-react";
import type { WorkspaceTool } from "@/hooks/use-workspace-panels";

export const TOOL_ICONS: Record<WorkspaceTool, typeof FileText> = {
  files: FileText,
  search: Search,
  git: GitBranch,
  sessions: Sparkles,
};

export const TOOL_LABEL_KEYS: Record<WorkspaceTool, string> = {
  files: "files",
  search: "search",
  git: "git",
  sessions: "agentSessions",
};
