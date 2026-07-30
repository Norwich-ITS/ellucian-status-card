// System-status card for Ellucian Experience.
//
// Renders live status from any Atlassian Statuspage-powered status page
// (status.elluciancloud.com by default) using Statuspage's public v2 API:
// overall status, unresolved incidents with their latest update, a list of
// any non-operational components ("systems"), and active/upcoming
// maintenance windows.
//
// Architecture note: unlike most Experience cards there is NO Data Connect
// pipeline, microservice, or API key here. Statuspage's v2 API is public and
// serves open CORS headers, so this card fetches it directly from the
// browser. That keeps the whole extension self-contained - clone, deploy,
// done.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  spacing20,
  spacing40,
} from "@ellucian/react-design-system/core/styles/tokens";
import {
  makeStyles,
  Typography,
  TextLink,
} from "@ellucian/react-design-system/core";
import { useCardInfo } from "@ellucian/experience-extension-utils";

const useStyles = makeStyles()({
  card: {
    margin: `0 ${spacing40}`,
    // Normalize typography block margins so tiny cumulative spacing doesn't trigger a scroll bar.
    "& p, & h1, & h2, & h3, & h4, & h5, & h6": {
      margin: 0,
    },
  },
  headerRow: {
    alignItems: "center",
    display: "flex",
    justifyContent: "space-between",
    gap: spacing20,
    marginTop: "0.25rem",
  },
  badge: {
    borderRadius: 999,
    fontSize: "0.75rem",
    fontWeight: 700,
    padding: "0.25rem 0.65rem",
    textTransform: "uppercase",
  },
  statusDescription: {
    marginTop: "0.2rem",
  },
  section: {
    marginTop: "0.4rem",
  },
  sectionTitle: {
    fontSize: "0.8rem",
    fontWeight: 700,
    letterSpacing: "0.02em",
    textTransform: "uppercase",
  },
  detailText: {
    marginTop: "0.25rem",
  },
  updateText: {
    color: "#475467",
    fontSize: "0.85rem",
    marginTop: "0.25rem",
  },
  emptyStateText: {
    color: "#6b7280",
    fontSize: "0.85rem",
    marginTop: "0.15rem",
  },
  detailGroup: {
    marginTop: "0.35rem",
  },
  compactRow: {
    color: "#6b7280",
    fontSize: "0.85rem",
    marginTop: "0.35rem",
  },
  footer: {
    alignItems: "center",
    display: "flex",
    justifyContent: "space-between",
    marginTop: "0.2rem",
  },
  linkRow: {
    marginTop: "0.1rem",
  },
});

const DEFAULT_API_BASE = "https://status.elluciancloud.com/api/v2";
const DEFAULT_REFRESH_MINUTES = 5;
const MIN_REFRESH_MINUTES = 1;
const MAX_REFRESH_MINUTES = 60;

// Maps Statuspage's overall-status "indicator" values (none/minor/major/
// critical) to badge colors and a human label. The same scale is reused for
// per-incident "impact" values, which use the identical vocabulary.
const statusVisual = (indicator) => {
  if (indicator === "none") {
    return {
      background: "#e4f4e5",
      color: "#1f6b2a",
      label: "Operational",
    };
  }

  if (indicator === "minor") {
    return {
      background: "#fff8df",
      color: "#8a6b00",
      label: "Minor",
    };
  }

  if (indicator === "major") {
    return {
      background: "#ffe9db",
      color: "#a24c00",
      label: "Major",
    };
  }

  if (indicator === "critical") {
    return {
      background: "#ffe5e6",
      color: "#9c1a1f",
      label: "Critical",
    };
  }

  return {
    background: "#eceff3",
    color: "#334155",
    label: "Unknown",
  };
};

// Statuspage incident lifecycle states -> display labels.
const INCIDENT_STATUS_LABELS = {
  investigating: "Investigating",
  identified: "Identified",
  monitoring: "Monitoring",
  postmortem: "Postmortem",
};

// Statuspage per-component states -> display labels ("operational" is
// filtered out before rendering, so it needs no label here).
const COMPONENT_STATUS_LABELS = {
  degraded_performance: "Degraded performance",
  partial_outage: "Partial outage",
  major_outage: "Major outage",
  under_maintenance: "Under maintenance",
};

const truncateText = (value, maxLength = 220) => {
  if (typeof value !== "string") {
    return "";
  }

  return value.length > maxLength
    ? `${value.slice(0, maxLength).trimEnd()}...`
    : value;
};

