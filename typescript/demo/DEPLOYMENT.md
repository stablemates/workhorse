# Deploying the site and demo

This repository includes parameterized Kamal examples for operators who want to run the
documentation site and demo on one Docker host. They describe the application contract, but they
are not the source of truth for the Workhorse project's live installation.

Maintainers operate the public installation from the private `../workhorse-operations` sibling
repository, including its credentials and concrete infrastructure configuration. Do not create
`deployment/kamal/secrets.env` in this repository.

The demo host omits persisted worker stack traces from task-detail RPC responses. It keeps the
error name and message so visitors can understand intentional failures without learning container
paths or package internals.

Kamal builds each image locally, pushes it to an OCI registry, and starts it on the host over SSH.
`kamal-proxy` terminates TLS and moves each hostname between healthy container versions.

Both Dockerfiles pin every base image by its multi-platform manifest digest. When updating a base
image, resolve the new tag to a digest and commit both values together. The tag documents the
intended release, while the digest prevents a registry-side tag change from altering a build.

## Prerequisites

Provide these services before using the examples:

- A Linux host with Docker, SSH access, and public ports 80 and 443.
- DNS records for the site and demo hostnames pointing to that host.
- An OCI registry that both the build machine and deployment host can reach.
- Two PostgreSQL databases that the demo container can reach over the network.
- Ruby, Bundler, Docker, and an SSH client on the build machine.

The example does not provision a registry, database, edge gateway, or host filesystem layout.
Those choices belong to the operator because their credentials, recovery procedures, and network
topology differ between installations.

## Configuration

`config/deploy.site.yml` builds `Dockerfile.site` and publishes the documentation site.
`config/deploy.yml` builds `Dockerfile` and publishes the demo. Both files read their installation
details from the environment:

The demo image installs Python runtime dependencies from the committed `python/uv.lock`. Update
that lock with uv whenever `python/pyproject.toml` changes; the image build rejects a stale lock.

| Variable                       | Purpose                                                       |
| ------------------------------ | ------------------------------------------------------------- |
| `WORKHORSE_DEPLOY_HOST`        | SSH hostname or address of the Docker host                    |
| `WORKHORSE_DEPLOY_USER`        | SSH user allowed to manage Docker                             |
| `WORKHORSE_REGISTRY_SERVER`    | OCI registry hostname                                         |
| `WORKHORSE_REGISTRY_USER`      | Registry account used by Kamal                                |
| `WORKHORSE_REGISTRY_TOKEN`     | Registry token or password                                    |
| `WORKHORSE_SITE_HOST`          | Primary documentation hostname                                |
| `WORKHORSE_SITE_WWW_HOST`      | Additional documentation hostname                             |
| `WORKHORSE_DEMO_HOST`          | Demo hostname                                                 |
| `WORKHORSE_DEMO_PUBLIC_ORIGIN` | Complete HTTPS origin for browser links and origin validation |
| `DATABASE_URL_PRIMARY`         | Demo PostgreSQL URL, including credentials and TLS parameters |
| `DATABASE_URL_SECONDARY`       | Quiet staging workspace PostgreSQL URL, including credentials |

Export the values in the operator's secret manager or shell. `.kamal/secrets` passes only the
registry token and database URLs to Kamal, while the non-secret values render the two example
configs.

Each demo workspace should have a dedicated role and database. The primary workspace runs the live
workers. The secondary workspace is seeded at startup but stays quiet and read-only in the
dashboard. The checked-in example reaches both over the network and does not mount a PostgreSQL
socket directory from the host. Each URL must resolve from inside the deployed container, so a
loopback address on the build machine is not usable.

## First deployment

The repository pins Kamal in `deployment/kamal/Gemfile`. Install that bundle from the repository
root:

```sh
BUNDLE_GEMFILE=deployment/kamal/Gemfile bundle install
```

After exporting the configuration, prepare both applications:

```sh
scripts/setup-kamal.sh
```

Kamal installs its proxy and starts the site and demo. Confirm that both `/up` endpoints return
success over HTTPS before sending users to the installation.

