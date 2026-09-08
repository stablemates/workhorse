import {
  createContext,
  useContext,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Dialog, DropdownMenu, Popover as PopoverPrimitive } from "radix-ui";
import { Check, CaretDown, X } from "@phosphor-icons/react";
import { Box, boxAttributes, type BoxProps } from "./layout.js";
import { ActionIcon } from "./controls.js";
import { cn } from "../lib/utils.js";

export interface MenuProps {
  children?: ReactNode;
  opened?: boolean;
  defaultOpened?: boolean;
  onChange?: (opened: boolean) => void;
  position?: string;
  withinPortal?: boolean;
  keepMounted?: boolean;
  shadow?: string;
  closeOnItemClick?: boolean;
  trigger?: string;
  transitionProps?: { duration?: number };
  width?: number;
}
const MenuContext = createContext({
  portal: true,
  position: "bottom-start",
  keepMounted: false,
  width: undefined as number | undefined,
});
function MenuRoot({
  children,
  opened,
  defaultOpened,
  onChange,
  position = "bottom-start",
  withinPortal = true,
  keepMounted = false,
  width,
}: MenuProps) {
  return (
    <MenuContext.Provider value={{ portal: withinPortal, position, keepMounted, width }}>
      <DropdownMenu.Root
        open={opened}
        defaultOpen={defaultOpened}
        onOpenChange={onChange}
        modal={false}
      >
        {children}
      </DropdownMenu.Root>
    </MenuContext.Provider>
  );
}
function MenuDropdown({
  children,
  style,
  onClick,
}: {
  children: ReactNode;
  style?: CSSProperties;
  onClick?: BoxProps["onClick"];
}) {
  const context = useContext(MenuContext);
  const content = (
    <DropdownMenu.Content
      forceMount={context.keepMounted ? true : undefined}
      className="ui-menu"
      align={context.position.endsWith("end") ? "end" : "start"}
      sideOffset={6}
      onClick={onClick}
      style={{ minWidth: context.width, ...style }}
    >
      {children}
    </DropdownMenu.Content>
  );
  return context.portal ? <DropdownMenu.Portal>{content}</DropdownMenu.Portal> : content;
}
function MenuItem({
  component,
  href,
  children,
  leftSection,
  rightSection,
  disabled,
  color: _color,
  onClick,
  ...props
}: BoxProps & {
  disabled?: boolean;
  leftSection?: ReactNode;
  rightSection?: ReactNode;
  color?: string;
  type?: "button" | "submit";
}) {
  return (
    <DropdownMenu.Item
      {...boxAttributes(props)}
      className="ui-menu-item"
      disabled={disabled}
      onSelect={undefined}
      asChild={component === "a" || component === "button"}
      onClick={onClick}
    >
      {component === "a" ? (
        <a href={href}>
          {leftSection}
          <span className="flex-1">{children}</span>
          {rightSection}
        </a>
      ) : component === "button" ? (
        <button type={props.type ?? "button"}>
          {leftSection}
          <span className="flex-1">{children}</span>
          {rightSection}
        </button>
      ) : (
        <>
          {leftSection}
          <span className="flex-1">{children}</span>
          {rightSection}
        </>
      )}
    </DropdownMenu.Item>
  );
}
export const Menu = Object.assign(MenuRoot, {
  Target: ({ children }: { children: ReactNode }) => (
    <DropdownMenu.Trigger asChild>{children}</DropdownMenu.Trigger>
  ),
  Dropdown: MenuDropdown,
  Item: MenuItem,
  Label: ({ children }: { children: ReactNode }) => (
    <DropdownMenu.Label className="ui-menu-label">{children}</DropdownMenu.Label>
  ),
  Divider: () => <DropdownMenu.Separator className="ui-menu-separator" />,
});
const PopoverContext = createContext({ portal: true, width: undefined as number | undefined });
function PopoverRoot({
  children,
  opened,
  onChange,
  width,
  disabled,
}: {
  children: ReactNode;
  opened?: boolean;
  onChange?: (value: boolean) => void;
  width?: number;
  disabled?: boolean;
  position?: string;
  withArrow?: boolean;
  shadow?: string;
}) {
  return (
    <PopoverContext.Provider value={{ portal: true, width }}>
      <PopoverPrimitive.Root open={disabled ? false : opened} onOpenChange={onChange}>
        {children}
      </PopoverPrimitive.Root>
    </PopoverContext.Provider>
  );
}
function PopoverDropdown({ children }: { children: ReactNode }) {
  const { width } = useContext(PopoverContext);
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content className="ui-popover" sideOffset={6} style={{ width }}>
        {children}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
}
export const Popover = Object.assign(PopoverRoot, {
  Target: ({ children }: { children: ReactNode }) => (
    <PopoverPrimitive.Trigger asChild>{children}</PopoverPrimitive.Trigger>
  ),
  Dropdown: PopoverDropdown,
});
interface PanelProps {
  id?: string;
  children: ReactNode;
  opened: boolean;
  onClose: () => void;
  title?: ReactNode;
  position?: string;
  size?: string | number;
  withOverlay?: boolean;
  lockScroll?: boolean;
  trapFocus?: boolean;
  closeOnClickOutside?: boolean;
  returnFocus?: boolean;
  closeOnEscape?: boolean;
  closeButtonProps?: { id?: string; "aria-label"?: string };
  classNames?: { content?: string };
  centered?: boolean;
}
function Panel({
  id,
  children,
  opened,
  onClose,
  title,
  size,
  withOverlay = true,
  trapFocus = true,
  closeOnClickOutside = true,
  returnFocus = true,
  closeOnEscape = true,
  closeButtonProps,
  classNames,
  drawer = false,
}: PanelProps & { drawer?: boolean }) {
  return (
    <Dialog.Root
      open={opened}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      modal={trapFocus}
    >
      <Dialog.Portal>
        {withOverlay ? <Dialog.Overlay className="ui-overlay" /> : null}
        <Dialog.Content
          id={id}
          className={cn(drawer ? "ui-sheet" : "ui-dialog", classNames?.content)}
          style={
            drawer
              ? { width: size === "xl" ? "min(48rem, 100vw)" : (size ?? "min(32rem, 100vw)") }
              : undefined
          }
          aria-describedby={undefined}
          onEscapeKeyDown={(event) => {
            if (!closeOnEscape) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (!closeOnClickOutside) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            if (!returnFocus) event.preventDefault();
          }}
        >
          <div className="ui-panel-header">
            <Dialog.Title asChild>
              <div>{title}</div>
            </Dialog.Title>
            <Dialog.Close asChild>
              <ActionIcon
                variant="subtle"
                {...closeButtonProps}
                aria-label={closeButtonProps?.["aria-label"] ?? "Close"}
              >
                <X size={18} />
              </ActionIcon>
            </Dialog.Close>
          </div>
          <div className="ui-panel-body">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function Drawer(props: PanelProps) {
  return <Panel {...props} drawer />;
}
export function Modal(props: PanelProps) {
  return <Panel {...props} />;
}

type Option = string | { value: string; label: string; disabled?: boolean };
interface SelectBaseProps extends Omit<BoxProps, "onChange" | "onSelect"> {
  data: readonly Option[];
  placeholder?: string;
  label?: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  disabled?: boolean;
  searchable?: boolean;
  clearable?: boolean;
  allowDeselect?: boolean;
  size?: string;
  rightSection?: ReactNode;
  nothingFoundMessage?: ReactNode;
  maxDropdownHeight?: number;
  onDropdownOpen?: () => void;
  onDropdownClose?: () => void;
  comboboxProps?: { withinPortal?: boolean };
}
export interface SelectProps extends SelectBaseProps {
  value?: string | null;
  onChange?: (value: string | null) => void;
}
export interface MultiSelectProps extends SelectBaseProps {
  value?: string[];
  onChange?: (value: string[]) => void;
}
function Choice({
  data,
  value,
  onSelect,
  placeholder,
  label,
  description,
  error,
  disabled,
  searchable,
  clearable,
  size: _size,
  rightSection,
  nothingFoundMessage,
  maxDropdownHeight = 280,
  onDropdownOpen,
  onDropdownClose,
  comboboxProps,
  multiple = false,
  allowDeselect = true,
  ...props
}: SelectBaseProps & { value: string[]; onSelect: (value: string[]) => void; multiple?: boolean }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const id = useId();
  const options = data.map((item) =>
    typeof item === "string" ? { value: item, label: item } : item,
  );
  const filtered = options.filter((item) => item.label.toLowerCase().includes(query.toLowerCase()));
  const setOpened = (next: boolean) => {
    setOpen(next);
    setQuery("");
    if (next) onDropdownOpen?.();
    else onDropdownClose?.();
  };
  const content = (
    <PopoverPrimitive.Content
      ref={contentRef}
      role="presentation"
      className="ui-combobox"
      align="start"
      sideOffset={4}
      onOpenAutoFocus={(event) => {
        if (!searchable) {
          event.preventDefault();
          contentRef.current
            ?.querySelector<HTMLButtonElement>('[role="option"]:not(:disabled)')
            ?.focus();
        }
      }}
    >
      {searchable ? (
        <input
          className="ui-combobox-search"
          aria-label={`Search ${typeof label === "string" ? label : (props["aria-label"] ?? placeholder ?? "options")}`}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              contentRef.current
                ?.querySelector<HTMLButtonElement>('[role="option"]:not(:disabled)')
                ?.focus();
            }
          }}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search…"
        />
      ) : null}
      <div
        id={`${id}-options`}
        role="listbox"
        aria-label={props["aria-label"] ?? (typeof label === "string" ? label : placeholder)}
        aria-multiselectable={multiple || undefined}
        style={{ maxHeight: maxDropdownHeight, overflowY: "auto" }}
        onKeyDown={(event) => {
          const buttons = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
          );
          const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            buttons[
              (current + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length
            ]?.focus();
          }
        }}
      >
        {filtered.length ? (
          filtered.map((option) => (
            <button
              type="button"
              role="option"
              aria-selected={value.includes(option.value)}
              disabled={option.disabled}
              key={option.value}
              className="ui-combobox-option"
              onClick={() => {
                onSelect(
                  multiple
                    ? value.includes(option.value)
                      ? value.filter((item) => item !== option.value)
                      : [...value, option.value]
                    : allowDeselect && value.includes(option.value)
                      ? []
                      : [option.value],
                );
                if (!multiple) setOpened(false);
              }}
            >
              <span className="flex-1">{option.label}</span>
              {value.includes(option.value) ? <Check size={14} /> : null}
            </button>
          ))
        ) : (
          <p className="p-3 text-sm text-muted-foreground">
            {nothingFoundMessage ?? "No results found"}
          </p>
        )}
      </div>
    </PopoverPrimitive.Content>
  );
  return (
    <Box {...props} className="ui-field">
      {label ? <label htmlFor={id}>{label}</label> : null}
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      <PopoverPrimitive.Root open={open} onOpenChange={setOpened}>
        <div className="ui-select-wrap">
          <PopoverPrimitive.Trigger asChild>
            <button
              id={id}
              type="button"
              role="combobox"
              aria-haspopup="listbox"
              aria-controls={`${id}-options`}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  setOpened(true);
                }
              }}
              aria-expanded={open}
              aria-label={props["aria-label"]}
              disabled={disabled}
              className="ui-select-trigger"
            >
              <span
                className={cn(
                  "truncate flex-1 text-left",
                  !value.length && "text-muted-foreground",
                )}
              >
                {value.length
                  ? value
                      .map((item) => options.find((option) => option.value === item)?.label ?? item)
                      .join(", ")
                  : placeholder}
              </span>
              {rightSection ?? <CaretDown size={14} />}
            </button>
          </PopoverPrimitive.Trigger>
          {clearable && value.length ? (
            <button
              type="button"
              className="ui-select-clear"
              aria-label={`Clear ${props["aria-label"] ?? placeholder ?? "selection"}`}
              disabled={disabled}
              onClick={() => onSelect([])}
            >
              <X size={12} />
            </button>
          ) : null}
        </div>
        {comboboxProps?.withinPortal === false ? (
          content
        ) : (
          <PopoverPrimitive.Portal>{content}</PopoverPrimitive.Portal>
        )}
      </PopoverPrimitive.Root>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </Box>
  );
}
export function Select({ value, onChange, ...props }: SelectProps) {
  return (
    <Choice
      {...props}
      value={value ? [value] : []}
      onSelect={(values) => onChange?.(values[0] ?? null)}
    />
  );
}
export function MultiSelect({ value = [], onChange, ...props }: MultiSelectProps) {
  return <Choice {...props} multiple value={value} onSelect={(values) => onChange?.(values)} />;
}
