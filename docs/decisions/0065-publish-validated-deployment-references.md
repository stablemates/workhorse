# ADR 0065: Publish validated deployment references without deployment orchestration

- **Status:** Accepted
- **Date:** 2026-09-12
- **Related:** [ADR 0012](0012-dedicated-worker-processes.md),
  [ADR 0021](0021-no-framework-integration-packages.md), SM-17
- **Amends:** [ADR 0060](0060-describe-the-deployment-contract-instead-of-shipping-an-example.md)

## Context

ADR 0060 removed executable Kamal copies that looked authoritative but could not deploy the public
installation. It replaced them with the contract that the private operations repository consumes.

That decision also read as excluding deployment references for Workhorse users. A platform page can
be useful without claiming to operate the public installation, but only if its examples are tested
against the platform they describe.

Kubernetes needs several values to agree. The Pod grace period must exceed the Workhorse deadline.
The schema Job must finish before the worker rollout. Replica count also multiplies database pools
and notification listeners. A generic container fragment cannot establish those relationships.

## Decision

The repository may publish operator-neutral deployment reference pages. Every manifest must be
applied to a real target before publication, and the page records the target version and date.

A reference may contain inline manifests and commands that an operator adapts. It may not contain
the public installation's topology, credentials, or executable deployment orchestration. The live
site and demo deployment remain owned by the private operations repository.

The Kubernetes reference publishes standard Deployments, a schema Job, and a Service. Workhorse
publishes no Helm chart, operator, or custom resource definition.

## Consequences

Users get one coherent platform example whose fields have passed the target API server. The recorded
date also says when manual verification begins to age.

Maintainers must repeat platform validation when a manifest changes. A reference can still require
operator choices for images, secrets, ingress, authentication, resources, and database capacity.

The repository still cannot deploy or roll back the public installation. A reference page changing
does not change any running environment.
