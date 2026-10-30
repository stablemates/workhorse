import { Drawer, type DrawerProps } from "@mantine/core";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  clampTaskDrawerWidth,
  defaultTaskDrawerWidth,
  readTaskDrawerWidth,
  saveTaskDrawerWidth,
  taskDrawerWidthBounds,
} from "../task-view-preferences.js";

/**
 * Resize state lives here so dragging does not rerender the task's detail content.
 *
 * The parts compose the drawer so the separator sits in the header beside the title, not inside
 * it. Mantine names the dialog after its title element, so the name contains only the title.
 */
export function ResizableTaskDrawer({
  title,
  headerAside,
  size,
  withOverlay = true,
  overlayProps,
  withCloseButton = true,
  closeButtonProps,
  children,
  ...props
}: DrawerProps & {
  /**
   * Controls or hints between the title and the close button, such as task navigation. The slot
   * stays outside the title, so the dialog's name is still the title alone.
   */
  headerAside?: ReactNode;
}) {
  const [preferredWidth, setPreferredWidth] = useState(readTaskDrawerWidth);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const drag = useRef<{ x: number; width: number; preference: number } | null>(null);
  const latestWidth = useRef(preferredWidth);
  const fullWidth = size === "100%";
  const width = clampTaskDrawerWidth(preferredWidth, viewportWidth);
  const bounds = taskDrawerWidthBounds(viewportWidth);

  useEffect(() => {
    const resize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  const changeWidth = (next: number, persist: boolean) => {
    latestWidth.current = next;
    setPreferredWidth(next);
    if (persist) saveTaskDrawerWidth(next);
  };

  return (
    <Drawer.Root {...props} size={fullWidth ? "100%" : width}>
      {withOverlay ? <Drawer.Overlay {...overlayProps} /> : null}
      <Drawer.Content>
        <Drawer.Header>
          <Drawer.Title className="task-drawer__title">{title}</Drawer.Title>
          {!fullWidth && props.opened ? (
            <span
              className="task-drawer__resize-handle"
              role="separator"
              tabIndex={0}
              aria-label="Resize task details"
              aria-orientation="vertical"
              aria-valuemin={bounds.min}
              aria-valuemax={bounds.max}
              aria-valuenow={Math.round(width)}
              aria-valuetext={`${Math.round(width)} pixels wide`}
              title="Drag to resize. Use arrow keys to adjust; double-click to reset."
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.currentTarget.focus();
                event.currentTarget.setPointerCapture(event.pointerId);
                drag.current = { x: event.clientX, width, preference: preferredWidth };
                latestWidth.current = width;
              }}
              onPointerMove={(event) => {
                if (!drag.current) return;
                changeWidth(
                  clampTaskDrawerWidth(
                    drag.current.width + drag.current.x - event.clientX,
                    window.innerWidth,
                  ),
                  false,
                );
              }}
              onPointerUp={(event) => {
                if (!drag.current) return;
                drag.current = null;
                saveTaskDrawerWidth(latestWidth.current);
                event.currentTarget.releasePointerCapture(event.pointerId);
              }}
              onPointerCancel={() => {
                if (drag.current) changeWidth(drag.current.preference, false);
                drag.current = null;
              }}
              onDoubleClick={() => changeWidth(defaultTaskDrawerWidth, true)}
              onKeyDown={(event) => {
                const step = event.shiftKey ? 64 : 16;
                const next =
                  event.key === "ArrowLeft"
                    ? width + step
                    : event.key === "ArrowRight"
                      ? width - step
                      : event.key === "Home"
                        ? bounds.min
                        : event.key === "End"
                          ? bounds.max
                          : null;
                if (next === null) return;
                event.preventDefault();
                event.stopPropagation();
                changeWidth(clampTaskDrawerWidth(next, viewportWidth), true);
              }}
            />
          ) : null}
          {headerAside ? <div className="task-drawer__header-aside">{headerAside}</div> : null}
          {withCloseButton ? <Drawer.CloseButton {...closeButtonProps} /> : null}
        </Drawer.Header>
        <Drawer.Body>{children}</Drawer.Body>
      </Drawer.Content>
    </Drawer.Root>
  );
}
