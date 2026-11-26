# FreeMyDisk website

The website and blog for FreeMyDisk — a static site built with [Astro](https://astro.build). No backend, no database: every page is generated at build time, and every blog article is a Markdown file in this folder.

## Write an article

1. Create a Markdown file in [`blog/`](blog). The file name becomes the URL:

   `blog/How to free up disk space on your Windows laptop or PC.md` → `/blog/how-to-free-up-disk-space-on-your-windows-laptop-or-pc`

2. Start it with this front matter:

   ```markdown
   ---
   title: "How to free up disk space on your Windows laptop or PC"
   description: "One or two sentences shown on the blog index and in search results."
   date: 2026-11-27
   author: "Your Name"          # optional, defaults to "FreeMyDisk Team"
   tags: ["guide", "windows"]   # optional
   featured: false              # optional: true shows it as the big card on /blog
   draft: false                 # optional: true hides it
   updated: 2026-12-10          # optional
   cover: "/media/your-image.png" # optional: social preview image, put the file in public/media
   ---
   ```

3. Write the article in normal Markdown: `##` sections and `###` subsections build the table of contents automatically. Code blocks, tables and images all work.

   A blockquote that starts with bold text becomes a labelled callout:

   ```markdown
   > **Careful** Always keep at least one copy of anything you delete as a duplicate.
   ```

4. Open a pull request. When it is merged into `main`, Vercel publishes it within a minute.

## Run it locally

```powershell
cd website
pnpm install
pnpm dev        # http://localhost:4321
pnpm build      # production build into dist/
```

## Deploy on Vercel

1. In Vercel, **Add New → Project** and import `fzihak/FreeMyDisk`.
2. Set **Root Directory** to `website`. Vercel detects Astro; `vercel.json` sets the build command and output folder.
3. After the first deploy, add an environment variable **`SITE_URL`** with your final address (for example `https://freemydisk.app`) and redeploy. It is used for canonical links, the sitemap and the RSS feed. Update the `Sitemap:` line in `public/robots.txt` to the same address.

Every push to `main` that changes `website/` deploys automatically; pull requests get preview URLs.
