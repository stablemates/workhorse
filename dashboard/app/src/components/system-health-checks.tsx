import type { QueueHealthReason } from "@stablemates/workhorse";
import { Anchor, Badge, VisuallyHidden } from "@mantine/core";
import { systemHealthChecks, type SystemHealthCheck } from "../presentation-policy.js";
import { formatCount } from "../count-format.js";

/**
 * How each check state reads. `tone` sets the dot color. A passing check shows only its dot, so
 * a badge appears only where a check needs attention or a limit holds tasks back.
 */
const checkStatuses: Record<
  SystemHealthCheck["status"],
  { label: string; tone: "success" | "warning" | "danger" | "neutral"; badge: string | null }
> = {
  critical: { label: "Critical", tone: "danger", badge: "red" },
  degraded: { label: "Degraded", tone: "warning", badge: "yellow" },
  passing: { label: "Passing", tone: "success", badge: null },
  throttling: { label: "Throttling", tone: "neutral", badge: "gray" },
  limiting: { label: "Limiting", tone: "neutral", badge: "gray" },
};

/** One line that answers "is anything wrong", above the list of checks. */
function healthChecksSummary(checks: readonly SystemHealthCheck[]): {
  text: string;
  tone: "success" | "warning" | "danger";
} {
  const critical = checks.filter((check) => check.status === "critical").length;
  const attention = critical + checks.filter((check) => check.status === "degraded").length;
  const total = formatCount(checks.length);
  if (attention === 0) return { text: `All ${total} checks passing`, tone: "success" };
  return {
    text: `${formatCount(attention)} of ${total} ${attention === 1 ? "needs" : "need"} attention`,
    tone: critical > 0 ? "danger" : "warning",
  };
}

export function SystemHealthChecks({ reasons }: { reasons: readonly QueueHealthReason[] }) {
  const checks = systemHealthChecks(reasons);
  const summary = healthChecksSummary(checks);
  const limiting = checks.filter(
    (check) => check.status === "limiting" || check.status === "throttling",
  ).length;
  return (
    <section className="panel health-checks" aria-label="Health checks">
      <header className="health-checks__header">
        <div>
          <h2 className="health-checks__title">Health checks</h2>
          <p className="health-checks__note">
            Current state at the latest refresh. Limits show when they are holding ready tasks back.
          </p>
        </div>
        <p className="health-checks__summary" data-tone={summary.tone}>
          <span className="health-checks__dot" data-tone={summary.tone} aria-hidden="true" />
          <span>{summary.text}</span>
          {limiting === 0 ? null : (
            <span className="health-checks__limits">
              {formatCount(limiting)} {limiting === 1 ? "limit" : "limits"} holding tasks back
            </span>
          )}
        </p>
      </header>
      <ul className="health-checks__list">
        {checks.map((check) => {
          const status = checkStatuses[check.status];
          return (
            <li className="health-check" data-status={check.status} key={check.code}>
              <span className="health-checks__dot" data-tone={status.tone} aria-hidden="true" />
              <span className="health-check__name">
                {check.label}
                <VisuallyHidden>: {status.label}</VisuallyHidden>
              </span>
              <div className="health-check__details">
                {check.messages.length === 0 ? (
                  <p className="health-check__summary">{check.summary}</p>
                ) : (
                  check.messages.map((message) => (
                    <div key={message.message}>
                      <p className="health-check__message">
                        {message.subject ? (
                          <>
                            {message.subject.label} <strong>{message.subject.name}</strong>{" "}
                            {message.subject.detail}
                          </>
                        ) : (
                          message.message
                        )}
                      </p>
                      <p className="health-check__advice">
                        {message.advice}{" "}
                        <Anchor
                          href={message.helpHref}
                          target="_blank"
                          rel="noopener noreferrer"
                          size="xs"
                        >
                          Learn more
                        </Anchor>
                      </p>
                    </div>
                  ))
                )}
              </div>
              {status.badge === null ? null : (
                <Badge
                  className="health-check__badge"
                  color={status.badge}
                  variant="light"
                  size="sm"
                  tt="none"
                  aria-hidden="true"
                >
                  {status.label}
                </Badge>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
