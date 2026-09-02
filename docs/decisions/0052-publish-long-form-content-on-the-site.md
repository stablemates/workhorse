# ADR 0052: Publish long-form content on the site

- **Status:** Accepted
- **Date:** 2026-09-02
- **Related:** [WH-556](https://ontrack.sh/projects/WH/issues/WH-556),
  [WH-589](https://ontrack.sh/projects/WH/issues/WH-589),
  [WH-548](https://ontrack.sh/projects/WH/issues/WH-548),
  [ADR 0033](0033-maintain-site-docs-as-a-guide-consumer.md),
  [ADR 0046](0046-make-readmes-entry-points.md),
  [ADR 0049](0049-publish-one-agent-documentation-layer.md)

## Context

The public beta launches in the four weeks from 2026-09-07 (WH-548). The launch and the content
pieces around it need a home for long-form writing: essays, announcements, and comparisons that are
neither product reference nor a README.

`https://workhorse.run` has a landing page and the documentation under `/docs`. It has no blog, no
changelog page, no feed, and no social links. Release notes live in the repository as three
per-line files: `CHANGELOG.md`, `python/CHANGELOG.md`, and `go/CHANGELOG.md`, each entry naming its
schema version and upgrade steps.

The launch research recorded on the map's research branches fixes four facts:

- The two strongest library launches in the peer survey, River and Absurd, each linked a
  first-person essay on the author's own domain, published the same day as the thread. Repository
  links from unknown accounts scored 2 to 5 points in every case surveyed, and resubmitting an
  unchanged repository never scored. Follow-ups that scored were substantive essays, not links.
- dev.to accepts an article with a `canonical_url` and its staff guidance says a cross-post with
  a canonical need not worry about duplicate content. Seven weekly newsletters take links by
  email or form on fixed weekdays, and Console lists only pre-1.0 or beta-labelled tools.
- The site is crawlable and declares a sitemap, but no search engine returns it for its own name
  or for "workhorse postgres queue". The only indexed Workhorse property is the PyPI page. GitHub
  Discussions is disabled on the repository.
- One maintainer executes the plan with about one day a week and no paid spend.

The site build makes a second content section cheap. `site/source.config.ts` defines one
`fumadocs-mdx` collection over `content/docs`. `site/scripts/gen-docs-index.ts` reads that
collection at build time and emits the sidebar, one record per page, `sitemap.xml`, `robots.txt`,
the prerender list, `llms.txt`, `llms-full.txt`, and a Markdown twin per page.
`site/lib/seo.ts` builds each page's canonical link, Open Graph tags, the `text/markdown` alternate,
and JSON-LD. `vite.config.ts` prerenders every listed path, and `deployment/site.conf` serves the
result as static files, already naming `application/rss+xml` among its charset types.

Three alternatives were weighed. A third-party host such as dev.to as the home puts the link a
reader follows in three months under someone else's brand and gives that host the search ranking
the site lacks. GitHub Discussions announcements render under `github.com`, carry no canonical,
and depend on a feature the repository has turned off. No home at all, with the README and docs
carrying the load, repeats the pattern that scored 2 to 5 points: the link is a repository, and
ADR 0046 keeps the README near 200 lines with no room for an essay.

## Decision

`https://workhorse.run/blog` owns long-form content. Each post is one MDX file under
`site/content/blog/`, built by the same `fumadocs-mdx` pipeline as the documentation, prerendered,
and served at `https://workhorse.run/blog/<slug>` with that URL as its canonical.

Other hosts syndicate and never originate. A dev.to copy or any similar cross-post carries a
`canonical_url` naming the site post. Social posts, newsletter submissions, and any GitHub
Discussions announcement link to the site post. Whether Discussions is enabled is the readiness
bar's decision, not this one.

The README and the documentation keep the roles ADR 0046 gives them: the README is the repository
entrance, the site owns the canonical public explanation and reference. An essay is neither and
does not enter the README.

Release notes stay in the three changelog files. The site gains no changelog page in this window.
If the content plan picks a release announcement, it is a post that links the changelog entry.

Posts are not documentation for ADR 0049's purposes. `llms.txt` and `llms-full.txt` keep
mirroring the documentation sidebar and never list a post. Each post still gets a Markdown twin at
`/blog/<slug>.md`, so the router's promise that any page URL plus `.md` returns Markdown stays true.

### Minimum the section ships with

The execution Issue that builds the section delivers exactly this and nothing more:

1. **Collection.** `site/content/blog/<slug>.mdx` with frontmatter `title`, `description`, and
   `date` as an ISO calendar date. The collection is declared in `site/source.config.ts` beside
   `docs`. No author field: the posting identity is decided elsewhere and can add one.
2. **Routes.** `/blog` lists posts newest first with title, date, and description. `/blog/<slug>`
   renders one post with its title, its date, and the documentation prose styling. Both use the
   head helper in `site/lib/seo.ts`, so a post carries its canonical URL, description, Open Graph
   tags with `og:type` `article`, and the `text/markdown` alternate link.
3. **Build outputs.** The generator adds `/blog` and every post to `prerender.json` and
   `sitemap.xml`, writes a Markdown twin per post, and writes `/blog/feed.xml` listing every post
   newest first with its canonical URL. `llms.txt` and `llms-full.txt` are unchanged by the
   presence of posts.
4. **Navigation.** A "Blog" link in the header links of `site/app/layout.config.tsx` and in the
   footer's Project column, rendered only when the collection has at least one post. With zero
   posts `/blog` is neither linked nor in the sitemap, so the section can land on `main` before the
   first post without an empty page reaching a reader.
5. **Conventions.** `site/README.md` documents the collection and its frontmatter. A post's code
   is not compiled by `site/scripts/check-language-examples.ts`, so a post either reuses a snippet
   from `site/lib/landing-snippets.ts` or verifies its example against the source by hand, as the
   writing rules in `CLAUDE.md` already require.

The section needs no deployment change: it is static files under the existing origin, and the
feed is served with the XML type `deployment/site.conf` already declares.

## Consequences

The launch post is a link the maintainer owns. Every syndicated copy points home, so the reader who
arrives from a newsletter or a dev.to search in three months lands on `workhorse.run`, and the
search ranking the site lacks accrues to its own domain rather than to a host.

The maintainer sustains one more MDX collection and nothing else. Writing a post is writing one
file; publishing it is the site deploy the maintainer already runs.

A section with one post and no cadence can look abandoned. The index shows dates and promises
nothing. The content plan (WH-558) decides how many pieces the window produces; this decision only
gives them a home.

The section must exist before the launch post publishes. The calendar (WH-561) orders the execution
Issue ahead of the first post, and if the section slips, the post slips with it inside the window
rather than launching from a repository link.

The launch post has no length limit. The Show HN title and first comment are drafted separately
(WH-560) and link the post.
