# Verification and troubleshooting

Follow the receiving app’s verification policy and check behavior affected by the change. Type checking establishes compile compatibility; interaction tests check specific behavior; visual review assesses appearance and interaction feel. Report these separately. Small styling edits do not require a full application test suite.

Assess the result at its consumers. For simplification, confirm the affected roles retain their values, dependencies, and relevant responsive/mode/state behavior with fewer duplicate definitions or unnecessary overrides. For conversion, compare the actual scoped typography, controls, surfaces, and states with the agreed assignments and exceptions. Include independently styled headings, navigation, repeated containers, and popups where relevant; a changed token with no effective consumers is not evidence of completion.

| Symptom | First checks |
| --- | --- |
| Theme is missing | Confirm the app defines and loads the referenced tokens in its active scope |
| Popup has a different font or theme | Inspect the portal container’s DOM variable scope and active mode |
| Theme edits do not reach components | Trace the winning declaration through inheritance, compiled utilities, variants, local overrides, and variable scopes; verify the changed definition has actual consumers |
| A style change affects many controls | Inspect the shared token or component rule and its consumers |
| Font looks different | Follow [Font and icon setup](assets.md): a licensed-font fallback requires confirmed unavailability or the user’s fallback choice, not merely an unanswered file request. Verify the configured family reaches each role and its files cover the authored weights/styles |
| Icons are missing or look different | Confirm the selected free pack or declared licensed-pack fallback is installed, its actual exports are mapped, and its supported style/weight is configured |
| Copy ends in an isolated word or awkward short line | Check the shared `text-wrap: pretty` default, concise copy, and suitable text width under [Foundations](foundations.md); review actual breaks at relevant widths when rendered review is permitted |
| Changes vanish on reload | Store the requested change in the app’s token definitions, not only temporary state |
| An API fails type checking | Compare with the receiving app’s installed declarations and actual wrapper props |
| Layout changes when adding borders | Use composed box shadows with native border width zero |

Check relevant modes, interaction states, keyboard behavior, labels, and form values when their wiring changes. Source inspection alone does not establish rendered contrast or visual fidelity.

For asset setup, verify configured URLs/files or loader imports, family aliases, face coverage, icon exports, and required license notices. Report blocked downloads and active licensed-asset fallbacks with the official destination and remaining setup steps from [Font and icon setup](assets.md). A read-only audit reports missing setup without installing it.
