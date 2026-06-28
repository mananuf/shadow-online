import type { Chapter } from "../content";

export function Sidebar({
  chapters,
  active,
  onSelect,
}: {
  chapters: Chapter[];
  active: string;
  onSelect: (id: string) => void;
}) {
  return (
    <nav className="flex h-full w-72 shrink-0 flex-col overflow-y-auto border-r border-[#1f2940] bg-[#0a0f1e]">
      <div className="border-b border-[#1f2940] px-5 py-5">
        <div className="text-sm font-semibold tracking-wide text-white">
          Shadow Simulation
        </div>
        <div className="text-xs text-[#7d8aa6]">Mastery Guide · gean</div>
      </div>
      <ul className="flex-1 px-2 py-3">
        {chapters.map((c) => {
          const on = c.id === active;
          return (
            <li key={c.id}>
              <button
                onClick={() => onSelect(c.id)}
                className={
                  "flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left text-sm transition " +
                  (on
                    ? "bg-[#16213c] text-white"
                    : "text-[#aab4cc] hover:bg-[#111a30] hover:text-white")
                }
              >
                <span
                  className={
                    "mt-0.5 w-6 shrink-0 text-xs font-mono " +
                    (on ? "text-[#6ea8fe]" : "text-[#5c6783]")
                  }
                >
                  {c.num}
                </span>
                <span className="leading-snug">{c.title}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="border-t border-[#1f2940] px-5 py-3 text-[11px] text-[#5c6783]">
        Same content as <code className="text-[#7d8aa6]">guide/*.md</code>
      </div>
    </nav>
  );
}
