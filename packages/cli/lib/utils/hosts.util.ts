interface Host {
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
}

const nixpacks = {
  configFileName: 'nixpacks.toml',
  getConfigFileContent: ({ outDir, command }) => `providers = ['node']

[phases.build]
cmds = ['${command}']

[start]
cmd = 'cd ${outDir} && npx serve -s'
`,
};

const vercel = {
  configFileName: 'vercel.json',
  getConfigFileContent: ({ outDir, command }) =>
    JSON.stringify({
      'buildCommand': command,
      'outputDirectory': outDir,
    }),
};

const netlify = {
  configFileName: 'netlify.toml',
  getConfigFileContent: ({ outDir, command }) => `[build]
publish = "${outDir}"
command = "${command}"
`,
};

const s3 = {
  sideEffect: async (config: any, options: { outDir: string }) => {
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
    const { Upload } = await import('@aws-sdk/lib-storage');
    const fs = await import('fs');
    const path = await import('path');

    if (!config?.hosts?.s3) {
      throw new Error('S3 configuration not found in .metristsrc file');
    }

    const s3Config = config.hosts.s3;

    const clientConfig: any = {
      region: s3Config.region,
    };

    if (s3Config.accessKeyId && s3Config.secretAccessKey) {
      clientConfig.credentials = {
        accessKeyId: s3Config.accessKeyId,
        secretAccessKey: s3Config.secretAccessKey,
      };
    } else if (s3Config.profile) {
      clientConfig.credentials = { profile: s3Config.profile };
    }

    const s3Client = new S3Client(clientConfig);

    const uploadFile = async (filePath: string, key: string) => {
      const fileStream = fs.createReadStream(filePath);
      const upload = new Upload({
        client: s3Client,
        params: {
          Bucket: s3Config.bucket,
          Key: key,
          Body: fileStream,
          ContentType: getContentType(filePath),
        },
      });

      await upload.done();
    };

    const getAllFiles = (
      dirPath: string,
      prefix = '',
    ): Array<{ filePath: string; key: string }> => {
      const items = fs.readdirSync(dirPath);
      const files: Array<{ filePath: string; key: string }> = [];

      for (const item of items) {
        const itemPath = path.join(dirPath, item);
        const key = prefix ? `${prefix}/${item}` : item;

        if (fs.statSync(itemPath).isDirectory()) {
          files.push(...getAllFiles(itemPath, key));
        } else {
          files.push({ filePath: itemPath, key });
        }
      }

      return files;
    };

    const allFiles = getAllFiles(options.outDir);
    const uploadPromises = allFiles.map(({ filePath, key }) =>
      uploadFile(filePath, key),
    );

    await Promise.all(uploadPromises);
    console.log(
      `Successfully uploaded ${allFiles.length} files to S3 bucket: ${s3Config.bucket}`,
    );
  },
};

function getContentType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const contentTypes: Record<string, string> = {
    'html': 'text/html',
    'css': 'text/css',
    'js': 'text/javascript',
    'json': 'application/json',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'svg': 'image/svg+xml',
    'pdf': 'application/pdf',
    'txt': 'text/plain',
  };
  return contentTypes[ext || ''] || 'application/octet-stream';
}

export const hostHelpers: Record<string, Host> = {
  netlify,
  vercel,
  nixpacks,
  coolify: nixpacks,
  railway: nixpacks,
  s3,
};

export function getHostHelper(host: keyof typeof hostHelpers) {
  return hostHelpers[host];
}

export function getSupportedHosts() {
  return Object.keys(hostHelpers);
}
