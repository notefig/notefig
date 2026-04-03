"use client";

import { useState, useMemo } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { ExternalLink, Copy, Check } from "lucide-react";

export default function VercelDeployGenerator() {
  const [githubUrl, setGithubUrl] = useState("");
  const [copied, setCopied] = useState(false);

  // Reactive URL validation and generation
  const deployUrl = useMemo(() => {
    if (!githubUrl.trim()) return null;

    try {
      // Extract owner/repo from GitHub URL
      const match = githubUrl.match(/github\.com\/([^\/]+)\/([^\/\?#]+)/);
      if (!match) return null;

      const [, , repo] = match;
      const cleanRepo = repo.replace(/\.git$/, ""); // Remove .git extension if present

      // Generate the Vercel deployment URL
      const params = new URLSearchParams({
        "demo-description": `Deploy ${cleanRepo} built with Metrists`,
        "demo-title": cleanRepo,
        "demo-url": githubUrl,
        from: "templates",
        "project-name": cleanRepo,
        "repository-name": cleanRepo,
        "repository-url": githubUrl,
      });

      return `https://vercel.com/new/clone?${params.toString()}`;
    } catch (error) {
      return null;
    }
  }, [githubUrl]);

  const copyToClipboard = async () => {
    if (!deployUrl) return;

    try {
      await navigator.clipboard.writeText(deployUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      // Fallback for older browsers
      const textArea = document.createElement("textarea");
      textArea.value = deployUrl;
      document.body.appendChild(textArea);
      textArea.select();
      try {
        document.execCommand("copy");
      } catch (fallbackError) {
        console.warn("Copy fallback failed:", fallbackError);
      }
      document.body.removeChild(textArea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const deployToVercel = () => {
    if (deployUrl) {
      window.open(deployUrl, "_blank");
    }
  };

  return (
    <>
      <div className="space-y-4 py-1">
        <div className="flex gap-2">
          <Label htmlFor="github-url" className="hidden ">
            GitHub Repository URL
          </Label>
          <Input
            id="github-url"
            type="url"
            placeholder="https://github.com/username/repository"
            value={githubUrl}
            className="flex-1 outline-none ring-0 focus:ring-0"
            onChange={(e) => setGithubUrl(e.target.value)}
            onKeyDown={(e) =>
              e.key === "Enter" && deployUrl && deployToVercel()
            }
          />
          <Button
            onClick={deployToVercel}
            disabled={!deployUrl}
            className={`flex items-center gap-2 shrink-0 transition-all ${
              deployUrl
                ? "bg-black hover:bg-gray-800 text-white"
                : "bg-gray-100 text-gray-400 cursor-not-allowed"
            }`}
          >
            <ExternalLink className="w-4 h-4" />
            Deploy to Vercel
          </Button>
        </div>
      </div>
    </>
  );
}
