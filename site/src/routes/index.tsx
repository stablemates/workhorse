import { createFileRoute } from "@tanstack/react-router";

import {
  DashboardScreens,
  ScreenshotImage,
  dashboardScreen,
  dashboardScreens,
  screenshotPreloadScript,
} from "@/components/dashboard-screens";
import { MarketingPage, Section, SectionHead } from "@/components/frame";
import { LanguageLogoSprite } from "@/components/languages";
import { Pillars } from "@/components/pillars";
import { ButtonLink, TextLink } from "@/components/primitives";
import { TypicalQueueDiagram, WorkhorseDiagram } from "@/components/queue-diagrams";
import { demoUrl, publisherReference, siteConfig } from "@/lib/site";

/*
 * The landing page tells one story on one calm canvas: the position and the
 * dashboard an operator gets, the architecture beside a typical task queue,
 * the pillars with their code and journals, the dashboard, and the call to
 * action. The page shell is in `components/frame.tsx`. The full feature tour
 * lives on `/features` (`src/routes/features.tsx`). Snippet sources live in
 * `lib/landing-snippets.ts`; verify every claim against the source before
 * writing it.
 */

/** The hero shows the Tasks screen, so the showcase lower on the page starts at Events. */
const heroScreen = dashboardScreen("tasks");
const showcaseScreens = dashboardScreens.filter((screen) => screen !== heroScreen);

export const Route = createFileRoute("/")({
  head: () => {
    const title = `${siteConfig.name}: ${siteConfig.tagline}`;

    return {
      meta: [
        { title },
        { name: "description", content: siteConfig.description },
        { property: "og:url", content: siteConfig.url },
        { property: "og:title", content: title },
        { property: "og:description", content: siteConfig.description },
        { name: "twitter:title", content: title },
        { name: "twitter:description", content: siteConfig.description },
      ],
      links: [
        { rel: "canonical", href: siteConfig.url },
        // The landing page is where an agent most often starts, and its HTML is
        // several times its own text. `scripts/gen-landing-twin.ts` derives
        // the Markdown form from the built page; this link is how an agent
        // finds it without reading the whole page to reach the footer.
        { rel: "alternate", type: "text/markdown", href: `${siteConfig.url}/index.md` },
      ],
      scripts: [
        screenshotPreloadScript(heroScreen),
        {
          type: "application/ld+json",
          children: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "SoftwareApplication",
            name: siteConfig.name,
            applicationCategory: "DeveloperApplication",
            operatingSystem: "Cross-platform",
            description: siteConfig.description,
            url: siteConfig.url,
            image: siteConfig.socialImage,
            codeRepository: siteConfig.github,
            license: "https://www.apache.org/licenses/LICENSE-2.0",
            sameAs: [
              siteConfig.github,
              siteConfig.npm,
              siteConfig.pypi,
              siteConfig.goModule,
              siteConfig.crates,
            ],
            publisher: publisherReference,
          }),
        },
      ],
    };
  },
  component: HomePage,
});

/**
 * The first view: the position in two lines, one sentence, two actions, and
 * the dashboard that shows what an operator gets. The capture shows its upper
 * part and fades into the page (`.wh-hero-shot` in `marketing.css`).
 */
function Hero() {
  return (
    <section className="wh-container flex flex-col items-center pt-14 sm:pt-20">
      <h1 className="wh-display max-w-4xl text-balance text-center font-semibold text-wh-fg">
        Harness the Postgres <span className="sm:block">you already run.</span>
      </h1>
      <p className="mt-6 max-w-xl text-pretty text-center text-ui-m text-wh-muted sm:text-[1.125rem] sm:leading-7">
        Durable tasks, retries, schedules, and fleet-wide limits, run by the database you already
        trust. Eight languages share one SQL protocol, and there is no broker to deploy.
      </p>
      <div className="mt-8 flex w-full flex-col items-stretch justify-center gap-3 sm:w-auto sm:flex-row sm:items-center">
        <ButtonLink href="/docs/quickstart" variant="primary">
          Build your first worker
        </ButtonLink>
        <ButtonLink href="/docs" variant="secondary">
          Read the docs
        </ButtonLink>
      </div>
      <figure className="wh-hero-shot mt-14 w-full sm:mt-16">
        <div className="wh-shot">
          <ScreenshotImage screen={heroScreen} priority />
        </div>
      </figure>
    </section>
  );
}

/** One line under a diagram: a short claim, then the sentence that supports it. */
interface Claim {
  keyword: string;
  text: string;
}

