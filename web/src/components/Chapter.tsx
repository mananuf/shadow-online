import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { Chapter as ChapterT } from "../content";

// Markdown references images as ../assets/<run>/<file>.png (relative to guide/).
// The app serves them at /assets/..., so rewrite that prefix. Other links pass
// through. Internal chapter links (./NN-...md) are handled by App via onNavigate.
function makeUrlTransform(onNavigate: (id: string) => void) {
  return (url: string) => {
    if (url.startsWith("../assets/")) return url.replace("../assets/", "/assets/");
    return url;
  };
}

export function Chapter({
  chapter,
  onNavigate,
}: {
  chapter: ChapterT;
  onNavigate: (id: string) => void;
}) {
  return (
    <article className="md mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-10">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        urlTransform={makeUrlTransform(onNavigate)}
        components={{
          a({ href, children, ...props }) {
            // Intercept links to sibling chapters (e.g. ./03-foo.md or 03-foo.md)
            const m = href?.match(/(\d{2}-[a-z0-9-]+)\.md/i);
            if (m) {
              return (
                <a
                  href={`#${m[1]}`}
                  onClick={(e) => {
                    e.preventDefault();
                    onNavigate(m[1]);
                  }}
                  {...props}
                >
                  {children}
                </a>
              );
            }
            return (
              <a href={href} target="_blank" rel="noreferrer" {...props}>
                {children}
              </a>
            );
          },
        }}
      >
        {chapter.body}
      </Markdown>
    </article>
  );
}
