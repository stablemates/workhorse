import { Tick02Icon, UnfoldMoreIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { DashboardWorkspaceLink } from "@stablemates/workhorse-dashboard-server/server";
import { usePopupActivity } from "../dropdown-activity.js";
import { Menu } from "../ui.js";
import { withoutPartSurface } from "./HeaderControls.js";

export interface WorkspaceSwitcherProps {
  /** Every workspace that the host serves, in the order the host lists them. */
  workspaces: readonly DashboardWorkspaceLink[];
  /** The name of the workspace that this document shows, or null in single-workspace mode. */
  workspace: string | null;
}

export interface WorkspaceMenuEntry {
  name: string;
  /** The full-document address of the workspace's task list. */
  href: string;
  /** The database host and name, when the host supplies them. */
  detail: string | null;
  current: boolean;
}

/**
 * The menu rows for each workspace.
 *
 * Each row links to the task list as a full document, because each workspace has its own runtime
 * configuration. Switching is a navigation, not a state change.
 */
export function workspaceMenuEntries({
  workspaces,
  workspace,
}: WorkspaceSwitcherProps): WorkspaceMenuEntry[] {
  return workspaces.map((entry) => ({
    name: entry.name,
    href: `${entry.url}/tasks`,
    detail: [entry.databaseHost, entry.databaseName].filter(Boolean).join(" · ") || null,
    current: entry.name === workspace,
  }));
}

/**
 * Switches between the workspaces of the host. It renders nothing with fewer than two.
 *
 * The trigger is a full-width control under the brand. It shows the current workspace name, and
 * its database on a second line when the host supplies it. The menu shows the database of each
 * workspace on a second line, and marks the current one as selected and unavailable.
 */
export function WorkspaceSwitcher({ workspaces, workspace }: WorkspaceSwitcherProps) {
  const trackPopup = usePopupActivity();
  if (workspaces.length < 2 || !workspace) return null;
  const entries = workspaceMenuEntries({ workspaces, workspace });
  const detail = entries.find((entry) => entry.current)?.detail ?? null;
  return (
    <Menu.Root onOpenChange={trackPopup}>
      <Menu.Trigger
        aria-label={`Workspace: ${workspace}`}
        title={detail === null ? workspace : `${workspace} (${detail})`}
        render={(props) => (
          <button {...withoutPartSurface(props)} type="button" className="workspace-switcher" />
        )}
      >
        <span className="workspace-switcher__tile" aria-hidden="true">
          {workspace.slice(0, 1).toUpperCase()}
        </span>
        <span className="workspace-switcher__text">
          <span className="workspace-switcher__name">{workspace}</span>
          {detail === null ? null : <span className="workspace-switcher__detail">{detail}</span>}
        </span>
        <HugeiconsIcon
          icon={UnfoldMoreIcon}
          size={14}
          strokeWidth={1.5}
          className="workspace-switcher__chevron"
          aria-hidden="true"
        />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="start" sideOffset={6}>
          <Menu.Popup className="workspace-switcher__popup">
            <Menu.Group>
              <Menu.GroupLabel>Workspaces</Menu.GroupLabel>
              {entries.map((entry) => (
                <Menu.Item
                  key={entry.name}
                  disabled={entry.current}
                  aria-current={entry.current ? "page" : undefined}
                  render={entry.current ? undefined : <a href={entry.href} />}
                >
                  <Menu.ItemContent
                    icon={
                      entry.current ? (
                        <HugeiconsIcon icon={Tick02Icon} size={14} aria-hidden="true" />
                      ) : null
                    }
                  >
                    <span className="workspace-switcher__entry">
                      <span className="workspace-switcher__entry-name">{entry.name}</span>
                      {entry.detail === null ? null : (
                        <span className="workspace-switcher__entry-detail">{entry.detail}</span>
                      )}
                    </span>
                  </Menu.ItemContent>
                </Menu.Item>
              ))}
            </Menu.Group>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
