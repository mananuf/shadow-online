import type { Chapter } from "../content";

export function Sidebar({
  chapters,
  active,
  onSelect,
  open,
  onClose,
}: {
  chapters: Chapter[];
  active: string;
  onSelect: (id: string) => void;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <nav
      className={
        // Off-canvas drawer on small screens; static column from md up.
        "fixed inset-y-0 left-0 z-40 flex h-full w-72 max-w-[85%] shrink-0 transform flex-col overflow-y-auto border-r border-[#1f2940] bg-[#0a0f1e] transition-transform duration-200 md:static md:z-auto md:max-w-none md:translate-x-0 " +
        (open ? "translate-x-0" : "-translate-x-full")
      }
    >
      <div className="flex items-start justify-between gap-2 border-b border-[#1f2940] px-5 py-5">
        <div>
          <div className="text-sm font-semibold tracking-wide text-white">Shadow Simulation</div>
          <div className="text-xs text-[#7d8aa6]">Mastery Guide · gean</div>
        </div>
        <button
          onClick={onClose}
          aria-label="Close chapters"
          className="-mr-1 rounded-lg p-1 text-[#7d8aa6] hover:text-white md:hidden"
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
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </button>
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
