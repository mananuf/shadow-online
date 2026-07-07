// Single source of truth: the React app renders the very same Markdown chapters
// that live on disk. Two curricula, each its own folder, imported raw at build
// time and sorted by filename (the 00..NN numbering). Titled from each file's
// first H1.
const guideModules = import.meta.glob("../../guide/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const stateTransitionModules = import.meta.glob("../../state-transition/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

export interface Chapter {
  id: string; // filename without extension, e.g. "07-state-transition-pipeline"
  num: string; // "07"
  title: string; // from the first "# " heading
  body: string; // raw markdown
  section: string; // curriculum this chapter belongs to
}

function toChapters(modules: Record<string, string>, section: string): Chapter[] {
  return Object.entries(modules)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, body]) => {
      const file = path.split("/").pop()!.replace(/\.md$/, "");
      const num = file.split("-")[0];
      const heading = body.match(/^#\s+(.+)$/m);
      const title = heading ? heading[1].replace(/^\d+\.\s*/, "").trim() : file;
      return { id: file, num, title, body, section };
    });
}

export const chapters: Chapter[] = [
  ...toChapters(guideModules, "Shadow Simulation"),
  ...toChapters(stateTransitionModules, "State Transition"),
];

// Sections in display order, each with its ordered chapters. The sidebar renders
// these as labelled groups; navigation still walks the flat `chapters` list.
export const sections: { name: string; chapters: Chapter[] }[] = [
  { name: "Shadow Simulation", chapters: chapters.filter((c) => c.section === "Shadow Simulation") },
  { name: "State Transition", chapters: chapters.filter((c) => c.section === "State Transition") },
].filter((s) => s.chapters.length > 0);
