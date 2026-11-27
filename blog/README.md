# FreeMyDisk blog

Every Markdown file in this folder is an article on the FreeMyDisk website. When a pull request that changes this folder is merged into `main`, the website rebuilds and the article goes live within a minute or two.

Anyone can write an article or fix one. Please read the rules below first.

## Write an article

1. Copy [`_template.md`](_template.md) to a new file in this folder. The file name becomes the URL, so make it the article's title:

   `How to free up disk space on your Windows laptop or PC.md` becomes `/blog/how-to-free-up-disk-space-on-your-windows-laptop-or-pc`

2. Fill in the front matter at the top of the file:

   | Field | Required | Example | Notes |
   | --- | --- | --- | --- |
   | `title` | yes | `"How to clear the npm cache"` | Shown as the headline and in search results |
   | `description` | yes | `"One or two sentences."` | Shown on the blog index and in search results |
   | `date` | yes | `2026-12-01` | Publication date, `YYYY-MM-DD` |
   | `author` | no | `"Your Name"` | Defaults to `FreeMyDisk Team` |
   | `tags` | no | `["guide", "windows"]` | Lowercase; used for the topic filter |
   | `updated` | no | `2026-12-10` | Set it when you change an article's facts |
   | `featured` | no | `true` | Maintainers only: the big card on `/blog` |
   | `draft` | no | `true` | Keeps the article off the site |
   | `cover` | no | `"/blog/media/my-cover.png"` | Image for social previews |

3. Write the article in normal Markdown:
   - `##` sections and `###` subsections build the table of contents automatically. Do not use `#`, because the title is already the page heading.
   - Code blocks, tables, lists and links all work.
   - A blockquote that starts with bold text becomes a labelled callout:

     ```markdown
     > **Careful** Always keep one copy of anything you delete as a duplicate.
     ```

4. Put images in [`media/`](media) and link them relatively: `![The Storage page](media/storage-page.png)`. Use PNG or WebP, keep each file under 500 KB, and never include personal file names, user names or paths in screenshots.

5. Open a pull request. A check validates the front matter, and a maintainer reviews the content.

## What we publish

- **Practical and correct.** Every command and setting must be tested on Windows 10 or 11. Say which version you tested on when it matters.
- **Safe.** If a step can lose data or break something, say so before the step, not after it.
- **Honest.** No marketing claims and no "the best cleaner" comparisons. Mention FreeMyDisk only where it really helps the reader.
- **Your own words.** Do not copy text from other sites or AI tools without checking and rewriting it.

Files in this folder whose names start with `_`, and this `README.md`, are not published.
