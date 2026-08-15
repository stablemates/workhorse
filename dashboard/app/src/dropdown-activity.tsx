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

interface DropdownActivityContextValue {
  opened: boolean;
  setOpened: (id: string, opened: boolean) => void;
}

const DropdownActivityContext = createContext<DropdownActivityContextValue | null>(null);

export function DropdownActivityProvider({ children }: { children: ReactNode }) {
  const [openedIds, setOpenedIds] = useState<ReadonlySet<string>>(() => new Set());
  const setOpened = useCallback((id: string, opened: boolean) => {
    setOpenedIds((current) => {
      if (current.has(id) === opened) return current;
      const next = new Set(current);
      if (opened) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const value = useMemo(() => ({ opened: openedIds.size > 0, setOpened }), [openedIds, setOpened]);

  return (
    <DropdownActivityContext.Provider value={value}>{children}</DropdownActivityContext.Provider>
  );
}

export function useDropdownActivity(): boolean {
  return useContext(DropdownActivityContext)?.opened ?? false;
}

function useTrackedDropdown(): (opened: boolean) => void {
  const activity = useContext(DropdownActivityContext);
  const id = useId();
  const openedRef = useRef(false);
  const setOpened = activity?.setOpened;
  const track = useCallback(
    (opened: boolean) => {
      openedRef.current = opened;
      setOpened?.(id, opened);
    },
    [id, setOpened],
  );

  useEffect(
    () => () => {
      if (openedRef.current) setOpened?.(id, false);
    },
    [id, setOpened],
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

function TrackedMenuRoot({ onChange, ...props }: MenuProps) {
  const track = useTrackedDropdown();
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
