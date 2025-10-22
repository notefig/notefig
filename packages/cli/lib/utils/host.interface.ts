export interface HostDeployResult {
  createdFiles: string[];
}

export interface ProjectMetadata {
  title: string;
}

export interface HostDeployParams {
  metristsBuildCommand: string;
  outDir: string;
  hostOptions: any;
  projectMetadata?: ProjectMetadata;
  logger: any;
}

export interface HostPruneParams {
  workingDirectory: string;
  outDir: string;
  hostOptions: any;
  logger: any;
}

export interface Host {
  deploy: (params: HostDeployParams) => Promise<HostDeployResult>;
  getConfigFilePaths: () => string[];
  isHostUsed?: (workingDirectory: string) => boolean;
  pruneHost?: (params: HostPruneParams) => Promise<void>;
}
