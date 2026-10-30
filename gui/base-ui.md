# Base UI components

Use this guide when the receiving app uses Base UI. Keep existing shared wrappers and verify component APIs against the installed `@base-ui/react` declarations. The full-component download includes Graphical’s actual React implementations; integrate that source instead of reconstructing it from the theme reference. The default theme-and-skills download contains guidance and specifications only and adds no runtime dependencies.

## Apply the theme

Read the [component index](components.md) and the exact specification linked for the selected theme and component, also linked from the [theme reference](themes.md). Use its structure and behavior guidance alongside the named assignments and fully resolved styles for each part, variant, mode, and state. Preserve exported edits to geometry, typography, fill, foreground, edges, elevation, focus, and motion; do not replace them with a similar preset or documentation-demo styling. Keep named theme tokens at use sites and literal values at their owning definitions. Preserve the primitive’s supported state selectors and anatomy while adapting the implementation to installed APIs.

When full component setup is selected in `GUI.md`, integrate the supplied component modules, stylesheet, theme provider, and document, then expose imports; tokens or the primitive dependency alone do not complete setup. Keep source behavior and authored styling intact while adapting integration to the receiving framework. Reuse and update existing components where compatible. Install only missing `@base-ui/react`, `motion`, and `lucide-react` dependencies under the project’s package-manager and version policy; do not alter existing versions or lockfile choices to match the authoring repository. Acquire fonts and icons separately through [asset setup](assets.md). For an additional Base UI primitive without supplied source or specification, use existing foundations and report the coverage gap. Report integrated/reused/blocked coverage, usable imports, asset substitutions, and unresolved fidelity differences. Follow the host’s review policy and distinguish source verification from rendered comparison; do not claim exact visual equivalence without evidence.

## Integrate the supplied source

Check installed APIs, package ranges, overrides, and lockfile policy before running an install command. The current runtime uses React 19 context/provider and ref APIs and is verified against Base UI 1.7. These are compatibility baselines, not instructions to pin the authoring repository’s versions. For an existing React 18 app, explicitly adapt context providers and ref forwarding to its supported APIs while preserving behavior, or report the concrete blocker. Do not automatically upgrade React or Base UI to avoid the adaptation.

This section applies only when `components/graphical/` is included in the selected download. The public `components/graphical/index.ts` exports `GraphicalProvider`, the captured `theme`, the variant-aware `Button`, `Input`, and Base-UI-style component namespaces. `SelectField` and `ComboboxField` expose the preview’s composed controls. Use these exports directly, preserving their parts, callbacks, refs, and composition behavior instead of rebuilding them from the Markdown specifications.

Import `components/graphical/styles.css` once from the app’s supported stylesheet entry. The stylesheet includes the library styling and a scoped reset. Mount `GraphicalProvider` with `document={theme}` and `colorMode` connected to the application’s actual light/dark state. The document comes from `components/graphical/theme.ts` and retains the selected theme and component edits. Keep the mirrored component and shared runtime directories together; adapt import paths to the receiving app without dropping their dependencies or portal theme propagation.

After connecting the library, update existing screens within the authorized scope to use its components and named values. Configure selected fonts separately. For selected icon artwork, wrap the themed scope in the exported `IconRendererProvider` with a `renderIcon` callback. It receives `{ name, family, variant, weight, ...svgProps }`; return the corresponding icon from the supplied licensed files or installed selected free pack. Forward the SVG props, including `style`, to preserve sizing, accessibility, and weight variables. The renderer also reaches portalled components. Returning `undefined` uses the bundled fallback; an unconfigured non-Lucide or filled selection is marked with `data-icon-fallback`. Configure the selected free pack rather than silently leaving Lucide active, and use a paid selection’s free fallback only after the asset guide’s request/answer flow. No font binaries or icon artwork are bundled. Verify imports, stylesheet inclusion, provider coverage, mode changes, and affected component workflows according to the project’s review policy.

Compose patterns from these shared controls and application content. Keep selection, focus management, dismissal, and form behavior in the primitive. Preserve the app’s existing dependencies; a theme change does not require replacing its primitive library.

## Composition and behavior

Use the documented `render` API when composing Base UI with custom components. Spread supplied props and retain refs; compose handlers deliberately. Preserve accessible labels, descriptions, native form values, and controlled/uncontrolled behavior. Avoid nested interactive elements.

Read the [composition handbook](https://base-ui.com/react/handbook/composition) and the relevant component page in the [documentation index](https://base-ui.com/llms.txt). Documentation may describe a newer version, so installed declarations remain the compatibility check.

## Portals and motion

DOM variables do not cross a portal automatically. Keep the portalled surface within the active theme scope or apply the same mode variables at its portal container. Preserve the primitive’s positioning, sizing constraints, transform origin, and dismissal behavior.

Use the theme’s motion values and retain reduced motion. Follow the specific primitive’s mounting and exit rules when introducing React animation; do not add a competing unmount timer. See the [animation handbook](https://base-ui.com/react/handbook/animation) and [Foundations](foundations.md).
