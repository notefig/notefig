export interface Host {
  configFileName?: string;
  getConfigFileContent?: ({
    outDir,
    command,
  }: {
    outDir: string;
    command: string;
  }) => string;
  sideEffect?: (
    config: any,
    options: { outDir: string; buildCommand: string },
  ) => Promise<void>;
  requiresBuild?: boolean;
}