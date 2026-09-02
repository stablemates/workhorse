import { createFileRoute, notFound } from "@tanstack/react-router";

import { posts } from "@/lib/blog";
import { postLoader } from "@/lib/mdx-loader";
import { postHead } from "@/lib/seo";

export const Route = createFileRoute("/blog/$slug")({
  loader: async ({ params }) => {
    const post = posts.find((candidate) => candidate.slug === params.slug);
    if (!post) throw notFound();

    // Load the MDX module before the component renders, so the shell is not
    // torn down while the post suspends. Same reason as the docs splat route.
    await postLoader.preload(post.path);

    return post;
  },
  head: ({ loaderData }) => {
    if (!loaderData) return {};
    return postHead(loaderData);
  },
  component: Post,
});

function Post() {
  const { path, date } = Route.useLoaderData();
  const Content = postLoader.getComponent(path);

  return <Content date={date} />;
}
