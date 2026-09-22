import { mountedHref, readLocation, type PageRoute } from "./core.js";

export interface DashboardRouter {
  read(): ReturnType<typeof readLocation>;
  href(path: string): string;
  push(path: string): ReturnType<typeof readLocation>;
  replace(path: string): ReturnType<typeof readLocation>;
}

export interface DashboardRouterBrowser {
  readLocation: () => ReturnType<typeof readLocation>;
  pushState: (url: string) => void;
  replaceState: (url: string) => void;
}

/** Owns browser history writes so callers only compose the resulting location. */
export function createDashboardRouter(
  basePath: string,
  browser: DashboardRouterBrowser = {
    readLocation: () => readLocation(basePath),
    pushState: (url) => window.history.pushState(null, "", url),
    replaceState: (url) => window.history.replaceState(null, "", url),
  },
): DashboardRouter {
  const read = browser.readLocation;
  const href = (path: string) => mountedHref(basePath, path);
  return {
    read,
    href,
    push(path) {
      browser.pushState(href(path));
      return read();
    },
    replace(path) {
      browser.replaceState(href(path));
      return read();
    },
  };
}

export type DashboardRoute = PageRoute;
