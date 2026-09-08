import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ChangeEventHandler,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import { Accordion as AccordionPrimitive, Tooltip as TooltipPrimitive } from "radix-ui";
import { Check, CaretDown, CaretLeft, CaretRight, List, X } from "@phosphor-icons/react";
import { Button as ShadcnButton } from "./button.js";
import { Box, boxAttributes, color, length, type BoxProps } from "./layout.js";
import { cn } from "../lib/utils.js";

type ControlProps = BoxProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof BoxProps> & {
    size?: string | number;
    variant?: string;
    color?: string;
    leftSection?: ReactNode;
    rightSection?: ReactNode;
    loading?: boolean;
    fullWidth?: boolean;
    radius?: string;
    styles?: Record<string, CSSProperties>;
  };
export function Button({
  size = "sm",
  variant = "filled",
  color: tone,
  leftSection,
  rightSection,
  loading,
  fullWidth,
  radius: _radius,
  styles,
  component,
  children,
  disabled,
  ref,
  ...props
}: ControlProps) {
  const resolvedVariant =
    tone === "red"
      ? "destructive"
      : variant === "default" || variant === "outline"
        ? "outline"
        : variant === "light"
          ? "secondary"
          : variant === "subtle" || variant === "transparent"
            ? "ghost"
            : "default";
  const content = (
    <>
      {loading ? <Loader size={14} /> : leftSection}
      <span style={styles?.label}>{children}</span>
      {rightSection}
    </>
  );
  const attrs = boxAttributes(props);
  return (
    <ShadcnButton
      type="button"
      {...attrs}
      ref={ref as React.Ref<HTMLButtonElement>}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      variant={resolvedVariant}
      size={
        typeof size === "string" && size.startsWith("compact")
          ? "xs"
          : size === "xs"
            ? "sm"
            : size === "lg"
              ? "lg"
              : "default"
      }
      className={cn(fullWidth && "w-full", attrs.className)}
      asChild={component === "a"}
    >
      {component === "a" ? <a href={props.href}>{content}</a> : content}
    </ShadcnButton>
  );
}
export function ActionIcon({ size, children, ...props }: ControlProps) {
  return (
    <Button
      size={size}
      {...props}
      style={{
        width: typeof size === "number" ? size : size === "sm" ? 28 : 36,
        padding: 0,
        ...props.style,
      }}
    >
      {children}
    </Button>
  );
}
export function UnstyledButton({ component = "button", ...props }: ControlProps) {
  return <Box component={component} {...props} />;
}
export function Anchor(props: BoxProps & { size?: string }) {
  const { size: _size, ...rest } = props;
  return (
    <Box
      component="a"
      className="underline underline-offset-4 hover:text-muted-foreground"
      {...rest}
    />
  );
}
export function Badge({
  color: tone,
  variant: _variant,
  size: _size,
  radius: _radius,
  leftSection,
  rightSection,
  children,
  styles,
  ...props
}: BoxProps & {
  color?: string;
  variant?: string;
  size?: string;
  radius?: string;
  styles?: Record<string, CSSProperties>;
  leftSection?: ReactNode;
  rightSection?: ReactNode;
}) {
  return (
    <Box
      component="span"
      data-slot="badge"
      {...props}
      className={cn("ui-badge", props.className)}
      style={{ "--badge-color": color(tone), ...styles?.root, ...props.style } as CSSProperties}
    >
      {leftSection}
      {children}
      {rightSection}
    </Box>
  );
}
export function ThemeIcon({
  color: tone,
  variant: _variant,
  size = 28,
  radius: _radius,
  style,
  ...props
}: BoxProps & { color?: string; variant?: string; size?: string | number; radius?: string }) {
  return (
    <Box
      {...props}
      className="ui-theme-icon"
      style={{ color: color(tone), width: length(size), height: length(size), ...style }}
    />
  );
}
export function Loader({ size = 20, ...props }: { size?: string | number } & BoxProps) {
  return (
    <Box
      component="span"
      role="status"
      aria-label="Loading"
      className="ui-loader"
      {...props}
      style={{
        width: typeof size === "number" ? size : 20,
        height: typeof size === "number" ? size : 20,
        ...props.style,
      }}
    />
  );
}
export function CheckIcon({ size = 12 }: { size?: number }) {
  return <Check size={size} />;
}
export function Burger({ opened, size: _size, ...props }: ControlProps & { opened: boolean }) {
  return (
    <ActionIcon variant="subtle" {...props} aria-expanded={opened}>
      {opened ? <X size={20} /> : <List size={20} />}
    </ActionIcon>
  );
}
export function NavLink({
  active,
  label,
  leftSection,
  rightSection,
  variant: _variant,
  ...props
}: BoxProps & {
  active?: boolean;
  label: ReactNode;
  leftSection?: ReactNode;
  rightSection?: ReactNode;
  variant?: string;
}) {
  return (
    <Box
      component="a"
      {...props}
      aria-current={active ? "page" : undefined}
      data-active={active || undefined}
      className="ui-nav-link"
    >
      {leftSection}
      <span className="flex-1">{label}</span>
      {rightSection}
    </Box>
  );
}
export function Alert({
  title,
  icon,
  color: tone,
  variant: _variant,
  children,
  ...props
}: Omit<BoxProps, "title"> & {
  title?: ReactNode;
  icon?: ReactNode;
  color?: string;
  variant?: string;
}) {
  return (
    <Box
      role="alert"
      {...props}
      className="ui-alert"
      style={{ borderColor: color(tone), ...props.style }}
    >
      {icon}
      <div>
        {title ? <div className="mb-1 font-medium">{title}</div> : null}
        {children}
      </div>
    </Box>
  );
}
export function Tooltip({
  label,
  children,
  disabled,
  opened,
  position: _position,
  openDelay = 300,
  closeDelay: _closeDelay,
  events: _events,
  maw,
  withArrow: _withArrow,
  multiline: _multiline,
  w,
  width,
  withinPortal = true,
}: {
  label: ReactNode;
  children: ReactNode;
  disabled?: boolean;
  opened?: boolean;
  position?: string;
  withArrow?: boolean;
  multiline?: boolean;
  w?: number;
  width?: number;
  withinPortal?: boolean;
  maw?: number;
  openDelay?: number;
  closeDelay?: number;
  events?: { hover: boolean; focus: boolean; touch: boolean };
}) {
  if (disabled) return children;
  const content = (
    <TooltipPrimitive.Content
      className="ui-tooltip"
      sideOffset={6}
      style={{ maxWidth: w ?? width ?? maw ?? 360 }}
    >
      {label}
    </TooltipPrimitive.Content>
  );
  return (
    <TooltipPrimitive.Provider delayDuration={openDelay}>
      <TooltipPrimitive.Root open={opened}>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        {withinPortal ? <TooltipPrimitive.Portal>{content}</TooltipPrimitive.Portal> : content}
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
interface FieldProps {
  label?: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  leftSection?: ReactNode;
  rightSection?: ReactNode;
  size?: string;
}
type InputProps = Omit<BoxProps, "onChange"> &
  Omit<InputHTMLAttributes<HTMLInputElement>, keyof BoxProps | "size"> &
  FieldProps & { rightSectionWidth?: number; onChange?: ChangeEventHandler<HTMLInputElement> };
export function TextInput({
  label,
  description,
  error,
  leftSection,
  rightSection,
  size: _size,
  rightSectionWidth: _rightSectionWidth,
  ref,
  onKeyDown,
  onChange,
  value,
  defaultValue,
  type = "text",
  disabled,
  placeholder,
  id: given,
  ...props
}: InputProps) {
  const generated = useId();
  const id = given ?? generated;
  return (
    <Box {...boxAttributes(props)} className={cn("ui-field", props.className)}>
      {label ? <label htmlFor={id}>{label}</label> : null}
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      <div className="ui-input-wrap">
        {leftSection}
        <input
          {...Object.fromEntries(
            Object.entries(props).filter(
              ([k]) =>
                k.startsWith("aria-") ||
                ["min", "max", "step", "required", "name", "readOnly", "autoComplete"].includes(k),
            ),
          )}
          ref={ref as React.Ref<HTMLInputElement>}
          onKeyDown={onKeyDown}
          className="ui-input"
          id={id}
          type={type}
          disabled={disabled}
          placeholder={placeholder}
          value={value}
          defaultValue={defaultValue}
          onChange={onChange}
          aria-invalid={!!error || undefined}
        />
        {rightSection}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </Box>
  );
}
export function Textarea({
  label,
  description,
  error,
  size: _size,
  autosize: _autosize,
  minRows = 3,
  maxRows: _maxRows,
  style,
  ...props
}: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "size"> &
  FieldProps & { autosize?: boolean; minRows?: number; maxRows?: number }) {
  const generated = useId();
  const id = props.id ?? generated;
  return (
    <div className="ui-field" style={style}>
      {label ? <label htmlFor={id}>{label}</label> : null}
      {description ? <p>{description}</p> : null}
      <textarea
        {...props}
        id={id}
        className="ui-input min-h-20 py-2"
        rows={minRows}
        aria-invalid={!!error || undefined}
      />
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
export function Switch({
  size: _size,
  label,
  styles: _styles,
  onChange,
  checked,
  disabled,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & {
  size?: string;
  label?: ReactNode;
  styles?: Record<string, CSSProperties>;
}) {
  return (
    <label className="ui-switch-label">
      <input
        {...props}
        type="checkbox"
        role="switch"
        className="ui-switch"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
      />
      {label}
    </label>
  );
}
export function SegmentedControl({
  data,
  value,
  onChange,
  size: _size,
  ...props
}: Omit<BoxProps, "onChange"> & {
  data: readonly (string | { value: string; label: ReactNode })[];
  value: string;
  onChange: (value: string) => void;
  size?: string;
}) {
  return (
    <Box role="group" {...props} className={cn("ui-segmented", props.className)}>
      {data.map((item) => {
        const entry = typeof item === "string" ? { value: item, label: item } : item;
        return (
          <button
            key={entry.value}
            type="button"
            aria-pressed={value === entry.value}
            onClick={() => onChange(entry.value)}
          >
            {entry.label}
          </button>
        );
      })}
    </Box>
  );
}
export function Pagination({
  total,
  value,
  onChange,
  size: _size,
  withEdges: _withEdges,
  ...props
}: Omit<BoxProps, "onChange"> & {
  total: number;
  value: number;
  onChange: (value: number) => void;
  size?: string;
  withEdges?: boolean;
}) {
  const pages = [
    ...new Set([1, ...[value - 1, value, value + 1].filter((n) => n > 1 && n < total), total]),
  ].filter((n) => n > 0);
  return (
    <Box component="nav" aria-label="Pagination" {...props} className="flex items-center gap-1">
      <ActionIcon
        variant="default"
        aria-label="Previous page"
        disabled={value <= 1}
        onClick={() => onChange(value - 1)}
      >
        <CaretLeft />
      </ActionIcon>
      {pages.map((page, i) => (
        <span key={page} className="contents">
          {i > 0 && page > pages[i - 1]! + 1 ? <span className="px-2">…</span> : null}
          <Button
            variant={page === value ? "filled" : "subtle"}
            aria-current={page === value ? "page" : undefined}
            aria-label={`Page ${page}`}
            onClick={() => onChange(page)}
          >
            {page}
          </Button>
        </span>
      ))}
      <ActionIcon
        variant="default"
        aria-label="Next page"
        disabled={value >= total}
        onClick={() => onChange(value + 1)}
      >
        <CaretRight />
      </ActionIcon>
    </Box>
  );
}
function AccordionRoot({ children, variant: _variant }: { children: ReactNode; variant?: string }) {
  return (
    <AccordionPrimitive.Root type="single" collapsible className="ui-accordion">
      {children}
    </AccordionPrimitive.Root>
  );
}
export const Accordion = Object.assign(AccordionRoot, {
  Item: AccordionPrimitive.Item,
  Control: ({ children }: { children: ReactNode }) => (
    <AccordionPrimitive.Header>
      <AccordionPrimitive.Trigger className="ui-accordion-trigger">
        {children}
        <CaretDown size={16} />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  ),
  Panel: ({ children }: { children: ReactNode }) => (
    <AccordionPrimitive.Content forceMount className="ui-accordion-content">
      {children}
    </AccordionPrimitive.Content>
  ),
});
export function CopyButton({
  value,
  timeout = 2000,
  children,
}: {
  value: string;
  timeout?: number;
  children: (state: { copied: boolean; copy: () => void }) => ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return children({
    copied,
    copy: () => {
      void navigator.clipboard.writeText(value).then(() => {
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), timeout);
      });
    },
  });
}
interface StepProps extends BoxProps {
  label?: ReactNode;
  description?: ReactNode;
  loading?: boolean;
  allowStepSelect?: boolean;
  icon?: ReactNode;
}
function Step({ label, description, loading, allowStepSelect: _allow, icon, ...props }: StepProps) {
  return (
    <li {...boxAttributes(props)} className="ui-step">
      <span className="ui-step-icon">{loading ? <Loader size={16} /> : icon}</span>
      <div className="ui-step-body">
        <div className="font-medium">{label}</div>
        <div className="text-sm text-muted-foreground">{description}</div>
      </div>
    </li>
  );
}
function Completed({ children }: { children: ReactNode }) {
  return <li className="ui-step-completed">{children}</li>;
}
function StepperRoot({
  active,
  children,
  completedIcon,
  progressIcon,
}: {
  active: number;
  children: ReactNode;
  orientation?: string;
  size?: string;
  color?: string;
  iconSize?: number;
  allowNextStepsSelect?: boolean;
  completedIcon?: ReactNode;
  progressIcon?: ReactNode;
}) {
  const steps = Children.toArray(children).filter(isValidElement);
  return (
    <ol className="ui-stepper">
      {steps.map((child, index) =>
        child.type === Completed
          ? active >= steps.length - 1
            ? child
            : null
          : cloneElement(child as ReactElement<StepProps>, {
              icon: index < active ? completedIcon : index === active ? progressIcon : index + 1,
            }),
      )}
    </ol>
  );
}
export const Stepper = Object.assign(StepperRoot, { Step, Completed });
