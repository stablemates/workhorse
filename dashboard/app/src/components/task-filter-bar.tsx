/**
 * The task listing's filter bar: search, an `Add filter` menu, and one chip for each facet in use.
 *
 * Every control writes the same `TaskLocationState` keys the URL already carries, so a bookmark
 * from before this bar, a row action such as "Only this queue", and a chip all describe a filter
 * the same way. The bar adds no filter language and no state of its own beyond which editor is
 * open.
 */
import type { DashboardTaskFacets } from "@stablemates/workhorse-dashboard-server/wire";
import {
  Add01Icon,
  BriefcaseIcon,
  Cancel01Icon,
  ChartHistogramIcon,
  LeftToRightListDashIcon,
  Search01Icon,
  ServerStack01Icon,
  Tag01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { Box } from "@mantine/core";
import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useControlledPopupActivity } from "../dropdown-activity.js";
import type { TaskLocationState } from "../task-location.js";
import { Button, Combobox, Input, Menu, Select, Toggle } from "../ui.js";
import type { useTaskFacets } from "./task-list.js";

export type TaskFilterFacetId = "queue" | "worker" | "taskType" | "tags";

interface TaskFilterFacet {
  id: TaskFilterFacetId;
  /** The chip and menu label, such as `Queue` in `Queue: emails`. */
  label: string;
  /** The plural noun the editor uses in its search placeholder and its empty and error text. */
  plural: string;
  icon: IconSvgElement;
  /** The facet list from `taskFacets` that supplies the options. */
  options: keyof DashboardTaskFacets;
}

/** The facets `Add filter` offers, in menu and chip order. Each one is one URL key. */
export const taskFilterFacets: readonly TaskFilterFacet[] = [
  {
    id: "queue",
    label: "Queue",
    plural: "queues",
    icon: LeftToRightListDashIcon,
    options: "queues",
  },
  { id: "worker", label: "Worker", plural: "workers", icon: ServerStack01Icon, options: "workers" },
  {
    id: "taskType",
    label: "Task type",
    plural: "task types",
    icon: BriefcaseIcon,
    options: "taskTypes",
  },
  { id: "tags", label: "Tags", plural: "tags", icon: Tag01Icon, options: "tags" },
];

/** The parts of a task location that the filter bar reads and writes. */
export type TaskFilterSelection = Pick<
  TaskLocationState,
  "queue" | "worker" | "taskType" | "tags" | "search"
>;

/** The values one facet selects. Only `tags` can hold more than one. */
export function taskFilterValues(
  selection: TaskFilterSelection,
  facet: TaskFilterFacetId,
): readonly string[] {
  if (facet === "tags") return selection.tags;
  const value = selection[facet];
  return value === null ? [] : [value];
}

/**
 * The location update that sets one facet to these values.
 *
 * Tags stay a list, which the URL writes comma-separated. The other facets take the first value,
 * and no value removes the key, so removing a chip and clearing a value give the same URL.
 */
export function taskFilterUpdate(
  facet: TaskFilterFacetId,
  values: readonly string[],
): Partial<TaskLocationState> {
  switch (facet) {
    case "tags":
      return { tags: [...values] };
    case "queue":
      return { queue: values[0] ?? null };
    case "worker":
      return { worker: values[0] ?? null };
    case "taskType":
      return { taskType: values[0] ?? null };
    default: {
      const unhandled: never = facet;
      return unhandled;
    }
  }
}

/**
 * What "Clear filters" removes: the search and every facet.
 *
 * The status view, the sort, the page size, and the chart settings are how the operator reads
 * the list, not what narrows it, so they stay.
 */
export const clearedTaskFilters = {
  queue: null,
  worker: null,
  taskType: null,
  tags: [],
  search: null,
} satisfies Partial<TaskLocationState>;

export function hasTaskFilters(selection: TaskFilterSelection): boolean {
  return (
    selection.search !== null ||
    taskFilterFacets.some((facet) => taskFilterValues(selection, facet.id).length > 0)
  );
}

