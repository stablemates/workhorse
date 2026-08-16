import {
  createContext,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
  type FocusEvent,
  type ReactNode,
} from "react";

export interface RefreshBlocker {
  description: string;
  priority: number;
}

export interface RefreshBlockerSnapshot {
  blocked: boolean;
  description: string | null;
}

export interface RefreshBlockerRegistry {
  getSnapshot(): RefreshBlockerSnapshot;
  isBlocked(): boolean;
  set(id: string, blocker: RefreshBlocker | null): void;
  subscribe(listener: () => void): () => void;
}

const unblockedSnapshot: RefreshBlockerSnapshot = { blocked: false, description: null };

export function createRefreshBlockerRegistry(): RefreshBlockerRegistry {
  const blockers = new Map<string, RefreshBlocker>();
  const listeners = new Set<() => void>();
  let snapshot = unblockedSnapshot;

  const updateSnapshot = () => {
    let primary: RefreshBlocker | null = null;
    for (const blocker of blockers.values()) {
      if (primary === null || blocker.priority > primary.priority) primary = blocker;
    }
    snapshot = primary ? { blocked: true, description: primary.description } : unblockedSnapshot;
  };

  return {
    getSnapshot: () => snapshot,
    isBlocked: () => snapshot.blocked,
    set(id, blocker) {
      const current = blockers.get(id) ?? null;
      if (
        current?.description === blocker?.description &&
        current?.priority === blocker?.priority
      ) {
        return;
      }
      if (blocker === null) blockers.delete(id);
      else blockers.set(id, blocker);
      updateSnapshot();
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const RefreshBlockerContext = createContext<RefreshBlockerRegistry | null>(null);

export function RefreshBlockerProvider({ children }: { children: ReactNode }) {
  const registry = useMemo(createRefreshBlockerRegistry, []);
  return (
    <RefreshBlockerContext.Provider value={registry}>{children}</RefreshBlockerContext.Provider>
  );
}

function useRefreshBlockerRegistry(): RefreshBlockerRegistry {
  const registry = useContext(RefreshBlockerContext);
  if (registry === null) throw new Error("Refresh blockers require RefreshBlockerProvider");
  return registry;
}

function useRefreshBlockerSlot(): (blocker: RefreshBlocker | null) => void {
  const registry = useRefreshBlockerRegistry();
  const id = useId();
  useLayoutEffect(() => () => registry.set(id, null), [id, registry]);
  return useMemo(
    () => (blocker: RefreshBlocker | null) => registry.set(id, blocker),
    [id, registry],
  );
}

export function useRefreshBlocker(active: boolean, blocker: RefreshBlocker): void {
  const setBlocker = useRefreshBlockerSlot();
  useLayoutEffect(() => {
    setBlocker(active ? blocker : null);
  }, [active, blocker, setBlocker]);
}

export function useRefreshBlockers(): RefreshBlockerSnapshot & {
  isBlocked: () => boolean;
} {
  const registry = useRefreshBlockerRegistry();
  const snapshot = useSyncExternalStore(
    registry.subscribe,
    registry.getSnapshot,
    registry.getSnapshot,
  );
  return {
    ...snapshot,
    isBlocked: registry.isBlocked,
  };
}

export const dashboardRefreshBlockers = {
  focusedInput: {
    description: "Auto refresh paused while a dashboard input is focused",
    priority: 0,
  },
  dirtySettings: {
    description: "Auto refresh paused while settings have unsaved changes",
    priority: 10,
  },
  dirtyHumanWait: {
    description: "Auto refresh paused while a human wait result is being composed",
    priority: 10,
  },
  taskDrawer: {
    description: "Auto refresh paused while task details are open",
    priority: 10,
  },
  dropdown: {
    description: "Auto refresh paused while a dropdown is open",
    priority: 20,
  },
} as const satisfies Record<string, RefreshBlocker>;

function isRefreshBlockingInput(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.matches('input:not([type="hidden"]), textarea, select, [contenteditable="true"]')
  );
}

export function useRefreshBlockingInputCapture(): {
  onFocusCapture: (event: FocusEvent<HTMLElement>) => void;
  onBlurCapture: (event: FocusEvent<HTMLElement>) => void;
} {
  const setBlocker = useRefreshBlockerSlot();
  return useMemo(
    () => ({
      onFocusCapture(event: FocusEvent<HTMLElement>) {
        setBlocker(
          isRefreshBlockingInput(event.target) ? dashboardRefreshBlockers.focusedInput : null,
        );
      },
      onBlurCapture(event: FocusEvent<HTMLElement>) {
        const nextTarget = event.relatedTarget;
        const remainsInsideDashboard =
          nextTarget instanceof Node && event.currentTarget.contains(nextTarget);
        setBlocker(
          remainsInsideDashboard && isRefreshBlockingInput(nextTarget)
            ? dashboardRefreshBlockers.focusedInput
            : null,
        );
      },
    }),
    [setBlocker],
  );
}
