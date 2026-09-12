# Deploying Workhorse on Kubernetes

This reference deploys Workhorse as ordinary Kubernetes workloads. Workhorse publishes no Helm
chart, operator, or custom resource definition.

The manifests below were applied to a k3s v1.34.1+k3s1 cluster on 2026-09-12. They use standard
`batch/v1` and `apps/v1` resources, so they do not depend on k3s-specific APIs.

Replace `registry.example.com/acme/workhorse-app:1.2.3` with one immutable application image. The
image must contain the Workhorse CLI and the compiled worker configuration at
`/app/dist/workhorse.worker.js`.

## Supply secrets outside the manifests

Create these Secrets with your secret manager or deployment system before applying the workloads:

| Secret                     | Key             | Consumer                     |
| -------------------------- | --------------- | ---------------------------- |
| `workhorse-database`       | `url`           | Migration, worker, dashboard |
| `workhorse-dashboard-auth` | `username`      | Dashboard                    |
| `workhorse-dashboard-auth` | `password-hash` | Dashboard                    |

The examples only use `secretKeyRef` and a Secret volume. They contain no database URL, password,
or password hash.

## Migrate the schema before the rollout

Run one versioned Job from the release image. Give each release a new Job name because a Job's Pod
template is immutable.

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: workhorse-schema-migrate-1-2-3
  labels:
    app.kubernetes.io/name: workhorse
    app.kubernetes.io/component: schema
    app.kubernetes.io/version: "1.2.3"
spec:
  backoffLimit: 1
  template:
    metadata:
      labels:
        app.kubernetes.io/name: workhorse
        app.kubernetes.io/component: schema
        app.kubernetes.io/version: "1.2.3"
    spec:
      restartPolicy: Never
      containers:
        - name: schema
          image: registry.example.com/acme/workhorse-app:1.2.3
          imagePullPolicy: IfNotPresent
          command: ["/bin/sh", "-ec"]
          args:
            - |
              workhorse schema migrate
              workhorse schema status --json
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: workhorse-database
                  key: url
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
```

Apply the Job and wait for `Complete` before changing either Deployment:

```sh
kubectl apply -f workhorse-schema-job.yaml
kubectl wait --for=condition=Complete job/workhorse-schema-migrate-1-2-3 --timeout=10m
kubectl logs job/workhorse-schema-migrate-1-2-3
```

If the Job fails, stop the release. Do not let an init container migrate from every worker replica;
that turns one deliberate migration into concurrent migration attempts.

## Deploy the workers

This Deployment runs two worker replicas. Two replicas avoid making one Pod the worker tier's only
process, but `replicas` also multiplies handler concurrency and database pools. Set it from the
capacity and availability your application requires.

The resource requests below are scheduling placeholders, not sizing claims. Replace them with
values measured for your handlers.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: workhorse-worker
  labels:
    app.kubernetes.io/name: workhorse
    app.kubernetes.io/component: worker
spec:
  replicas: 2
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0
      maxSurge: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: workhorse
      app.kubernetes.io/component: worker
  template:
    metadata:
      labels:
        app.kubernetes.io/name: workhorse
        app.kubernetes.io/component: worker
    spec:
      terminationGracePeriodSeconds: 120
      containers:
        - name: worker
          image: registry.example.com/acme/workhorse-app:1.2.3
          imagePullPolicy: IfNotPresent
          command: ["workhorse"]
          args:
            - worker
            - --config
            - /app/dist/workhorse.worker.js
            - --shutdown-timeout-ms
            - "110000"
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: workhorse-database
                  key: url
          ports:
            - name: probes
              containerPort: 9090
              protocol: TCP
          readinessProbe:
            httpGet:
              path: /readyz
              port: probes
            periodSeconds: 5
            timeoutSeconds: 2
            failureThreshold: 2
          livenessProbe:
            httpGet:
              path: /livez
              port: probes
            periodSeconds: 10
            timeoutSeconds: 2
            failureThreshold: 3
          resources:
            requests:
              cpu: 250m
              memory: 256Mi
```

The first termination signal makes `/readyz` return 503 before the process stops claiming tasks.
It keeps `/livez` at 200 while active handlers drain. `/livez` reports process lifecycle, not
PostgreSQL health, queue health, or handler success.

The 120-second Pod grace exceeds the 110-second Workhorse deadline. Kubernetes defaults the grace
to 30 seconds and sends `SIGKILL` when it expires, so leaving the default would cut this drain short.
A `preStop` hook uses the same grace budget; this example omits one so Workhorse receives the full
window.

## Deploy the dashboard behind your ingress

The dashboard has its own Deployment and an internal `ClusterIP` Service. The reference does not
publish an Ingress because TLS, hostnames, and upstream authorization belong to the operator.