/** The facets in use, in menu order. A chip shows for each one. */
export function activeTaskFilters(
  selection: TaskFilterSelection,
): { facet: TaskFilterFacet; values: readonly string[] }[] {
  return taskFilterFacets
    .map((facet) => ({ facet, values: taskFilterValues(selection, facet.id) }))
    .filter(({ values }) => values.length > 0);
}

/** `Queue: emails`, or `Tags: billing +2` when the list does not fit on a chip. */
export function taskFilterChipText(facet: TaskFilterFacet, values: readonly string[]): string {
  const [first, ...rest] = values;
  if (first === undefined) return facet.label;
  return rest.length === 0
    ? `${facet.label}: ${first}`
    : `${facet.label}: ${first} +${rest.length}`;
}

/** The control of the bar that takes focus when a chip goes away. */
export type TaskFilterFocusTarget =
  | { kind: "chip"; facet: TaskFilterFacetId }
  | { kind: "addFilter" };

/**
 * Where focus goes when the operator removes a chip: the next chip, else the previous chip, else
 * `Add filter`, which takes the place of the last chip.
 */
export function taskFilterFocusAfterRemoval(
  chips: readonly TaskFilterFacetId[],
  removed: TaskFilterFacetId,
): TaskFilterFocusTarget {
  const index = chips.indexOf(removed);
  const neighbor = index === -1 ? undefined : (chips[index + 1] ?? chips[index - 1]);
  return neighbor === undefined ? { kind: "addFilter" } : { kind: "chip", facet: neighbor };
}

/**
 * Move focus to `target` before `removed` leaves the page.
 *
 * The browser puts focus on the body when the focused control unmounts, so a keyboard operator
 * loses their place. Focus moves only if it is in `removed`; a pointer click elsewhere keeps its
 * focus.
 */
export function keepFocusOnRemoval({
  removed,
  active,
  target,
}: {
  removed: Pick<Node, "contains">;
  active: Element | null;
  target: Pick<HTMLElement, "focus"> | null;
}): void {
  if (active !== null && target !== null && removed.contains(active)) target.focus();
}

type TaskFacets = ReturnType<typeof useTaskFacets>;

const controlHeight = 32;

/** The controls use the page's small text size, so the bar reads at the same size as the table. */
const controlText: CSSProperties = {
  fontSize: "var(--mantine-font-size-sm)",
  lineHeight: "20px",
};

const chipStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "stretch",
  height: controlHeight,
  maxWidth: "100%",
  borderRadius: 8,
  background: "var(--mantine-color-default-hover)",
};

const chipEditStyle: CSSProperties = {
  height: controlHeight,
  minWidth: 0,
  maxWidth: 280,
  paddingInline: 10,
  gap: 6,
  borderRadius: 8,
  background: "transparent",
  boxShadow: "none",
  fontVariantNumeric: "tabular-nums",
  ...controlText,
};

/** Mantine's popover layer, so an editor opened beside the task drawer shows above it. */
const popupLayer: CSSProperties = { zIndex: 300 };

const mutedText: CSSProperties = { color: "var(--mantine-color-dimmed)" };

const ellipsis: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

/**
 * The searchable list of values for one facet, shown when its chip opens.
 *
 * The values load on first open. While they load, or when the request fails, the editor says so
 * and offers a retry, and the values already selected stay listed because `useTaskFacets` puts
 * them in the options even when the facet list does not contain them.
 */
