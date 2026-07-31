if (import.meta.env.DEV) {
  import("react-grab");
}

// oxlint-disable-next-line import/no-unassigned-import -- Mantine exposes its component styles as CSS.
import "@mantine/core/styles.css";
// oxlint-disable-next-line import/no-unassigned-import -- Mantine chart styles ship separately.
import "@mantine/charts/styles.css";
// oxlint-disable-next-line import/no-unassigned-import -- Dashboard brand and theme styles.
import "./styles.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Dashboard } from "./dashboard";
import { WorkhorseThemeProvider } from "./theme";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WorkhorseThemeProvider>
      <Dashboard />
    </WorkhorseThemeProvider>
  </StrictMode>,
);
