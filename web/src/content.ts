// Single source of truth: the React app renders the very same Markdown chapters
// that live in ../guide. Imported raw at build time, sorted by filename (the
// 01..13 numbering), titled from each file's first H1.
const modules = import.meta.glob("../../guide/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

export interface Chapter {
  id: string; // filename without extension, e.g. "01-what-is-shadow"
  num: string; // "01"
  title: string; // from the first "# " heading
  body: string; // raw markdown
}

export const chapters: Chapter[] = Object.entries(modules)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([path, body]) => {
    const file = path.split("/").pop()!.replace(/\.md$/, "");
    const num = file.split("-")[0];
    const heading = body.match(/^#\s+(.+)$/m);
    const title = heading ? heading[1].replace(/^\d+\.\s*/, "").trim() : file;
    return { id: file, num, title, body };
  });
