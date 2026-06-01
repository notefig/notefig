import { join, resolve } from 'path';
import {
  readFile as readFileFs,
  readdir,
  cp as copyFileFs,
  mkdir,
  unlink,
  appendFile,
  writeFile,
} from 'fs/promises';
import { CopyOptions, existsSync, rmSync } from 'fs';
import { EOL } from 'os';

export async function readFile(...paths: string[]) {
  const finalPath = combinePaths(paths);
  return await readFileFs(finalPath, { encoding: 'utf8' });
}

export async function readFileInJson<TData = any>(
  ...params: Parameters<typeof readFile>
) {
  const fileContent = await readFile(...params);
  return JSON.parse(fileContent) as TData;
}

export async function readFileInJsonIfExists<TData = any>(
  ...params: Parameters<typeof readFile>
) {
  const finalPath = combinePaths(params);
  if (existsSync(finalPath)) {
    return await readFileInJson<TData>(...params);
  }
  return null;
}

export async function readFileInLines(...params: Parameters<typeof readFile>) {
  const fileContent = await readFile(...params);
  return fileContent.split(EOL);
}

export async function readFileIfExists<TData = any>(...paths: string[]) {
  const finalPath = combinePaths(paths);
  if (existsSync(finalPath)) {
    return readFile(finalPath) as Promise<TData>;
  }

  return null;
}

export async function appendToFile(
  filePath: string,
  data: string | string[] | Uint8Array,
) {
  if (Array.isArray(data)) {
    return await appendFile(filePath, data.join(EOL));
  } else {
    return await appendFile(filePath, data);
  }
}

export async function writeToFile(
  filePath: string,
  date: string | string[] | Uint8Array,
) {
  if (Array.isArray(date)) {
    return await writeFile(filePath, date.join(EOL));
  } else {
    return await writeFile(filePath, date);
  }
}

export function combinePaths(paths: string[]) {
  return paths.reduce(
    (finalPath, currentPortion) => join(finalPath, currentPortion),
    '',
  );
}

export async function* getContentsRecursively(dir: string) {
  const dirents = await readdir(dir, { withFileTypes: true });
  for (const dirent of dirents) {
    const res = resolve(dir, dirent.name);
    if (dirent.isDirectory()) {
      yield* getContentsRecursively(res);
    } else {
      yield res;
    }
  }
}

export function copyAllFilesFromOneDirectoryToAnother(
  directoryToLookAt: string,
  outputDirectory: string,
  shouldInclude: Parameters<typeof performOnAllFilesInDirectory>[2],
) {
  const allFilesPromises = [];
  performOnAllFilesInDirectory(
    directoryToLookAt,
    async (file) => {
      const relativePath = file.replace(directoryToLookAt, '');
      const outputPath = join(outputDirectory, relativePath);
      allFilesPromises.push(copyFile(file, outputPath, { recursive: true }));
    },
    shouldInclude,
  );

  return Promise.all(allFilesPromises);
}

export async function performOnAllFilesInDirectory(
  directoryPath: string,
  cb: (filePath: string, orderIndex?: number) => Promise<void>,
  shouldInclude: (filePath: string) => boolean,
) {
  const resultPromises = [];
  let orderIndex = 0;
  for await (const file of getContentsRecursively(directoryPath)) {
    if (shouldInclude(file)) {
      resultPromises.push(cb(file, orderIndex++));
    }
  }
  return Promise.all(resultPromises);
}

export async function createDirectory(directoryPath: string) {
  return await mkdir(directoryPath, { recursive: true });
}

export async function createDirectoryIfNotExists(directoryPath: string) {
  if (!pathExists(directoryPath)) {
    return await createDirectory(directoryPath);
  }
}

export async function deleteDirectory(directoryPath: string) {
  return await rmSync(directoryPath, { recursive: true, force: true });
}

export async function createFile(
  filePath: string,
  fileContent?: string | Uint8Array,
) {
  return await appendFile(filePath, fileContent ?? '');
}

export async function createFileIfNotExists(
  filePath: string,
  fileContent?: string | Uint8Array,
) {
  if (!pathExists(filePath)) {
    return await createFile(filePath, fileContent);
  }
}

export function pathExists(...path: string[]) {
  const finalPath = combinePaths(path);
  return existsSync(finalPath);
}

export async function copyFile(
  fromPath: string,
  toPath: string,
  options?: CopyOptions,
) {
  return await copyFileFs(fromPath, toPath, options);
}

export async function deleteFile(path: string) {
  return await unlink(path);
}
