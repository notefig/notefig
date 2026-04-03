import React from "react";
import { DocsThemeConfig } from "nextra-theme-docs";
import { useRouter } from "next/router";
import { useConfig } from 'nextra-theme-docs';

const config: DocsThemeConfig = {
  logo: (
    <div className="flex items-center gap-2">
      <svg
        version="1.2"
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 128 128"
        width="32"
        height="32"
        className="fill-[#1D4528] dark:fill-white"
      >
        <path d="m6 45c0-21.5 17.5-39 39-39h38c21.5 0 39 17.5 39 39v38c0 21.5-17.5 39-39 39h-38c-21.5 0-39-17.5-39-39zm15.5-1.8c-1.2 0.7-2.3 1.6-2.9 2.9-1 2.1-1.2 4.4-0.8 6.6 0.6 2.7 3.9 3.1 6.3 1.5q0.9-0.6 1.9-1.3c2.8-1.6 6 0.8 5.8 3.9-0.2 2.3 1.5 4.1 3.8 4.1h1.5c2.8 0 5.2-2.3 5.5-5.1q0.3-2.6 0.8-5.1c0.7-3.7 3.6-6.6 7.3-7.3q2.5-0.5 5.1-0.8c2.8-0.3 5.1-2.7 5.1-5.6v-1.5c0-2.2-1.8-4-4-3.8-3.2 0.3-5.6-3-3.9-5.7q0.6-1 1.3-2c1.5-2.3 1.1-5.6-1.6-6.2-2.1-0.4-4.4-0.3-6.5 0.7-1.3 0.7-2.3 1.8-3 3q-0.8 1.2-1.5 2.5c-4.1 7.4-10.3 13.6-17.7 17.7q-1.2 0.7-2.5 1.5zm63.3-21.7c-0.7-1.2-1.7-2.3-2.9-3-2.2-1-4.5-1.1-6.6-0.7-2.7 0.6-3.1 3.9-1.6 6.2q0.7 1 1.3 2c1.7 2.7-0.7 6-3.9 5.7-2.2-0.2-4 1.6-4 3.8v1.5c0 2.9 2.3 5.3 5.1 5.6q2.6 0.3 5.1 0.8c3.7 0.7 6.6 3.6 7.3 7.3q0.5 2.5 0.8 5.1c0.3 2.8 2.7 5.1 5.5 5.1h1.5c2.3 0 4-1.8 3.9-4.1-0.3-3.1 2.9-5.5 5.7-3.9q1 0.7 2 1.3c2.3 1.6 5.6 1.2 6.2-1.5 0.4-2.2 0.2-4.5-0.8-6.6-0.6-1.3-1.7-2.2-2.9-2.9q-1.3-0.8-2.5-1.5c-7.4-4.1-13.6-10.3-17.7-17.7q-0.7-1.3-1.5-2.5zm21.7 63.3c1.2-0.7 2.3-1.7 2.9-3 1-2.1 1.2-4.4 0.8-6.5-0.6-2.8-3.9-3.1-6.2-1.6q-1 0.7-2 1.3c-2.8 1.7-6-0.7-5.7-3.9 0.1-2.2-1.6-4-3.9-4h-1.5c-2.8 0-5.2 2.2-5.5 5.1q-0.3 2.5-0.8 5.1c-0.7 3.7-3.6 6.6-7.3 7.3q-2.5 0.5-5.1 0.8c-2.8 0.3-5.1 2.6-5.1 5.5v1.5c0 2.2 1.8 4 4 3.8 3.2-0.2 5.6 3 3.9 5.7q-0.6 1-1.3 2c-1.5 2.3-1.1 5.6 1.6 6.2 2.1 0.5 4.4 0.3 6.5-0.7 1.3-0.6 2.3-1.7 3-2.9q0.8-1.3 1.5-2.5c4.1-7.5 10.3-13.7 17.7-17.8q1.3-0.7 2.5-1.4zm-63.3 21.7c0.7 1.2 1.7 2.3 3 2.9 2.1 1 4.4 1.2 6.5 0.7 2.7-0.6 3.1-3.9 1.6-6.2q-0.7-1-1.3-2c-1.7-2.7 0.7-5.9 3.9-5.7 2.2 0.2 4-1.6 4-3.8v-1.5c0-2.9-2.3-5.2-5.1-5.5q-2.6-0.3-5.1-0.8c-3.7-0.7-6.6-3.6-7.3-7.3q-0.5-2.6-0.8-5.1c-0.3-2.9-2.7-5.1-5.5-5.1h-1.5c-2.3 0-4 1.8-3.8 4 0.2 3.2-3 5.6-5.7 3.9q-1.1-0.6-2-1.3c-2.4-1.5-5.7-1.2-6.3 1.6-0.4 2.1-0.2 4.4 0.8 6.5 0.6 1.3 1.7 2.2 2.9 3q1.3 0.7 2.5 1.4c7.4 4.1 13.6 10.3 17.7 17.8q0.7 1.2 1.5 2.5z" />
      </svg>
      <span
        className="font-medium text-[#1D4528] text-2xl italics dark:text-white"
        style={{ fontFamily: "var(--font-playfair)" }}
      >
        Metrists
      </span>
    </div>
  ),
  project: {
    link: "https://github.com/metrists/metrists",
  },
  docsRepositoryBase: "https://github.com/metrists/metrists/tree/main",
  footer: {
    component: () => null,
  },
  head: function Head() {
    const { asPath } = useRouter();
    const { frontMatter, title } = useConfig();
    
    // Generate page title based on Nextra's title resolution
    const getPageTitle = () => {
      if (asPath === '/docs' || asPath === '/') {
        return 'Metrists Documentation';
      }
      
      // Use Nextra's resolved title (from _meta.js or frontmatter)
      if (title && title !== 'Metrists') {
        return `${title} - Metrists Documentation`;
      }
      
      // Fallback: generate from path
      const cleanPath = asPath.replace('/docs/', '').replace('/docs', '');
      if (cleanPath) {
        const segments = cleanPath.split('/').filter(Boolean);
        const pathTitle = segments.map(segment => 
          segment.replace(/[-_]/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
        ).join(' - ');
        return `${pathTitle} - Metrists Documentation`;
      }
      
      return 'Metrists Documentation';
    };

    return (
      <>
        <title>{getPageTitle()}</title>
        <meta name="theme-color" content="#1D4528" />
        <meta name="msapplication-TileColor" content="#1D4528" />
        <style jsx global>{`
          :root {
            --nextra-primary-hue: 127deg;
            --nextra-primary-saturation: 34%;
            --nextra-bg: #fefcf8;
          }
          [data-theme="dark"] {
            --nextra-bg: #1a1a1a;
          }
          .nextra-nav-container {
            background-color: #f8f6f0 !important;
            border-bottom: 1px solid #e5e5e5;
          }
          .dark .nextra-nav-container {
            background-color: #1a1a1a !important;
          }
          .nextra-content {
            font-family: var(--font-inter) !important;
          }
          .nextra-sidebar {
            background-color: #f8f6f0 !important;
          }
          .dark .nextra-sidebar {
            background-color: #1a1a1a !important;
          }
          body {
            background-image: radial-gradient(
              circle at 1px 1px,
              rgba(0, 0, 0, 0.02) 1px,
              transparent 0
            ) !important;
            background-size: 20px 20px !important;
          }
          body::before {
            content: "";
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: radial-gradient(
                circle at 25% 25%,
                rgba(139, 69, 19, 0.01) 0%,
                transparent 50%
              ),
              radial-gradient(
                circle at 75% 75%,
                rgba(160, 82, 45, 0.01) 0%,
                transparent 50%
              ),
              linear-gradient(
                45deg,
                transparent 49%,
                rgba(139, 69, 19, 0.005) 50%,
                transparent 51%
              );
            pointer-events: none;
            z-index: -1;
          }
          .nextra-menu-mobile,
          .nextra-nav-container-blur,
          [data-nextra-menu] {
            --nextra-primary-hue: 127deg !important;
            --nextra-primary-saturation: 34% !important;
          }
        `}</style>
      </>
    );
  },
  color: {
    hue: 127,
    saturation: 34,
    lightness: {
      light: 28,
      dark: 65,
    },
  },
};

export default config;
