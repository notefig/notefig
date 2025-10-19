export interface HostDeployResult {
  createdFiles: string[];
}

export interface HostDeployParams {
  metristsBuildCommand: string;
  outDir: string;
  hostOptions: any;
}

export interface Host {
  deploy: (params: HostDeployParams) => Promise<HostDeployResult>;
  getConfigFilePaths: () => string[];
}
