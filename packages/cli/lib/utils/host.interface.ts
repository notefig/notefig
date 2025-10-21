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
}

export interface Host {
  deploy: (params: HostDeployParams) => Promise<HostDeployResult>;
  getConfigFilePaths: () => string[];
}
