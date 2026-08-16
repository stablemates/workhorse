# Job dependencies

> Keep downstream work blocked until its prerequisites reach declared outcomes.

Dependencies prevent a job from entering dispatch before its inputs are ready. PostgreSQL stores
the job and its dependency edges in the enqueue transaction, so a rollback removes both.

```ts
const importId = await queue.enqueue("contacts.import", { source: "upload" });

await queue.enqueue("contacts.notify", { importId }, { prerequisiteJobId: importId });
```

For fan-in, declare every prerequisite and what each terminal outcome means:

```ts
await queue.enqueue(
  "release.announce",
  { release },
  {
    dependencies: {
      prerequisiteJobIds: [publishId, indexId],
      onSuccess: "release",
      onFailure: "fail",
      onCancellation: "cancel",
    },
  },
);
```

The dependent remains `blocked` until every edge resolves. If policies disagree after fan-in,
`fail` wins over `cancel`, and `cancel` wins over `release`, so concurrent completion order cannot
change the result.

## Inspect blocked work

`Queue.getJob` and `Queue.listJobs` expose `prerequisiteJobIds`, `dependencyPolicy`, and
`blockedReason`. `Queue.getDependencyLineage(jobId)` returns retained edges in both directions,
including policy, resolution, and release evidence. The dashboard exposes the same links and lets
an operator open related tasks directly.

PostgreSQL bounds direct edges and downstream settlement work. A cycle or an oversized graph raises
`DependencyCycleError` or `DependencyLimitExceededError` before unbounded work reaches dispatch.

## Next

- [Child jobs](/docs/child-jobs) — delegate work from inside a handler
- [Priority](/docs/priority) — order a dependent after release
- [Dead letters](/docs/dead-letters) — preserve terminal evidence

---

Exact dependency schema and lifecycle semantics:
[architecture reference](https://github.com/stablemates/workhorse/blob/main/docs/architecture.md#job_dependency).
