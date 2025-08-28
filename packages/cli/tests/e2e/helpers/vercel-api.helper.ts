export interface VercelProject {
  id: string;
  name: string;
  framework?: string | null;
}

export interface VercelDeployment {
  id: string;
  readyState: 'QUEUED' | 'BUILDING' | 'READY' | 'ERROR' | 'CANCELED';
  status: 'QUEUED' | 'BUILDING' | 'READY' | 'ERROR' | 'CANCELED';
  url?: string;
  ready?: number;
  errorMessage?: string;
  createdAt: number;
  alias?: string[];
  project?: VercelProject;
  [key: string]: any; // Allow additional properties we might not have defined
}

export interface DeploymentFile {
  file: string;
  data: string;
}

export class VercelApiHelper {
  private baseUrl = 'https://api.vercel.com';
  private token: string;
  private teamId?: string;

  constructor(token: string, teamId?: string) {
    this.token = token;
    this.teamId = teamId;
  }

  private async request(endpoint: string, options: RequestInit = {}): Promise<any> {
    const url = new URL(`${this.baseUrl}${endpoint}`);
    if (this.teamId) {
      url.searchParams.set('teamId', this.teamId);
    }
    
    const response = await fetch(url.toString(), {
      ...options,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Vercel API Error (${response.status}): ${errorText}`);
    }

    return response.json();
  }

  async createDeployment(files: DeploymentFile[], name: string): Promise<VercelDeployment> {
    const payload = {
      name,
      files,
      target: 'production',
    };

    return await this.request('/v13/deployments?skipAutoDetectionConfirmation=1', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  async getDeployment(deploymentId: string): Promise<VercelDeployment> {
    return await this.request(`/v13/deployments/${deploymentId}`);
  }

  async deleteDeployment(deploymentId: string): Promise<void> {
    await this.request(`/v13/deployments/${deploymentId}`, {
      method: 'DELETE',
    });
  }

  async deleteProject(projectId: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/v9/projects/${projectId}${this.teamId ? `?teamId=${this.teamId}` : ''}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Vercel API Error (${response.status}): ${errorText}`);
    }

    // Project deletion may return empty response (204 No Content)
    if (response.status !== 204 && response.headers.get('content-length') !== '0') {
      await response.json();
    }
  }

  async waitForDeployment(deploymentId: string, timeoutMs = 300000): Promise<VercelDeployment> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeoutMs) {
      const deployment = await this.getDeployment(deploymentId);
      
      if (deployment.readyState === 'READY') {
        return deployment;
      }
      
      if (deployment.readyState === 'ERROR' || deployment.readyState === 'CANCELED') {
        throw new Error(`Deployment failed with status ${deployment.readyState}: ${deployment.errorMessage || 'Unknown error'}`);
      }
      
      // Wait 5 seconds before polling again
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    
    throw new Error(`Deployment timeout after ${timeoutMs}ms`);
  }
}