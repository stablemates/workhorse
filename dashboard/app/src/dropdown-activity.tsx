import {
  Menu as MantineMenu,
  MultiSelect as MantineMultiSelect,
  Select as MantineSelect,
  type MenuProps,
  type MultiSelectProps,
  type SelectProps,
} from "@mantine/core";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { dashboardRefreshBlockers, useRefreshBlocker } from "./refresh-blockers.js";

interface DropdownActivityContextValue {
  opened: boolean;
  setOpened: (id: string, opened: boolean, blocksRefresh: boolean) => void;
}

export interface DropdownActivityEntry {
  opened: boolean;
  blocksRefresh: boolean;
}

export function dropdownActivitySnapshot(entries: ReadonlyMap<string, DropdownActivityEntry>): {
  opened: boolean;
  refreshBlocked: boolean;
} {
  let opened = false;
  let refreshBlocked = false;
  for (const entry of entries.values()) {
    if (!entry.opened) continue;
    opened = true;
    if (entry.blocksRefresh) refreshBlocked = true;
  }
  return { opened, refreshBlocked };
}

const DropdownActivityContext = createContext<DropdownActivityContextValue | null>(null);

export function DropdownActivityProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<ReadonlyMap<string, DropdownActivityEntry>>(
    () => new Map(),
  );
  const snapshot = dropdownActivitySnapshot(entries);
  useRefreshBlocker(snapshot.refreshBlocked, dashboardRefreshBlockers.taskContextMenu);
  const setOpened = useCallback((id: string, opened: boolean, blocksRefresh: boolean) => {
    setEntries((current) => {
      const existing = current.get(id);
      if (existing?.opened === opened && existing?.blocksRefresh === blocksRefresh) {
        return current;
      }
      if (!opened && existing === undefined) return current;
      const next = new Map(current);
      if (opened) next.set(id, { opened, blocksRefresh });
      else next.delete(id);
      return next;
    });
  }, []);
  const value = useMemo(
    () => ({ opened: snapshot.opened, setOpened }),
    [snapshot.opened, setOpened],
  );

  return (
    <DropdownActivityContext.Provider value={value}>{children}</DropdownActivityContext.Provider>
  );
}

export function useDropdownActivity(): boolean {
  return useContext(DropdownActivityContext)?.opened ?? false;
}

function useTrackedDropdown(blocksRefresh = false): (opened: boolean) => void {
  const activity = useContext(DropdownActivityContext);
  const id = useId();
  const openedRef = useRef(false);
  const setOpened = activity?.setOpened;
  const track = useCallback(
    (opened: boolean) => {
      openedRef.current = opened;
      setOpened?.(id, opened, blocksRefresh);
    },
    [blocksRefresh, id, setOpened],
  );

  useEffect(
    () => () => {
      if (openedRef.current) setOpened?.(id, false, blocksRefresh);
    },
    [blocksRefresh, id, setOpened],
  );
  return track;
}

function useTrackedSelectDropdown(
  onDropdownOpen: (() => void) | undefined,
  onDropdownClose: (() => void) | undefined,
) {
  const track = useTrackedDropdown();
  const open = useCallback(() => {
    track(true);
    onDropdownOpen?.();
  }, [onDropdownOpen, track]);
  const close = useCallback(() => {
    track(false);
    onDropdownClose?.();
  }, [onDropdownClose, track]);
  return { onDropdownOpen: open, onDropdownClose: close };
}

function TrackedMenuRoot({
  blocksRefresh = false,
  onChange,
  ...props
}: MenuProps & { blocksRefresh?: boolean }) {
  const track = useTrackedDropdown(blocksRefresh);
  return (
    <MantineMenu
      {...props}
      onChange={(opened) => {
        track(opened);
        onChange?.(opened);
      }}
    />
  );
}

export const Menu = Object.assign(TrackedMenuRoot, MantineMenu);

export function Select({ onDropdownOpen, onDropdownClose, ...props }: SelectProps) {
  const tracking = useTrackedSelectDropdown(onDropdownOpen, onDropdownClose);
  return <MantineSelect {...props} {...tracking} />;
}

export function MultiSelect({ onDropdownOpen, onDropdownClose, ...props }: MultiSelectProps) {
  const tracking = useTrackedSelectDropdown(onDropdownOpen, onDropdownClose);
  return <MantineMultiSelect {...props} {...tracking} />;
}
