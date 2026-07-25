// oxlint-disable-next-line import/no-unassigned-import -- Mantine exposes its component styles as CSS.
import "@mantine/core/styles.css";

import { MantineProvider } from "@mantine/core";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Dashboard } from "./dashboard";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MantineProvider defaultColorScheme="auto">
      <Dashboard />
    </MantineProvider>
  </StrictMode>,
);