export function TaskFilterEditor({
  facet,
  taskFacets,
}: {
  facet: TaskFilterFacet;
  taskFacets: TaskFacets;
}) {
  return (
    <>
      <Combobox.Field style={{ marginBottom: 4 }}>
        <Combobox.Input
          placeholder={`Search ${facet.plural}`}
          aria-label={`Search ${facet.plural}`}
        />
      </Combobox.Field>
      {taskFacets.loading ? (
        <div role="status" style={{ ...mutedText, padding: "6px 8px", fontSize: 13 }}>
          Loading {facet.plural}…
        </div>
      ) : taskFacets.error ? (
        <div role="alert" style={{ display: "grid", gap: 6, padding: "6px 8px", fontSize: 13 }}>
          <span>Workhorse could not load the {facet.plural}.</span>
          <Button
            variant="secondary"
            style={{ justifySelf: "start", height: 28 }}
            onClick={taskFacets.load}
          >
            Retry
          </Button>
        </div>
      ) : (
        <Combobox.Empty>No {facet.plural} found</Combobox.Empty>
      )}
      <Combobox.List>
        {(item: string) => (
          <Combobox.Item key={item} value={item}>
            <span style={ellipsis} title={item}>
              {item}
            </span>
            <Combobox.ItemIndicator />
          </Combobox.Item>
        )}
      </Combobox.List>
    </>
  );
}

/**
 * One filter chip. The label opens the editor and the cross removes the facet; they are two
 * buttons, so each has its own name and its own focus stop.
 */
