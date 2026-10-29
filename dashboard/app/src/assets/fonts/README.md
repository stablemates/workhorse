# Theme font files

The Untitled theme uses Timeless Grotesk at weights 400, 500, and 600. The repository does not
include the files, because the download at https://timeless.co/type needs an email form. Until a
person adds them, the dashboard shows Geist, which `@fontsource-variable/geist` supplies.

To add the theme font:

1. Download Timeless Grotesk from https://timeless.co/type. Use the Grotesk cut.
2. Put these files in this directory:
   - `TimelessGrotesk-Regular.woff2` (weight 400)
   - `TimelessGrotesk-Medium.woff2` (weight 500)
   - `TimelessGrotesk-SemiBold.woff2` (weight 600)
3. Put the license file of the font in this directory.
4. In `dashboard/app/src/styles.css`, remove the comment markers around the three
   `@font-face` rules.

If you use the Timeless Sans variable files instead, set the `STYL` axis to 0 and the `ital`
axis to 0.
