import { createFileRoute } from "@tanstack/react-router";

import { CodeTabs } from "@/components/code-sample";
import { DashboardScreens, dashboardScreen } from "@/components/dashboard-screens";
import { FeatureNav } from "@/components/feature-nav";
import {
  FeatureList,
  GroupHead,
  PackageList,
  PackagesEntry,
  checkpointTabs,
  dashboardTabs,
  featureGroups,
  ormTabs,
} from "@/components/feature-tour";
import { MarketingPage, Section } from "@/components/frame";
import { FlowControlDiagram, RetriesDiagram } from "@/components/landing-diagrams";
import { LanguageLogoSprite } from "@/components/languages";
import { ButtonLink } from "@/components/primitives";
import { publisherReference, siteConfig } from "@/lib/site";

const title = `Features — ${siteConfig.name}`;
const description =
  "Every Workhorse feature, grouped: durable execution, retries, idempotency, schedules, flow control, operations, and integrations.";
const url = `${siteConfig.url}/features`;

export const Route = createFileRoute("/features")({
  head: () => ({
    meta: [
      { title },
      { name: "description", content: description },
      { property: "og:url", content: url },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { name: "twitter:title", content: title },
      { name: "twitter:description", content: description },
    ],
    links: [
      { rel: "canonical", href: url },
      // `scripts/gen-landing-twin.ts` derives the Markdown form from the built page.
      { rel: "alternate", type: "text/markdown", href: `${url}.md` },
    ],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "WebPage",
          name: title,
          description,
          url,
          publisher: publisherReference,
        }),
      },
    ],
  }),
  component: FeaturesPage,
});

const { durableExecution, failure, scheduling, operate, integrate } = featureGroups;
const navGroups = Object.values(featureGroups);

/** The screens an operator uses to control the queue and the fleet. */
const operatorScreens = [
  dashboardScreen("queues"),
  dashboardScreen("workers"),
  dashboardScreen("health"),
];

/**
 * The feature tour, grouped. The landing page shows five pillars and links
 * here. A hero and a sticky group nav come first. Each group then has its own
 * layout around one visual, so the page changes shape from group to group:
 *
 * 1. Durable execution: the features beside the checkpoint sample.
 * 2. Retries and failure: a centered head, the backoff diagram, and the
 *    features in three columns.
 * 3. Scheduling and flow control: the head beside the admission diagram, then
 *    one row per feature on the same column lines.
 * 4. Operate: a centered head, the operator screens of the dashboard with
 *    their captions, then the dashboard host sample beside the features.
 * 5. Integrate: the ORM sample beside the features, then every package.
 *
 * The layout classes (`wh-fsplit`, `wh-flist`, and the others) are in
 * `src/styles/marketing.css`.
 */
function FeaturesPage() {
  return (
    <MarketingPage>
      <LanguageLogoSprite />
      <div className="wh-features">
        <section className="wh-container flex flex-col items-center pt-20 text-center sm:pt-28">
          <h1 className="wh-display max-w-3xl text-balance font-semibold text-wh-fg">
            Durable tasks, from enqueue to redrive.
          </h1>
          <p className="mt-6 max-w-xl text-pretty text-ui-m text-wh-muted sm:text-[1.125rem] sm:leading-7">
            Each feature states one guarantee and links to the guide that explains it. PostgreSQL
            stores the tasks, schedules, limits, and attempt history.
          </p>
        </section>

        <FeatureNav groups={navGroups} />

        <Section id={durableExecution.id} className="wh-fgroup">
          <div className="wh-fsplit">
            <div className="wh-fsplit-head">
              <GroupHead group={durableExecution} align="start" />
            </div>
            <div className="wh-fsplit-visual">
              <CodeTabs name="Checkpoints" tabs={checkpointTabs} />
            </div>
            <FeatureList
              features={durableExecution.features}
              layout="stack"
              className="wh-fsplit-list"
            />
          </div>
        </Section>

        <Section id={failure.id} className="wh-fgroup">
          <GroupHead group={failure} align="center" />
          <div className="wh-fstage">
            <RetriesDiagram />
          </div>
          <FeatureList features={failure.features} layout="columns" className="mt-14 sm:mt-16" />
        </Section>

        <Section id={scheduling.id} className="wh-fgroup">
          <div className="wh-fcols items-center">
            <GroupHead group={scheduling} align="start" />
            <div className="min-w-0">
              <FlowControlDiagram />
            </div>
          </div>
          <FeatureList features={scheduling.features} layout="rows" className="mt-14 sm:mt-16" />
        </Section>

        <Section id={operate.id} className="wh-fgroup">
          <GroupHead group={operate} align="center" />
          <div className="mt-10 sm:mt-12">
            <DashboardScreens screens={operatorScreens} kind="tour" />
          </div>
          <div className="wh-fsplit mt-16 sm:mt-20" data-mirror>
            <div className="wh-fsplit-visual">
              <CodeTabs name="Dashboard host" tabs={dashboardTabs} />
            </div>
            <FeatureList features={operate.features} layout="stack" className="wh-fsplit-list" />
          </div>
        </Section>

        <Section id={integrate.id} className="wh-fgroup">
          <div className="wh-fsplit" data-mirror>
            <div className="wh-fsplit-head">
              <GroupHead group={integrate} align="start" />
            </div>
            <div className="wh-fsplit-visual">
              <CodeTabs name="ORM" tabs={ormTabs} meta="typescript" />
            </div>
            <FeatureList features={integrate.features} layout="stack" className="wh-fsplit-list">
              <PackagesEntry />
            </FeatureList>
          </div>
          <PackageList />
        </Section>

        <Section>
          <div className="wh-closing flex flex-col items-center px-5 py-16 text-center sm:py-20">
            <h2 className="wh-title text-balance font-semibold text-wh-fg">
              Start with one worker.
            </h2>
            <p className="mt-5 max-w-xl text-pretty text-ui-m text-wh-muted">
              Install the schema, enqueue a task inside a transaction, and inspect every transition
              in the dashboard.
            </p>
            <div className="mt-8 flex w-full flex-col items-stretch justify-center gap-3 sm:w-auto sm:flex-row sm:items-center">
              <ButtonLink href="/docs/quickstart" variant="primary">
                Build your first worker
              </ButtonLink>
              <ButtonLink href="/docs" variant="secondary">
                Read the docs
              </ButtonLink>
            </div>
          </div>
        </Section>
      </div>
    </MarketingPage>
  );
}