function TaskFilterChip({
  facet,
  values,
  taskFacets,
  open,
  onOpenChange,
  onChange,
  onRemove,
  triggerRef,
}: {
  facet: TaskFilterFacet;
  values: readonly string[];
  taskFacets: TaskFacets;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (values: readonly string[]) => void;
  /** Remove the facet. `chip` is the chip element, which leaves the page. */
  onRemove: (chip: HTMLElement) => void;
  triggerRef: (element: HTMLButtonElement | null) => void;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  // An open editor owns Escape ahead of the task drawer, as every other dropdown does.
  useControlledPopupActivity(open);
  const options = taskFacets.facets[facet.options];
  const changeOpen = (next: boolean) => {
    if (next) taskFacets.load();
    onOpenChange(next);
  };
  const valueText = values.length === 0 ? null : values.join(", ");
  const trigger = (
    <Combobox.Trigger
      ref={triggerRef}
      render={<Button variant="ghost" />}
      style={chipEditStyle}
      aria-label={
        valueText === null
          ? `Choose ${facet.label.toLowerCase()} filter`
          : `Edit ${facet.label.toLowerCase()} filter: ${valueText}`
      }
      title={valueText ?? undefined}
    >
      <HugeiconsIcon icon={facet.icon} size={14} style={mutedText} aria-hidden />
      <span style={mutedText}>{facet.label}:</span>
      <span style={ellipsis}>{values[0] ?? <span style={mutedText}>choose…</span>}</span>
      {values.length > 1 ? <span style={mutedText}>+{values.length - 1}</span> : null}
    </Combobox.Trigger>
  );
  const popup = (
    <Combobox.Portal>
      <Combobox.Positioner anchor={anchor} align="start" style={popupLayer}>
        <Combobox.Popup
          aria-label={`Filter tasks by ${facet.label.toLowerCase()}`}
          style={{ ...controlText, width: 280, padding: 6 }}
        >
          <TaskFilterEditor facet={facet} taskFacets={taskFacets} />
        </Combobox.Popup>
      </Combobox.Positioner>
    </Combobox.Portal>
  );
  return (
    <div ref={anchor} role="group" aria-label={`${facet.label} filter`} style={chipStyle}>
      {facet.id === "tags" ? (
        <Combobox.Root<string, true>
          multiple
          items={options}
          value={[...values]}
          onValueChange={(next) => onChange(next)}
          open={open}
          onOpenChange={changeOpen}
          // Picking several tags from one search keeps the typed text.
          onInputValueChange={(_value, details) => {
            if (details.isItemPress) details.cancel();
          }}
        >
          {trigger}
          {popup}
        </Combobox.Root>
      ) : (
        <Combobox.Root<string>
          items={options}
          value={values[0] ?? null}
          onValueChange={(next) => onChange(next === null ? [] : [next])}
          open={open}
          onOpenChange={changeOpen}
        >
          {trigger}
          {popup}
        </Combobox.Root>
      )}
      {values.length > 0 ? (
        <Button
          variant="ghost"
          aria-label={`Remove ${facet.label.toLowerCase()} filter`}
          title={`Remove ${facet.label.toLowerCase()} filter`}
          onClick={() => {
            if (anchor.current !== null) onRemove(anchor.current);
          }}
          style={{
            width: 28,
            height: controlHeight,
            padding: 0,
            borderRadius: 8,
            background: "transparent",
            boxShadow: "none",
          }}
        >
          <HugeiconsIcon icon={Cancel01Icon} size={14} aria-hidden />
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Search, `Add filter`, the chips in use, and "Clear filters".
 *
 * A facet the operator picks from the menu appears as an empty chip with its editor open. If the
 * editor closes without a value, the empty chip goes away again, so a chip on screen always
 * matches a key in the URL.
 */
export function TaskFilterBar({
  selection,
  searchInput,
  setSearchInput,
  taskFacets,
  updateLocation,
  onClearFilters,
}: {
  selection: TaskFilterSelection;
  searchInput: string;
  setSearchInput: (value: string) => void;
  taskFacets: TaskFacets;
  updateLocation: (updates: Partial<TaskLocationState>) => void;
  onClearFilters: () => void;
}) {
  const [editing, setEditing] = useState<TaskFilterFacetId | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // The menu returns focus to its trigger as it closes, so the chosen editor opens after that.
  const chosen = useRef<TaskFilterFacetId | null>(null);
  // The controls that take focus when a chip or Clear filters leaves the page.
  const searchField = useRef<HTMLInputElement>(null);
  const addFilter = useRef<HTMLButtonElement>(null);
  const chipTriggers = useRef(new Map<TaskFilterFacetId, HTMLButtonElement>());
  useControlledPopupActivity(menuOpen);
  const active = activeTaskFilters(selection);
  const chips = taskFilterFacets
    .map((facet) => ({ facet, values: taskFilterValues(selection, facet.id) }))
    .filter(({ facet, values }) => values.length > 0 || editing === facet.id);
  return (
    <div
      role="search"
      aria-label="Filter tasks"
      style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, minWidth: 0 }}
    >
      {/* The search fills a narrow screen and keeps to a short field beside the chips elsewhere. */}
      <Box
        maw={{ base: "100%", sm: 320 }}
        style={{ position: "relative", flex: "1 1 240px", minWidth: 180 }}
      >
        <HugeiconsIcon
          icon={Search01Icon}
          size={14}
          aria-hidden
          style={{
            ...mutedText,
            position: "absolute",
            insetInlineStart: 10,
            top: "50%",
            transform: "translateY(-50%)",
            pointerEvents: "none",
          }}
        />
        <Input
          type="search"
          value={searchInput}
          onChange={(event) => setSearchInput(event.currentTarget.value)}
          placeholder="Search tasks. Use * as a wildcard."
          ref={searchField}
          aria-label="Search tasks"
          style={{ ...controlText, height: controlHeight, paddingInlineStart: 30 }}
        />
      </Box>
      {chips.map(({ facet, values }) => (
        <TaskFilterChip
          key={facet.id}
          facet={facet}
          values={values}
          taskFacets={taskFacets}
          open={editing === facet.id}
          onOpenChange={(open) => setEditing(open ? facet.id : null)}
          onChange={(next) => updateLocation(taskFilterUpdate(facet.id, next))}
          onRemove={(chip) => {
            const target = taskFilterFocusAfterRemoval(
              chips.map((chipInUse) => chipInUse.facet.id),
              facet.id,
            );
            keepFocusOnRemoval({
              removed: chip,
              active: document.activeElement,
              target:
                target.kind === "chip"
                  ? (chipTriggers.current.get(target.facet) ?? null)
                  : addFilter.current,
            });
            updateLocation(taskFilterUpdate(facet.id, []));
          }}
          triggerRef={(element) => {
            if (element === null) chipTriggers.current.delete(facet.id);
            else chipTriggers.current.set(facet.id, element);
          }}
        />
      ))}
      <Menu.Root
        open={menuOpen}
        onOpenChange={(open) => {
          if (open) taskFacets.load();
          setMenuOpen(open);
        }}
        onOpenChangeComplete={(open) => {
          if (open || chosen.current === null) return;
          setEditing(chosen.current);
          chosen.current = null;
        }}
      >
        <Menu.Trigger
          ref={addFilter}
          render={<Button variant="ghost" />}
          style={{ ...controlText, height: controlHeight, gap: 6, paddingInline: 10 }}
        >
          <HugeiconsIcon icon={Add01Icon} size={14} aria-hidden />
          Add filter
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner align="start" sideOffset={4} style={popupLayer}>
            <Menu.Popup style={{ ...controlText, minWidth: 220 }}>
              {taskFilterFacets.map((facet) => {
                const values = taskFilterValues(selection, facet.id);
                return (
                  <Menu.Item
                    key={facet.id}
                    onClick={() => {
                      chosen.current = facet.id;
                    }}
                  >
                    <Menu.ItemContent icon={<HugeiconsIcon icon={facet.icon} size={16} />}>
                      <span style={{ display: "flex", gap: 12, justifyContent: "space-between" }}>
                        <span>{facet.label}</span>
                        {values.length > 0 ? (
                          <span style={{ ...mutedText, ...ellipsis, maxWidth: 120 }}>
                            {values.join(", ")}
                          </span>
                        ) : null}
                      </span>
                    </Menu.ItemContent>
                  </Menu.Item>
                );
              })}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {active.length > 0 || selection.search !== null ? (
        <Button
          variant="ghost"
          onClick={(event) => {
            // The button leaves the page with the filters, so focus moves to the search field.
            keepFocusOnRemoval({
              removed: event.currentTarget,
              active: document.activeElement,
              target: searchField.current,
            });
            setEditing(null);
            onClearFilters();
          }}
          style={{ ...controlText, height: controlHeight, paddingInline: 10, ...mutedText }}
        >
          Clear filters
        </Button>
      ) : null}
    </div>
  );
}

/** A compact select without a visible label, for the view controls. */
export function TaskViewSelect<Value extends string>({
  label,
  value,
  options,
  onChange,
  width,
}: {
  label: string;
  value: Value;
  options: readonly { value: Value; label: string }[];
  onChange: (value: Value) => void;
  width: number;
}) {
  const [open, setOpen] = useState(false);
  useControlledPopupActivity(open);
  return (
    <Select.Root<Value>
      items={[...options]}
      value={value}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
      open={open}
      onOpenChange={setOpen}
    >
      <Select.Trigger aria-label={label} style={{ ...controlText, width, height: controlHeight }}>
        <Select.Value />
        <Select.Icon />
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner style={popupLayer}>
          <Select.Popup style={controlText}>
            <Select.List>
              {options.map((option) => (
                <Select.Item key={option.value} value={option.value}>
                  <Select.ItemText>{option.label}</Select.ItemText>
                  <Select.ItemIndicator />
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

/** Whether the activity chart shows. The choice is a browser preference, not part of the URL. */
export function TaskChartToggle({
  visible,
  onChange,
}: {
  visible: boolean;
  onChange: (visible: boolean) => void;
}) {
  return (
    <Toggle
      pressed={visible}
      onPressedChange={onChange}
      aria-controls="task-activity-chart"
      aria-label="Show activity chart"
      title={visible ? "Hide the activity chart" : "Show the activity chart"}
      // The theme draws a toggle the same way in both states, so off reads as a quiet button.
      style={{
        ...controlText,
        height: controlHeight,
        gap: 6,
        paddingInline: 10,
        ...(visible ? {} : { ...mutedText, background: "transparent", boxShadow: "none" }),
      }}
    >
      <HugeiconsIcon icon={ChartHistogramIcon} size={14} aria-hidden />
      Chart
    </Toggle>
  );
}

/** The view controls group: how the selected tasks are presented, apart from what selects them. */
export function TaskViewControls({ children }: { children: ReactNode }) {
  return (
    <div
      role="group"
      aria-label="View options"
      style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}
    >
      {children}
    </div>
  );
}
