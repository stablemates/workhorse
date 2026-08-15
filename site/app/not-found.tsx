import Link from "next/link";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import { baseOptions } from "@/app/layout.config";

export default function NotFound() {
  return (
    <HomeLayout {...baseOptions} className="flex-1">
      <div className="mx-auto flex w-full max-w-6xl flex-col px-5 py-24 lg:px-8">
        <p className="wh-mono-label">404 — no such identity</p>
        <h1 className="mt-4 max-w-2xl text-balance text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">
          That page has no row in this relation.
        </h1>
        <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-fd-muted-foreground">
          The URL may have moved with a docs restructure. Search covers the whole corpus, or start
          from one of these.
        </p>
        <div className="mt-8 flex flex-wrap gap-6">
          {[
            { href: "/", text: "Home" },
            { href: "/docs", text: "Documentation" },
            { href: "/reference", text: "API reference" },
            { href: "/examples", text: "Examples" },
          ].map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="wh-link-underline text-[14px] font-medium"
            >
              {link.text}
            </Link>
          ))}
        </div>
      </div>
    </HomeLayout>
  );
}
