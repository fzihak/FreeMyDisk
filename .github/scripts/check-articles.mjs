// Validates the front matter of every article in blog/ so a broken article
// can never break the website build. Run: node .github/scripts/check-articles.mjs
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const DIR = "blog";
const skip = (n) => n.startsWith("_") || /^readme/i.test(n);
const files = (await readdir(DIR, { recursive: true }))
  .map((f) => f.replaceAll("\\", "/"))
  .filter((f) => f.endsWith(".md") && !skip(f.split("/").pop()));

const errors = [];
const slugs = new Map();

for (const file of files) {
  const text = await readFile(join(DIR, file), "utf8");
  const fail = (msg) => errors.push(`${DIR}/${file}: ${msg}`);
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) { fail("missing front matter (--- block at the top)"); continue; }

  const fm = Object.fromEntries(
    m[1].split(/\r?\n/).filter((l) => /^\w+:/.test(l)).map((l) => {
      const i = l.indexOf(":");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
  );
  const unquote = (v) => (v ?? "").replace(/^["']|["']$/g, "").trim();

  if (!unquote(fm.title)) fail("`title` is required");
  if (!unquote(fm.description)) fail("`description` is required");
  for (const key of ["date", "updated"]) {
    if (key === "date" && !fm.date) { fail("`date` is required (YYYY-MM-DD)"); continue; }
    if (fm[key] && !/^\d{4}-\d{2}-\d{2}$/.test(unquote(fm[key]))) fail(`\`${key}\` must be YYYY-MM-DD`);
  }
  for (const key of ["featured", "draft"]) {
    if (fm[key] && !/^(true|false)$/.test(fm[key])) fail(`\`${key}\` must be true or false`);
  }
  if (fm.tags && !/^\[.*\]$/.test(fm.tags)) fail('`tags` must be a list, e.g. ["guide", "windows"]');
  const body = text.slice(m[0].length).replace(/^(```|~~~)[\s\S]*?^\1/gm, "");
  if (/^#\s/m.test(body)) fail("do not use a level-1 `#` heading; the title is the page heading");

  const slug = file.replace(/\.md$/, "").toLowerCase().replace(/[^a-z0-9/]+/g, "-").replace(/^-|-$/g, "");
  if (slugs.has(slug)) fail(`same URL as ${slugs.get(slug)}`);
  slugs.set(slug, file);
}

if (errors.length) {
  console.error(errors.map((e) => `::error::${e}`).join("\n"));
  process.exit(1);
}
console.log(`${files.length} article(s) OK`);