/** Three short lines under a diagram. On the Workhorse side, the keywords take the amber ink. */
function ClaimList({ claims, accent = false }: { claims: readonly Claim[]; accent?: boolean }) {
  return (
    <ul className="mt-10 flex flex-col gap-4 text-ui-s text-wh-muted">
      {claims.map((claim) => (
        <li key={claim.keyword} className="text-pretty">
          <span className={`font-medium ${accent ? "text-(--wh-amber-ink)" : "text-wh-fg"}`}>
            {claim.keyword}.
          </span>{" "}
          {claim.text}
        </li>
      ))}
    </ul>
  );
}

/** A typical task queue beside Workhorse, as two line diagrams on one grid. */
function Architecture() {
  return (
    <Section>
      <SectionHead
        title="Durable tasks. No second system."
        lede="A typical task queue adds a broker beside your database. Workhorse keeps the tasks in the database, so they commit with your data."
      />
      <div className="mt-16 grid grid-cols-[minmax(0,1fr)] gap-16 lg:grid-cols-2 lg:gap-0">
        <div className="lg:border-r lg:border-wh-line lg:pr-14">
          <div className="mx-auto max-w-md">
            <h3 className="mb-8 text-ui-s font-medium text-wh-muted">A typical task queue</h3>
            <TypicalQueueDiagram />
            <ClaimList
              claims={[
                {
                  keyword: "Two writes",
                  text: "The task and its data commit in two systems, so you add an outbox.",
                },
                {
                  keyword: "One more system",
                  text: "A broker is one more system to deploy, monitor, and back up.",
                },
                {
                  keyword: "Split results",
                  text: "Workers poll the broker and write results to a different store.",
                },
              ]}
            />
          </div>
        </div>
        <div className="lg:pl-14">
          <div className="mx-auto max-w-md">
            <h3 className="mb-8 text-ui-s font-medium text-wh-fg">Workhorse</h3>
            <WorkhorseDiagram />
            <ClaimList
              accent
              claims={[
                {
                  keyword: "Transactional",
                  text: "The task commits or rolls back with the rows of your transaction.",
                },
                {
                  keyword: "One system",
                  text: "PostgreSQL stores the tasks, schedules, limits, and attempt history.",
                },
                {
                  keyword: "Eight languages",
                  text: "TypeScript, Python, Go, Rust, Ruby, Java, Kotlin, and C# share one SQL protocol.",
                },
              ]}
            />
          </div>
        </div>
      </div>
    </Section>
  );
}

function PillarSection() {
  return (
    <Section>
      <SectionHead
        title="Durable building blocks, stored in PostgreSQL."
        lede="Pick a building block to see its code in each SDK, and the journal of one task that uses it."
        link={<TextLink href="/features">See all features</TextLink>}
      />
      <div className="mt-14">
        <Pillars />
      </div>
    </Section>
  );
}

function OperatorView() {
  return (
    <Section>
      <SectionHead
        title="See the queue before it becomes an incident."
        lede="The embeddable dashboard shows task activity, queue pressure, schedules, retries, and worker health from the same PostgreSQL protocol."
        link={
          <TextLink href={demoUrl} external>
            Open the live demo
          </TextLink>
        }
      />
      <div className="mt-12">
        <DashboardScreens screens={showcaseScreens} kind="showcase" />
      </div>
    </Section>
  );
}

function ClosingCall() {
  return (
    <Section className="pt-0 sm:pt-0">
      <div className="wh-closing flex flex-col items-center px-5 py-16 text-center sm:py-20">
        <h2 className="wh-title text-balance font-semibold text-wh-fg">
          Your database is already the queue.
        </h2>
        <p className="mt-5 max-w-xl text-pretty text-ui-m text-wh-muted">
          Install the schema, enqueue a task inside a transaction, and inspect every transition in
          the dashboard.
        </p>
        <div className="mt-8 flex w-full flex-col items-stretch justify-center gap-3 sm:w-auto sm:flex-row sm:items-center">
          <ButtonLink href="/docs/quickstart" variant="primary">
            Build your first worker
          </ButtonLink>
          <ButtonLink href={demoUrl} variant="secondary" external>
            Live demo
          </ButtonLink>
        </div>
      </div>
    </Section>
  );
}

function HomePage() {
  return (
    <MarketingPage>
      <LanguageLogoSprite />
      <Hero />
      <Architecture />
      <PillarSection />
      <OperatorView />
      <ClosingCall />
    </MarketingPage>
  );
}
