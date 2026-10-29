import { Tabs } from "@/components/tabs";
import dashboardCaptures from "@/lib/dashboard-screenshots.json";

/*
 * The dashboard captures, in the light and dark schemes. The landing hero
 * shows the Tasks screen, the landing showcase shows the other screens, and
 * the Operate group of `/features` shows the operator screens with their
 * captions. `lib/dashboard-screenshots.json` lists the captures in the order
 * of the dashboard sidebar.
 */

type DashboardScreen = (typeof dashboardCaptures.screens)[number];

export const dashboardScreens: readonly DashboardScreen[] = dashboardCaptures.screens;

/** The capture with this name. The build fails if the list has no such screen. */
export function dashboardScreen(name: string): DashboardScreen {
  const screen = dashboardScreens.find((candidate) => candidate.name === name);
  if (screen === undefined) throw new Error(`dashboard-screenshots.json has no "${name}" screen`);
  return screen;
}

/**
 * One capture for each scheme. Only the capture of the current scheme shows
 * (`.wh-shot-image` in `marketing.css`). The captures are 2880 by 1800 pixels,
 * and the size attributes reserve their space before they load.
 *
 * Both images are lazy, because a lazy image that does not show never loads.
 * An eager image always loads, and React adds a preload for it, so the page
 * would load the capture of the other scheme too. A `priority` capture is the
 * largest paint of its page. It takes the high fetch priority, and the route
 * preloads it with `screenshotPreloadScript`.
 */
export function ScreenshotImage({
  screen,
  priority = false,
}: {
  screen: DashboardScreen;
  priority?: boolean;
}) {
  const common = {
    alt: screen.alt,
    width: 2880,
    height: 1800,
    loading: "lazy",
    fetchPriority: priority ? "high" : "auto",
    decoding: "async",
    className: "wh-shot-image",
  } as const;
  return (
    <>
      <img src={screen.light} {...common} data-scheme="light" />
      <img src={screen.dark} {...common} data-scheme="dark" />
    </>
  );
}

/**
 * A head script that preloads the capture of a `priority` screen, for the
 * `scripts` of a route head. The capture that shows follows the saved choice
 * under `blume-theme`, and the system scheme only when a reader saved no
 * choice. A `<link rel="preload">` with a `media` query can name only the
 * system scheme, and the browser fetches it before a script can remove it. So
 * this script reads the saved choice the way the theme script in the body
 * does, and adds one preload, for the capture that shows.
 */
export function screenshotPreloadScript(screen: DashboardScreen): { children: string } {
  return {
    children: `(function(){var s=null;try{s=localStorage.getItem("blume-theme")}catch(e){}var d=s==="dark"||(s!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);var l=document.createElement("link");l.rel="preload";l.as="image";l.setAttribute("fetchpriority","high");l.href=d?${JSON.stringify(screen.dark)}:${JSON.stringify(screen.light)};document.head.appendChild(l)})()`,
  };
}

/**
 * A tab for each screen, and the captures of every screen in one frame.
 *
 * Every panel stays in the page, stacked in one grid cell
 * (`.wh-screens-stack` in `marketing.css`), so the frame takes the height of
 * the tallest panel and does not move when a reader switches screens. A
 * hidden panel is transparent and inert, not invisible, because the browser
 * does not load a lazy image in an invisible element. In
 * the tour, every caption takes the height of the longest one, so each
 * capture starts at the same line. The
 * captures of the current scheme load together when the section comes near
 * the viewport. A switch then fetches nothing: the new panel fades in over
 * the old one, and the old one hides when the fade ends, so no frame is
 * blank.
 *
 * - `showcase`: the pill row of the landing page.
 * - `tour`: the segmented control of `/features`. A line above the frame says what
 *   an operator does on the screen, and the first capture is the largest paint
 *   of the page, so it loads at high priority. On a phone the frame scrolls
 *   sideways (`.wh-shot-pan`).
 */
export function DashboardScreens({
  screens,
  kind,
}: {
  screens: readonly DashboardScreen[];
  kind: "showcase" | "tour";
}) {
  const tour = kind === "tour";
  return (
    <Tabs.Root variant={tour ? "segmented" : "pill"} className="min-w-0">
      {() => (
        <>
          <div className="wh-scroll-x -mx-4 flex justify-start px-4 py-1 sm:mx-0 sm:justify-center sm:px-0">
            <Tabs.List aria-label="Dashboard screens" className="w-max">
              {screens.map((screen, index) => (
                <Tabs.Tab key={screen.name} value={index}>
                  {screen.label}
                </Tabs.Tab>
              ))}
            </Tabs.List>
          </div>
          <div
            className={
              tour ? "wh-screens-stack wh-screens-captioned mt-5" : "wh-screens-stack mt-6"
            }
          >
            {screens.map((screen, index) => (
              <Tabs.Panel
                key={screen.name}
                value={index}
                keepMounted
                // A panel that is not selected stays rendered, so its capture
                // loads. Base UI makes it inert, which keeps it out of the
                // focus order and the accessibility tree.
                hidden={false}
              >
                {tour ? (
                  <p className="mx-auto mb-6 max-w-2xl self-end text-pretty text-center text-ui-m text-wh-muted">
                    {screen.caption}
                  </p>
                ) : null}
                <div className={tour ? "wh-shot wh-shot-pan" : "wh-shot"}>
                  <ScreenshotImage screen={screen} priority={tour && index === 0} />
                </div>
              </Tabs.Panel>
            ))}
          </div>
        </>
      )}
    </Tabs.Root>
  );
}