The demo container is limited to one CPU, 1 GiB of memory, and 256 processes. The shared proxy is
limited to half a CPU, 256 MiB of memory, and 128 processes. Keep equivalent limits when adapting
the examples so traffic or a runaway process cannot consume the host's full capacity.

The demo keeps anonymous operator controls available, but the server limits each client to a burst
of five mutations and then twelve mutations per minute. `kamal-proxy` must append the address it
observes to `X-Forwarded-For`; the server uses the right-most address so a caller cannot choose the
rate-limit key. If another proxy sits in front of Kamal, preserve that append-only chain.

The server retains successful and failed operator audit rows for seven days. It removes at most
1,000 expired rows at startup and during each one-minute pass, so cleanup stays bounded while its
capacity remains above the accepted mutation rate. The database role needs `DELETE` access to
`public.workhorse_demo_audit` in addition to the access required by the writable demo.

## Routine deployment

Deploy both applications from a clean revision:

```sh
scripts/deploy.sh
```

Deploy only one application when its source changed independently:

```sh
scripts/deploy-site.sh
scripts/deploy-demo.sh
```

The demo receives `DATABASE_URL_PRIMARY` and `DATABASE_URL_SECONDARY` as runtime secrets. This
enables the production and staging workspace switcher. A routine deploy never creates, drops, or
restores either database. Database recovery belongs to the operator's private runbook.

## The schema step runs from the pipeline

`.kamal/hooks/pre-deploy` runs the schema step. Kamal calls that hook after it builds and pushes the
image and before it boots any container from it, which is the window the step belongs in: the
database is ready for the new release before a process from that release exists.

```sh
bundle exec kamal app exec --version "$KAMAL_VERSION" "node dist/prepare-schema.js"
```

`kamal app exec` starts a new container from the version being deployed, with the role's
environment and volumes, so the schema tool is the one inside the image that is about to serve
traffic. Its version matches the application because it is the same image. That is the container
form of the local-binary rule on the [installation page](https://workhorse.run/docs/installation).

`dist/prepare-schema.js` installs or migrates the Workhorse schema and the demo's own tables in
every configured workspace, then verifies each one with the checks the server makes at startup. It
stands in for the documented `workhorse schema status --json` verification, because the demo has
two databases and a second schema the CLI does not know about. A refusal exits non-zero, which
fails the deploy before the container swap.

Nothing prepares a schema at startup. The container entry point starts processes only, and the
server asserts compatibility and refuses to open `/up` when the step did not run. That is
deliberate: a component that migrated itself would be as many concurrent migrators as the
deployment has nodes, which is why
[ADR 0053](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0053-start-migrations-at-0-1-0-and-keep-them-additive.md)
makes migration a pipeline step. An installation that recreates a demo database must let this hook
run before the new container starts, which a normal `kamal deploy` does.

### The first installation needs one manual schema step

Kamal writes each role's secret environment file to the host when it boots a container, and it runs
`pre-deploy` before that. On every later deploy the file is already there, so the hook's container
receives the database URLs. On the very first deploy the file does not exist yet, the hook's
container cannot start, and the deploy stops before it boots anything.

Install the schema once from the host before the first `scripts/setup-kamal.sh`, using the same
image and the same command the hook runs, with the database URLs supplied however your installation
supplies secrets to a one-off container. Every deploy after that is the hook alone.

## Adapting the examples

The checked-in configs assume one host, an external registry, an externally managed database, and
direct TLS through `kamal-proxy`. Copy and adapt them when an installation needs multiple hosts,
private networking, a reverse proxy, a host socket, or another registry authentication scheme. If
the demo uses a Unix socket, give its PostgreSQL instance a dedicated socket directory and mount
only that directory. Do not mount the host-wide `/var/run/postgresql` directory because it may
contain sockets for unrelated databases. Any replacement proxy must append its observed client
address to `X-Forwarded-For`. Keep credentials and concrete infrastructure values out of the copied
repository.
