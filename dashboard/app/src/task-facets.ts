import {
  dashboardTaskFacetNames,
  type DashboardTaskFacetName,
  type DashboardTaskFacets,
} from "@stablemates/workhorse-dashboard-server/wire";

/** The load state of the value list of one task filter. */
export interface TaskFacetState {
  /** The values that the server returned, or null before the first successful read. */
  values: readonly string[] | null;
  loading: boolean;
  error: string | null;
}

export type TaskFacetStates = Readonly<Record<DashboardTaskFacetName, TaskFacetState>>;

export const taskFacetLoadError =
  "Workhorse could not load this list. Reopen this menu to try again.";

export const initialTaskFacetStates: TaskFacetStates = Object.freeze(
  Object.fromEntries(
    dashboardTaskFacetNames.map((name) => [name, { values: null, loading: false, error: null }]),
  ) as Record<DashboardTaskFacetName, TaskFacetState>,
);

/**
 * Loads the value list of each task filter on its own.
 *
 * Each filter menu reads only its own list when it first opens, and a failed list does not empty
 * the others. A list that loaded is not read again. A list that failed is read again when its menu
 * opens again.
 *
 * A schema before version 106 ignores the facet and returns all four lists. The loader uses only
 * the list that it asked for, so it gives the same result on that schema.
 */
export function createTaskFacetLoader(
  read: (facet: DashboardTaskFacetName) => Promise<DashboardTaskFacets>,
  publish: (states: TaskFacetStates) => void,
) {
  let states = initialTaskFacetStates;
  let generation = 0;
  const pending = new Set<DashboardTaskFacetName>();
  const update = (facet: DashboardTaskFacetName, next: Partial<TaskFacetState>) => {
    states = { ...states, [facet]: { ...states[facet], ...next } };
    publish(states);
  };
  return {
    load(facet: DashboardTaskFacetName) {
      if (states[facet].values !== null || pending.has(facet)) return;
      const activeGeneration = generation;
      pending.add(facet);
      update(facet, { loading: true, error: null });
      read(facet).then(
        (facets) => {
          if (generation !== activeGeneration) return;
          pending.delete(facet);
          update(facet, { values: facets[facet], loading: false });
        },
        () => {
          if (generation !== activeGeneration) return;
          pending.delete(facet);
          update(facet, { loading: false, error: taskFacetLoadError });
        },
      );
    },
    /**
     * Ignore each answer still in flight. The component that owns the loader calls this when it
     * unmounts. A later `load` reads again, so a remount in development Strict Mode still loads.
     */
    detach() {
      generation += 1;
      pending.clear();
      for (const facet of dashboardTaskFacetNames) {
        if (states[facet].loading) update(facet, { loading: false });
      }
    },
  };
}
