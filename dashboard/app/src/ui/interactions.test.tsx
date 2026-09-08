// @vitest-environment happy-dom
import { useState } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button, Drawer, TextInput } from "./index.js";
import {
  DropdownActivityProvider,
  Menu,
  Select,
  useDropdownActivity,
} from "../dropdown-activity.js";
import { RefreshBlockerProvider } from "../refresh-blockers.js";

afterEach(cleanup);

describe("dashboard shadcn interactions", () => {
  it("searches and selects a filter by keyboard, then clears it", async () => {
    const user = userEvent.setup();
    const opened = vi.fn<() => void>();
    const closed = vi.fn<() => void>();
    function Filter() {
      const [value, setValue] = useState<string | null>(null);
      return (
        <Select
          aria-label="Queue"
          searchable
          clearable
          data={["billing", "mail"]}
          value={value}
          onChange={setValue}
          onDropdownOpen={opened}
          onDropdownClose={closed}
        />
      );
    }
    render(<Filter />);
    await user.click(screen.getByRole("combobox", { name: "Queue" }));
    await user.type(screen.getByRole("textbox", { name: "Search Queue" }), "mail");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(screen.getByRole("combobox", { name: "Queue" }).textContent).toBe("mail");
    expect(opened).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Clear Queue" }));
    expect(screen.getByRole("combobox", { name: "Queue" }).textContent).not.toContain("mail");
  });

  it("closes a nested menu before the modeless task panel and keeps the background usable", async () => {
    const user = userEvent.setup();
    const behind = vi.fn<() => void>();
    function Panel() {
      const [open, setOpen] = useState(true);
      const dropdownOpen = useDropdownActivity();
      return (
        <>
          <Button onClick={behind}>Background task</Button>
          <Drawer
            opened={open}
            onClose={() => setOpen(false)}
            title="Task details"
            withOverlay={false}
            trapFocus={false}
            closeOnClickOutside={false}
            closeOnEscape={!dropdownOpen}
          >
            <Menu>
              <Menu.Target>
                <Button>Task actions</Button>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item>Copy task id</Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Drawer>
        </>
      );
    }
    render(
      <RefreshBlockerProvider>
        <DropdownActivityProvider>
          <Panel />
        </DropdownActivityProvider>
      </RefreshBlockerProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Background task" }));
    expect(behind).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Task actions" }));
    expect(screen.getByRole("menuitem", { name: "Copy task id" })).toBeDefined();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menuitem")).toBeNull());
    expect(screen.getByRole("dialog", { name: "Task details" })).toBeDefined();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("forwards field changes and keyboard events to the actual input", async () => {
    const user = userEvent.setup();
    const submit = vi.fn<(value: string) => void>();
    function Field() {
      const [value, setValue] = useState("");
      return (
        <TextInput
          label="Signal"
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit(value);
          }}
        />
      );
    }
    render(<Field />);
    await user.type(screen.getByRole("textbox", { name: "Signal" }), "invoice-paid{Enter}");
    expect(submit).toHaveBeenCalledWith("invoice-paid");
  });
});
