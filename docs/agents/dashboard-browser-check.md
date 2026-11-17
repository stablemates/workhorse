# Check the standalone dashboard in a browser

No CI lane loads the standalone dashboard in a browser, so a violation of the Content Security
Policy can pass CI. Do this check after a change to the dashboard user interface or its Content Security
Policy. Do not start the demo for this check.

The commands run through `scripts/with-env.ts`. The wrapper uses the databases of this checkout and
refuses an unconfigured worktree, so the check cannot change the data of a different checkout.

1. Build the TypeScript runtime: `pnpm build`.
2. `pnpm worktree:setup` installs the schema on each database of the checkout. If the second
   development database has an older schema, migrate it:

   ```sh
   pnpm exec tsx scripts/with-env.ts sh -c \
     'exec node typescript/core/dist/src/cli/workhorse.js schema migrate --database-url "$DATABASE_URL_SECONDARY"'
   ```

3. Start the dashboard without authentication on a free port. The command runs until you stop it,
   so run it in a second terminal or a background shell:

   ```sh
   pnpm exec tsx scripts/with-env.ts sh -c \
     'for v in $(env | sed -n "s/^\(WORKHORSE_DASHBOARD_[A-Z_]*\)=.*/\1/p"); do unset "$v"; done
      exec node typescript/core/dist/src/cli/workhorse.js dashboard \
        --database-url "$DATABASE_URL_SECONDARY" --host 127.0.0.1 --port <free port>'
   ```

4. Wait until the dashboard answers: `curl -fsS http://127.0.0.1:<port>/ >/dev/null`.
5. Load each page with the headless Chromium of Playwright. The pages are `/tasks`, `/events`,
   `/groups`, `/cron`, `/queues`, `/system`, `/workers`, and `/settings`:
   `~/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell --no-sandbox --enable-logging=stderr --v=0 --virtual-time-budget=8000 --dump-dom http://127.0.0.1:<port><page>`.
6. Read stderr. A violation shows as `CONSOLE ... violates the following Content Security Policy`.
7. Stop the dashboard with Ctrl+C (SIGINT) or SIGTERM.

The command in step 3 unsets each `WORKHORSE_DASHBOARD_*` variable. These include the `_FILE`
variants and the previous password hash. If one of them stays set, the dashboard can require a
login or refuse to start. A variable that is set to an empty value counts as set. The flag is
`--host`, not `--hostname`.