The standalone dashboard requires authentication when it binds beyond loopback. This example reads
its single-administrator credentials from a Secret. If your application embeds the dashboard, use
the application's shared authorization instead.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: workhorse-dashboard
  labels:
    app.kubernetes.io/name: workhorse
    app.kubernetes.io/component: dashboard
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: workhorse
      app.kubernetes.io/component: dashboard
  template:
    metadata:
      labels:
        app.kubernetes.io/name: workhorse
        app.kubernetes.io/component: dashboard
    spec:
      containers:
        - name: dashboard
          image: registry.example.com/acme/workhorse-app:1.2.3
          imagePullPolicy: IfNotPresent
          command: ["workhorse"]
          args:
            - dashboard
            - --host
            - 0.0.0.0
            - --port
            - "3000"
            - --public-origin
            - https://workhorse.example.com
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: workhorse-database
                  key: url
            - name: WORKHORSE_DASHBOARD_USERNAME
              valueFrom:
                secretKeyRef:
                  name: workhorse-dashboard-auth
                  key: username
            - name: WORKHORSE_DASHBOARD_PASSWORD_HASH_FILE
              value: /run/secrets/workhorse/password-hash
          ports:
            - name: http
              containerPort: 3000
              protocol: TCP
          readinessProbe:
            tcpSocket:
              port: http
            periodSeconds: 5
            timeoutSeconds: 2
            failureThreshold: 2
          livenessProbe:
            tcpSocket:
              port: http
            periodSeconds: 10
            timeoutSeconds: 2
            failureThreshold: 3
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
          volumeMounts:
            - name: dashboard-auth
              mountPath: /run/secrets/workhorse
              readOnly: true
      volumes:
        - name: dashboard-auth
          secret:
            secretName: workhorse-dashboard-auth
            items:
              - key: password-hash
                path: password-hash
---
apiVersion: v1
kind: Service
metadata:
  name: workhorse-dashboard
  labels:
    app.kubernetes.io/name: workhorse
    app.kubernetes.io/component: dashboard
spec:
  type: ClusterIP
  selector:
    app.kubernetes.io/name: workhorse
    app.kubernetes.io/component: dashboard
  ports:
    - name: http
      port: 80
      targetPort: http
      protocol: TCP
```

Point your authenticated HTTPS ingress at `workhorse-dashboard:80`. Change `--public-origin` to the
public HTTPS origin. Keep one standalone dashboard replica because its built-in sessions are
process-local; use an embedded dashboard with shared host authentication before scaling it out.

## Budget database connections per replica

Let `R` be worker replicas and `P` be the node-postgres pool maximum inside each worker process.
The worker tier can open `R × P` client connections. A notification-capable pool reserves one of
its own connections for the shared `LISTEN` listener, so `R` replicas reserve `R` listeners and
leave at most `R × (P - 1)` pool slots for queries.

For example, two replicas with `max: 10` can open 20 client connections. Two connections can remain
on `LISTEN`, leaving 18 worker-pool slots for claims, heartbeats, handlers, and maintenance. Add the
dashboard pool, producer pools, and the transient migration Job before comparing the total with the
database or pooler's client limit.

Transaction-mode PgBouncer preserves Workhorse queue correctness but cannot preserve `LISTEN`
session state. Use direct PostgreSQL or session-mode PgBouncer for the notification pool, or disable
notification-assisted dispatch and rely on bounded polling. Session mode preserves `LISTEN` but
also keeps one server session for each listener.

Supavisor has the same boundary. Transaction mode does not support `LISTEN/NOTIFY`; session or
native mode preserves a client session. Supavisor recommends native or direct connections for
migrations, so point the schema Job there even when ordinary queries use transaction pooling.

## Roll out and roll back

Use this order for a release that contains a schema migration:

1. Build and publish one immutable application image.
2. Apply the versioned migration Job and wait for it to complete successfully.
3. Apply the worker and dashboard manifests with that same image.
4. Wait for both Deployment rollouts to finish.

```sh
kubectl apply -f workhorse-worker.yaml
kubectl apply -f workhorse-dashboard.yaml
kubectl rollout status deployment/workhorse-worker
kubectl rollout status deployment/workhorse-dashboard
```

If either rollout fails after migration, roll the Deployment back to its previous image. Do not
reverse the schema migration. Migrations within a major release only add, so the previous release
continues to accept the newer schema.

```sh
kubectl rollout undo deployment/workhorse-worker
kubectl rollout undo deployment/workhorse-dashboard
kubectl rollout status deployment/workhorse-worker
kubectl rollout status deployment/workhorse-dashboard
```

`workhorse schema migrate` never applies a contract step. Apply a contract step separately only
after every old worker and producer has left the fleet.

## Sources

- [Kubernetes Pod termination](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination)
- [Kubernetes Deployments](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/)
- [Kubernetes Jobs](https://kubernetes.io/docs/concepts/workloads/controllers/job/)
- [Supavisor pool modes](https://supabase.github.io/supavisor/configuration/pool_modes/)
- [Workhorse worker lifecycle](architecture.md#worker-process-lifecycle)
- [Workhorse connection poolers](compatibility.md#connection-poolers)
