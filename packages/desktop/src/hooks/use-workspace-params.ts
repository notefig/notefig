import { useParams } from "react-router-dom";

export interface WorkspaceParams {
  workspacePath: string | null;
}

export function useWorkspaceParams(): WorkspaceParams {
  const params = useParams<{ basePath?: string }>();

  const workspacePath = params.basePath
    ? decodeURIComponent(params.basePath)
    : null;

  return {
    workspacePath,
  };
}
