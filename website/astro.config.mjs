// @ts-check
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

// Set SITE_URL in Vercel (Project → Settings → Environment Variables) once the
// final domain is known; it is used for canonical URLs, the sitemap and RSS.
const site = process.env.SITE_URL || "https://freemydisk.vercel.app";

export default defineConfig({
  site,
  trailingSlash: "never",
  build: { format: "file" },
  integrations: [sitemap()],
  markdown: {
    shikiConfig: { theme: "github-dark-default", wrap: false },
  },
});