const componentNames = (components) =>
  (components || [])
    .map((component) => component?.name)
    .filter(Boolean)
    .join(", ");

// Makes the configured base URL forgiving. Experience's config fields can't
// show usage examples (labels truncate at ~45 chars), so instead of asking
// admins to type the exact API URL we accept any reasonable form -
// "norwich.statuspage.io", "http://status.example.edu/", a full
// ".../api/v2" - and normalize it: force https, trim trailing slashes, and
// append the Statuspage API path if it's missing. Blank means "use
// Ellucian's status page".
const normalizeBaseUrl = (value) => {
  if (typeof value !== "string" || value.trim() === "") {
    return DEFAULT_API_BASE;
  }

  let url = value.trim().replace(/\/+$/, "");
  url = url.replace(/^http:\/\//i, "https://");

  if (!/^https:\/\//i.test(url)) {
    url = `https://${url}`;
  }

  return url.toLowerCase().endsWith("/api/v2") ? url : `${url}/api/v2`;
};

// Clamps the configured refresh interval to 1-60 minutes so a typo can't
// hammer the API or effectively disable refreshing.
const parseRefreshMinutes = (value) => {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return DEFAULT_REFRESH_MINUTES;
  }

  return Math.min(
    MAX_REFRESH_MINUTES,
    Math.max(MIN_REFRESH_MINUTES, Math.round(parsed)),
  );
};

