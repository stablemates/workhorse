import { Link, createFileRoute } from "@tanstack/react-router";

import { formatPostDate, posts } from "@/lib/blog";
import { blogIndexHead } from "@/lib/seo";

/**
 * `/blog`: every post newest first with its title, date, and description.
 *
 * With zero posts the page still builds, because TanStack Start prerenders
 * every static route, but nothing links it and the sitemap does not list it,
 * so a reader only ever reaches it once there is something to read.
 */
export const Route = createFileRoute("/blog/")({
  head: () => blogIndexHead(),
  component: BlogIndex,
});

function BlogIndex() {
  return (
    <section className="mx-auto w-full max-w-3xl px-5 py-12 lg:px-8">
      <h1 className="wh-docs-title text-3xl font-semibold sm:text-4xl">Blog</h1>
      {posts.length === 0 && <p className="mt-6 text-fd-muted-foreground">No posts yet.</p>}
      <ol className="mt-10 space-y-10">
        {posts.map((post) => (
          <li key={post.slug}>
            <time dateTime={post.date} className="wh-mono-label">
              {formatPostDate(post.date)}
            </time>
            <h2 className="mt-2 text-xl font-semibold tracking-tight">
              <Link to="/blog/$slug" params={{ slug: post.slug }} className="hover:underline">
                {post.title}
              </Link>
            </h2>
            <p className="mt-2 text-[15px] leading-relaxed text-fd-muted-foreground">
              {post.description}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}
