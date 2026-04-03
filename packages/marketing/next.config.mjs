/** @type {import('next').NextConfig} */
import nextra from "nextra";

// Set up Nextra with its configuration for docs pages only
const withNextra = nextra({
  theme: "nextra-theme-docs",
  themeConfig: "./theme.config.tsx",
});

// Export the final Next.js config with Nextra included
export default withNextra({
  output: "export",
  distDir: "dist",
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  pageExtensions: ["js", "jsx", "ts", "tsx", "md", "mdx"],
});
