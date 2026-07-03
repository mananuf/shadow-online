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
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    const onHash = () => setActive(currentFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const navigate = (id: string) => {
    window.location.hash = id;
    setActive(id);
    setNavOpen(false); // close the mobile drawer after picking a chapter
    window.scrollTo({ top: 0 });
    document.getElementById("chapter-scroll")?.scrollTo({ top: 0 });
  };

  const chapter = chapters.find((c) => c.id === active) ?? chapters[0];
  const idx = chapters.findIndex((c) => c.id === chapter?.id);

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      {/* Backdrop for the mobile drawer. */}
      {navOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/60 md:hidden"
          onClick={() => setNavOpen(false)}
          aria-hidden
        />
      )}

      <Sidebar
        chapters={chapters}
        active={active}
        onSelect={navigate}
        open={navOpen}
        onClose={() => setNavOpen(false)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile-only top bar: hamburger + current chapter. */}
        <header className="flex items-center gap-3 border-b border-[#1f2940] bg-[#0a0f1e] px-4 py-3 md:hidden">
          <button
            onClick={() => setNavOpen(true)}
            aria-label="Open chapters"
            className="rounded-lg border border-[#1f2940] p-2 text-[#aab4cc] hover:text-white"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-white">
              {chapter?.num}. {chapter?.title}
            </div>
            <div className="text-[11px] text-[#7d8aa6]">Shadow Simulation · Mastery Guide</div>
          </div>
        </header>

        <main id="chapter-scroll" className="flex-1 overflow-y-auto">
          {chapter && <Chapter chapter={chapter} onNavigate={navigate} />}
          <div className="mx-auto flex max-w-3xl flex-col gap-3 px-4 pb-16 pt-2 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            {idx > 0 ? (
              <button
                onClick={() => navigate(chapters[idx - 1].id)}
                className="rounded-lg border border-[#1f2940] bg-[#111a30] px-4 py-2 text-left text-sm text-[#aab4cc] hover:text-white"
              >
                ← {chapters[idx - 1].title}
              </button>
            ) : (
              <span className="hidden sm:block" />
            )}
            {idx < chapters.length - 1 && (
              <button
                onClick={() => navigate(chapters[idx + 1].id)}
                className="rounded-lg border border-[#1f2940] bg-[#111a30] px-4 py-2 text-left text-sm text-[#aab4cc] hover:text-white sm:ml-auto sm:text-right"
              >
                {chapters[idx + 1].title} →
              </button>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
