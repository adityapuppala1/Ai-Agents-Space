import React from "react";
import { Inbox } from "lucide-react";

/**
 * Action-oriented empty state used by every list in Agent Space.
 *
 * Two honest modes:
 *  - normal: "nothing here yet" plus the action that would change that.
 *  - missing route: when a server endpoint answered 404 the panel says which
 *    route the feature needs instead of pretending the list is empty.
 *
 * @param {{
 *   title: string,
 *   description?: React.ReactNode,
 *   icon?: React.ReactNode,
 *   actions?: Array<{ label: string, onClick?: () => void, href?: string, primary?: boolean, disabled?: boolean }>,
 *   hint?: React.ReactNode,
 *   missingRoutes?: string[],     // e.g. ["GET /api/search"]
 *   error?: Error|null,           // an ApiError; status 404 switches to the missing-route wording
 *   compact?: boolean
 * }} props
 */
export default function EmptyState({
  title,
  description,
  icon,
  actions = [],
  hint,
  missingRoutes = [],
  error = null,
  compact = false,
}) {
  const notFound = error?.status === 404;
  const unavailable = error?.status === 503;
  const routes = missingRoutes.filter(Boolean);
  const heading = notFound
    ? "This feature needs a server route that is not enabled"
    : unavailable
      ? "This feature is not composed on this server"
      : title;
  return (
    <div
      className={`empty-state as-empty ${compact ? "as-empty-compact" : ""}`}
      role="status"
    >
      <span aria-hidden="true">
        {icon ?? <Inbox size={compact ? 20 : 28} />}
      </span>
      <h2>{heading}</h2>
      {notFound || unavailable ? (
        <>
          <p>
            {error?.message ??
              "The server answered that this endpoint is not available."}
          </p>
          {routes.length ? (
            <p className="as-muted as-small">
              Missing route{routes.length > 1 ? "s" : ""}:{" "}
              {routes.map((route, index) => (
                <React.Fragment key={route}>
                  {index > 0 ? ", " : ""}
                  <code className="as-mono">{route}</code>
                </React.Fragment>
              ))}
            </p>
          ) : null}
        </>
      ) : (
        <>
          {description ? <p>{description}</p> : null}
          {error ? (
            <p className="as-error-text" role="alert">
              {error.message}
            </p>
          ) : null}
        </>
      )}
      {actions.length ? (
        <div className="as-row as-wrap as-empty-actions">
          {actions.map((action) =>
            action.href ? (
              <a
                key={action.label}
                className={action.primary ? "button primary" : "button"}
                href={action.href}
              >
                {action.label}
              </a>
            ) : (
              <button
                key={action.label}
                type="button"
                className={action.primary ? "button primary" : "button"}
                onClick={action.onClick}
                disabled={action.disabled}
              >
                {action.label}
              </button>
            ),
          )}
        </div>
      ) : null}
      {hint ? <p className="as-muted as-small">{hint}</p> : null}
    </div>
  );
}
