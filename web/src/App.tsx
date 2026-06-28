import { useEffect, useState } from "react";
import { chapters } from "./content";
import { Sidebar } from "./components/Sidebar";
import { Chapter } from "./components/Chapter";

function currentFromHash(): string {
  const h = window.location.hash.replace(/^#/, "");
  return chapters.some((c) => c.id === h) ? h : chapters[0]?.id ?? "";
}

export default function App() {
  const [active, setActive] = useState<string>(currentFromHash);

  useEffect(() => {
    const onHash = () => setActive(currentFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const navigate = (id: string) => {
    window.location.hash = id;
    setActive(id);
    window.scrollTo({ top: 0 });
    document.getElementById("chapter-scroll")?.scrollTo({ top: 0 });
  };

  const chapter = chapters.find((c) => c.id === active) ?? chapters[0];
  const idx = chapters.findIndex((c) => c.id === chapter?.id);

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar chapters={chapters} active={active} onSelect={navigate} />
      <main id="chapter-scroll" className="flex-1 overflow-y-auto">
        {chapter && <Chapter chapter={chapter} onNavigate={navigate} />}
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-6 pb-16 pt-2">
          {idx > 0 ? (
            <button
              onClick={() => navigate(chapters[idx - 1].id)}
              className="rounded-lg border border-[#1f2940] bg-[#111a30] px-4 py-2 text-sm text-[#aab4cc] hover:text-white"
            >
              ← {chapters[idx - 1].title}
            </button>
          ) : (
            <span />
          )}
          {idx < chapters.length - 1 && (
            <button
              onClick={() => navigate(chapters[idx + 1].id)}
              className="ml-auto rounded-lg border border-[#1f2940] bg-[#111a30] px-4 py-2 text-sm text-[#aab4cc] hover:text-white"
            >
              {chapters[idx + 1].title} →
            </button>
          )}
        </div>
      </main>
    </div>
  );
}