const formatDateTime = (value) => {
  if (!value) {
    return "Not provided";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
};

const fetchJson = async (baseUrl, path) => {
  const response = await window.fetch(`${baseUrl}${path}`);

  if (!response.ok) {
    throw new Error(`Request failed for ${path}: ${response.status}`);
  }

  return response.json();
};

const EllucianStatus = (props) => {
  const { classes } = useStyles();
  const cardInfo = useCardInfo();
  const isMounted = useRef(true);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [statusData, setStatusData] = useState(null);
  const [unresolvedIncidents, setUnresolvedIncidents] = useState([]);
  const [activeMaintenances, setActiveMaintenances] = useState([]);
  const [upcomingMaintenances, setUpcomingMaintenances] = useState([]);
  const [nonOperationalComponents, setNonOperationalComponents] = useState([]);
  const [lastFetchedAt, setLastFetchedAt] = useState(null);

  // Client configuration values (from Card Management) can surface on
  // several different paths depending on SDK version and whether the card is
  // rendered on the dashboard or the extension page, so check each known
  // location before giving up.
  const cardConfiguration = useMemo(() => {
    const fromProps = props?.cardInfo?.configuration;
    const fromCardInfo = cardInfo?.configuration;
    const direct = props?.configuration;
    const fallback = props?.cardConfiguration;

    return fromProps || fromCardInfo || direct || fallback || {};
  }, [cardInfo, props]);

  const apiBaseUrl = useMemo(
    () =>
      normalizeBaseUrl(
        cardConfiguration.apiBaseUrl || cardConfiguration.baseUrl,
      ),
    [cardConfiguration],
  );

  const refreshMinutes = useMemo(
    () =>
      parseRefreshMinutes(
        cardConfiguration.refreshMinutes ||
          cardConfiguration.refreshIntervalMinutes,
      ),
    [cardConfiguration],
  );

  const loadData = useCallback(
    async ({ showLoading = false } = {}) => {
      if (showLoading && isMounted.current) {
        setIsLoading(true);
      }

      if (isMounted.current) {
        setError("");
      }

      try {
        // Five Statuspage endpoints, fetched in parallel:
        //   status.json      - overall rollup (indicator + description)
        //   unresolved.json  - open incidents with their update history
        //   active/upcoming  - maintenance windows
        //   components.json  - per-system status. Fetched separately because
        //     Ellucian frequently does NOT tag components on incidents (the
        //     affected system is only named in the incident title), so this
        //     is the reliable way to answer "which system is having trouble".
        const [
          statusResponse,
          unresolvedResponse,
          activeResponse,
          upcomingResponse,
          componentsResponse,
        ] = await Promise.all([
          fetchJson(apiBaseUrl, "/status.json"),
          fetchJson(apiBaseUrl, "/incidents/unresolved.json"),
          fetchJson(apiBaseUrl, "/scheduled-maintenances/active.json"),
          fetchJson(apiBaseUrl, "/scheduled-maintenances/upcoming.json"),
          fetchJson(apiBaseUrl, "/components.json"),
        ]);

        if (!isMounted.current) {
          return;
        }

        setStatusData(statusResponse);
        setUnresolvedIncidents(unresolvedResponse.incidents || []);
        setActiveMaintenances(activeResponse.scheduled_maintenances || []);
        setUpcomingMaintenances(upcomingResponse.scheduled_maintenances || []);
        // Keep only real, unhealthy components: group rows are just visual
        // containers on the status page, and operational components would
        // make the list 80+ entries of noise.
        setNonOperationalComponents(
          (componentsResponse.components || []).filter(
            (component) => !component.group && component.status !== "operational",
          ),
        );
        setLastFetchedAt(new Date().toISOString());
      } catch (loadError) {
        if (!isMounted.current) {
          return;
        }

        setError(
          loadError instanceof Error
            ? loadError.message
            : "Unable to load status information.",
        );
      } finally {
        if (showLoading && isMounted.current) {
          setIsLoading(false);
        }
      }
    },
    [apiBaseUrl],
  );

  // Initial load plus a polling interval. Background refreshes pass
  // showLoading: false so the card doesn't flicker back to its loading state
  // every few minutes while users are looking at it.
  useEffect(() => {
    isMounted.current = true;
    loadData({ showLoading: true });

    const intervalId = window.setInterval(
      () => {
        loadData({ showLoading: false });
      },
      refreshMinutes * 60 * 1000,
    );

    return () => {
      isMounted.current = false;
      window.clearInterval(intervalId);
    };
  }, [loadData, refreshMinutes]);

  useEffect(() => {
    const previousBodyMargin = document.body.style.margin;
    const previousBodyPadding = document.body.style.padding;

    document.body.style.margin = "0";
    document.body.style.padding = "0";

    return () => {
      document.body.style.margin = previousBodyMargin;
      document.body.style.padding = previousBodyPadding;
    };
  }, []);

  const indicator = statusData?.status?.indicator || "unknown";
  const description =
    statusData?.status?.description || "No description provided";
  const visual = statusVisual(indicator);
  const hasNoActiveIssues = unresolvedIncidents.length === 0;
  const hasActiveMaintenance = activeMaintenances.length > 0;
  const hasUpcomingMaintenance = upcomingMaintenances.length > 0;

  return (
    <div className={classes.card}>
      {isLoading && (
        <Typography className={classes.section}>
          Loading latest status data...
        </Typography>
      )}

      {!isLoading && error && (
        <Typography className={classes.section}>
          Unable to load status data: {error}
        </Typography>
      )}

      {!isLoading && !error && (
        <>
          <div className={classes.headerRow}>
            <span
              className={classes.badge}
              style={{
                backgroundColor: visual.background,
                color: visual.color,
              }}
            >
              {visual.label}
            </span>
          </div>

          {/* Statuspage's own description ("All Systems Operational",
              "Minor Service Outage", ...) is accurate in every state,
              including the case where components are degraded but no
              incident has been opened yet - so render it as-is rather than
              deriving our own summary from incident counts. */}
          <Typography className={classes.statusDescription}>
            {description}
          </Typography>

          <Typography className={classes.statusDescription}>
            Last Updated: {formatDateTime(statusData?.page?.updated_at)}
          </Typography>

          {/* Each open incident: impact badge + name, lifecycle status,
              affected components (when the vendor tags them), the latest
              engineer-written update, and a link to the incident page.
              Capped at 3 so a bad day doesn't produce an endless card. */}
          {!hasNoActiveIssues && (
            <div className={classes.section}>
              <Typography className={classes.sectionTitle}>
                Active Incidents
              </Typography>
              {unresolvedIncidents.slice(0, 3).map((incident) => {
                const impactVisual = statusVisual(incident.impact);
                const latestUpdate = incident.incident_updates?.[0];
                const affected = componentNames(incident.components);

                return (
                  <div className={classes.detailGroup} key={incident.id}>
                    <Typography className={classes.detailText}>
                      <span
                        className={classes.badge}
                        style={{
                          backgroundColor: impactVisual.background,
                          color: impactVisual.color,
                        }}
                      >
                        {impactVisual.label}
                      </span>{" "}
                      {incident.name}
                    </Typography>
                    <Typography className={classes.updateText}>
                      {INCIDENT_STATUS_LABELS[incident.status] ||
                        incident.status}
                      {affected ? ` — Affects: ${affected}` : ""}
                    </Typography>
                    {latestUpdate?.body && (
                      <Typography className={classes.updateText}>
                        {truncateText(latestUpdate.body)}
                      </Typography>
                    )}
                    <Typography className={classes.updateText}>
                      Updated {formatDateTime(incident.updated_at)}
                      {incident.shortlink && (
                        <>
                          {" — "}
                          <TextLink href={incident.shortlink} target="_blank">
                            Details
                          </TextLink>
                        </>
                      )}
                    </Typography>
                  </div>
                );
              })}
              {unresolvedIncidents.length > 3 && (
                <Typography className={classes.detailText}>
                  +{unresolvedIncidents.length - 3} more active incident(s)
                </Typography>
              )}
            </div>
          )}

          {/* Names every system that isn't healthy right now, sourced from
              components.json. This answers "which system?" even when the
              incident itself has no tagged components (common on Ellucian's
              page, where the system is only named in the incident title). */}
          {nonOperationalComponents.length > 0 && (
            <div className={classes.section}>
              <Typography className={classes.sectionTitle}>
                Affected Systems
              </Typography>
              {nonOperationalComponents.slice(0, 6).map((component) => (
                <Typography className={classes.detailText} key={component.id}>
                  {component.name}:{" "}
                  {COMPONENT_STATUS_LABELS[component.status] ||
                    component.status}
                </Typography>
              ))}
              {nonOperationalComponents.length > 6 && (
                <Typography className={classes.detailText}>
                  +{nonOperationalComponents.length - 6} more affected system(s)
                </Typography>
              )}
            </div>
          )}

          {hasActiveMaintenance && (
            <div className={classes.section}>
              <Typography className={classes.sectionTitle}>
                Active Maintenance
              </Typography>
              {activeMaintenances.slice(0, 3).map((maintenance) => (
                <div className={classes.detailGroup} key={maintenance.id}>
                  <Typography className={classes.detailText}>
                    {maintenance.name}
                  </Typography>
                  {componentNames(maintenance.components) && (
                    <Typography className={classes.updateText}>
                      Affects: {componentNames(maintenance.components)}
                    </Typography>
                  )}
                  <Typography className={classes.detailText}>
                    Through {formatDateTime(maintenance.scheduled_until)}
                  </Typography>
                </div>
              ))}
              {activeMaintenances.length > 3 && (
                <Typography className={classes.detailText}>
                  +{activeMaintenances.length - 3} more active maintenance
                  event(s)
                </Typography>
              )}
            </div>
          )}

          {!hasActiveMaintenance && (
            <div className={classes.section}>
              <Typography className={classes.compactRow}>
                Active maintenance: none.
              </Typography>
            </div>
          )}

          {hasUpcomingMaintenance && (
            <div className={classes.section}>
              <Typography className={classes.sectionTitle}>
                Upcoming Maintenance
              </Typography>
              {upcomingMaintenances.slice(0, 3).map((maintenance) => (
                <div className={classes.detailGroup} key={maintenance.id}>
                  <Typography className={classes.detailText}>
                    {maintenance.name}
                  </Typography>
                  {componentNames(maintenance.components) && (
                    <Typography className={classes.updateText}>
                      Affects: {componentNames(maintenance.components)}
                    </Typography>
                  )}
                  <Typography className={classes.detailText}>
                    Starts {formatDateTime(maintenance.scheduled_for)}
                  </Typography>
                </div>
              ))}
              {upcomingMaintenances.length > 3 && (
                <Typography className={classes.detailText}>
                  +{upcomingMaintenances.length - 3} more upcoming maintenance
                  event(s)
                </Typography>
              )}
            </div>
          )}

          {!hasUpcomingMaintenance && (
            <div className={classes.section}>
              <Typography className={classes.compactRow}>
                Upcoming maintenance: none scheduled.
              </Typography>
            </div>
          )}
        </>
      )}

      <Typography className={classes.linkRow}>
        <TextLink href={apiBaseUrl.replace("/api/v2", "")} target="_blank">
          View full status page
        </TextLink>
      </Typography>
      <div className={classes.footer}>
        <Typography>
          {lastFetchedAt ? `Fetched ${formatDateTime(lastFetchedAt)}` : ""}
        </Typography>
      </div>
    </div>
  );
};

export default EllucianStatus;
