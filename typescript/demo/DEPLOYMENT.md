# Deploying the site and demo

This document states what a deployment of the documentation site and demo must do. It ships no
deployment configuration.

That is deliberate. This repository used to carry parameterized Kamal files alongside the real ones,
which lived in a private operations repository. The copies were complete, executable, and sitting
under the ordinary names, so a reader looking for the deploy found them first and could not tell
they deployed nothing. They also drifted from the files they described.
[ADR 0060](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0060-describe-the-deployment-contract-instead-of-shipping-an-example.md)
removed them and made this page the contract instead. Requirements you have to satisfy yourself are
more work than a file to copy, and they are honest: the copy was never exercised by any deployment.

Maintainers operate the public installation from a private operations repository that holds its
credentials and concrete infrastructure. Nothing in this repository deploys anything.

## What this repository supplies

A deployment builds two images from this repository and nothing else:

- `Dockerfile` builds the demo.
- `Dockerfile.site` builds the documentation site, whose runtime serves the static bundle through
  the nginx configuration in `deployment/site.conf`.

Both Dockerfiles pin every base image by its multi-platform manifest digest. When updating a base
image, resolve the new tag to a digest and commit both values together. The tag documents the
intended release; the digest prevents a registry-side tag change from altering a build.

The demo image installs Python runtime dependencies from the committed `python/uv.lock`. Update that
lock with uv whenever `python/pyproject.toml` changes; the image build rejects a stale lock.

## What the deployment must provide

- A Linux host with Docker, SSH access, and public ports 80 and 443.
- DNS records for the site and demo hostnames pointing to that host.
- An OCI registry both the build machine and the host can reach.
- Two PostgreSQL databases the demo container can reach, each with a dedicated role.
- TLS termination that moves each hostname between healthy container versions.

Provisioning the registry, the databases, the edge gateway, and the host filesystem layout belongs
to the operator, because credentials, recovery procedures, and network topology differ between
installations.

## Configuration the demo reads

The demo server reads its configuration from the environment. These are the values a deployment must
supply:

| Variable                       | Purpose                                                       |
| ------------------------------ | ------------------------------------------------------------- |
| `DATABASE_URL_PRIMARY`         | Demo PostgreSQL URL, including credentials and TLS parameters |
| `DATABASE_URL_SECONDARY`       | Quiet staging workspace PostgreSQL URL, including credentials |
| `WORKHORSE_DEMO_PUBLIC_ORIGIN` | Complete HTTPS origin for browser links and origin validation |

`typescript/demo/src/index.ts` reads the remaining variables, which carry defaults: the port, the
demo mode and environment labels, the single-admin credentials, telemetry, seeding, and the shutdown
grace period.

Each demo workspace should have a dedicated role and database. The primary workspace runs the live
workers. The secondary workspace is seeded at startup but stays quiet and read-only in the
dashboard. Each URL must resolve from inside the deployed container, so a loopback address on the
build machine is not usable.

If the demo reaches PostgreSQL over a Unix socket, give that instance a dedicated socket directory
and mount only that directory. Do not mount a host-wide socket directory such as
`/var/run/postgresql`, because it may contain sockets for unrelated databases.

Keep credentials out of this repository. A deployment supplies them from its own secret store.

## Resource and traffic requirements

The demo container is limited to one CPU, 1 GiB of memory, and 256 processes. The shared proxy is
limited to half a CPU, 256 MiB of memory, and 128 processes. Keep equivalent limits so traffic or a
runaway process cannot consume the host's full capacity.

The demo keeps anonymous operator controls available, and the server limits each client to a burst
of five mutations and then twelve mutations per minute. The proxy in front of it must append the
address it observes to `X-Forwarded-For`; the server uses the right-most address so a caller cannot
choose the rate-limit key. Any replacement proxy must preserve that append-only chain.

The server retains successful and failed operator audit rows for seven days. It removes at most
1,000 expired rows at startup and during each one-minute pass, so cleanup stays bounded while its
capacity remains above the accepted mutation rate. The database role needs `DELETE` access to
`public.workhorse_demo_audit` in addition to the access the writable demo requires.

The demo host omits persisted worker stack traces from task-detail RPC responses. It keeps the error
name and message so visitors can understand intentional failures without learning container paths or
package internals.

A routine deploy never creates, drops, or restores either database. Database recovery belongs to the
operator's runbook.

## The schema step runs from the pipeline

**This is the part of the contract a deployment must not get wrong.**

The schema step runs from the pipeline, after the image is built and pushed and before any container
from it starts:

```sh
node dist/prepare-schema.js
```

Run it in a container started from the exact version being deployed, with the same environment and
volumes the application role receives. The schema tool is then the one inside the image about to
serve traffic, and its version matches the application because it is the same image. That is the
container form of the local-binary rule on the
[installation page](https://workhorse.run/docs/installation).

`dist/prepare-schema.js` installs or migrates the Workhorse schema and the demo's own tables in
every configured workspace, then verifies each one with the checks the server makes at startup. It
stands in for the documented `workhorse schema status --json` verification, because the demo has two
databases and a second schema the CLI does not know about. A refusal exits non-zero, which must fail
the deploy before the container swap.

Nothing prepares a schema at startup. The container entry point starts processes only, and the
server asserts compatibility and refuses to open `/up` when the step did not run. That is
deliberate: a component that migrated itself would be as many concurrent migrators as the deployment
has nodes, which is why
[ADR 0053](https://github.com/stablemates/workhorse/blob/main/docs/decisions/0053-start-migrations-at-0-1-0-and-keep-them-additive.md)
makes migration a pipeline step. A deployment that recreates a demo database must let the step run
before the new container starts.

If the deployment tool runs one hooks directory per application, name it explicitly. A directory
shared between the site and the demo runs the demo's schema step during a site deploy.

### The first installation needs one manual schema step

A deployment tool that writes the role's secret environment file to the host when it boots a
container, and runs pre-deploy hooks before that, cannot run this step on the very first deploy: the
file does not exist yet, so the hook's container cannot start.

Install the schema once from the host before the first deploy, using the same image and the same
command, with the database URLs supplied however your installation supplies secrets to a one-off
container. Every deploy after that is the pipeline step alone.

## Deploying a revision that is on `main`

A deployment publishes whatever revision its source checkout holds. A checkout behind the branch
republishes the previous build and reports success, which is indistinguishable from a deploy that
did nothing. Verify the revision before deploying, and prefer a deployment path that refuses a
source checkout that is stale or has uncommitted changes rather than one that trusts the operator to
remember.
