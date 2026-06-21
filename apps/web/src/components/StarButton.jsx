import React, { useEffect, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { useNavigate } from "react-router-dom";
import gql from "graphql-tag";
import { gqlFetch } from "../graphql_fetch";
import { starProject, unstarProject } from "../redux/stars/actions";
import { useTranslation } from "@zxplay/i18n";

// Fetches the total star count for a project plus, when the viewer is logged in,
// whether they have starred it. The `mine` selection is only included for
// authenticated viewers so anonymous reads stay within the `public` role.
const GET_STAR_STATE = gql`
  query GetProjectStarState(
    $project_id: uuid!
    $user_id: uuid!
    $includeMine: Boolean!
  ) {
    project_star_aggregate(where: { project_id: { _eq: $project_id } }) {
      aggregate {
        count
      }
    }
    mine: project_star(
      where: { project_id: { _eq: $project_id }, user_id: { _eq: $user_id } }
    ) @include(if: $includeMine) {
      user_id
    }
  }
`;

/**
 * A star/favourite toggle for a project. Self-contained: it loads its own count
 * and starred state for the given projectId, so it can be dropped onto project
 * cards, the project page, or anywhere else without threading data through the
 * surrounding query. Toggling is optimistic and persisted via redux sagas.
 */
export default function StarButton({ projectId, className, onToggle }) {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const currentUserId = useSelector((state) => state?.identity.userId);
  // Saga dispatches setStarredStatus once a star/unstar mutation commits; we key
  // off it to reconcile a freshly-mounted button (e.g. a newly added starred
  // card) with the DB, avoiding a stale read if it mounted mid-mutation.
  const persistedStarred = useSelector(
    (state) => state?.stars?.starredStatus?.[projectId]
  );

  const [starred, setStarred] = useState(false);
  const [count, setCount] = useState(0);

  // Load star state on mount, when the viewer's identity resolves (logging in
  // must reflect their own starred state), and when a mutation commits.
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;

    const fetchState = async () => {
      try {
        const response = await gqlFetch(currentUserId || null, GET_STAR_STATE, {
          project_id: projectId,
          user_id: currentUserId || "00000000-0000-0000-0000-000000000000",
          includeMine: !!currentUserId,
        });
        if (cancelled) return;
        const total =
          response?.data?.project_star_aggregate?.aggregate?.count || 0;
        const mine = (response?.data?.mine?.length || 0) > 0;
        setCount(total);
        setStarred(mine);
      } catch (e) {
        // Non-fatal: the button simply shows a zero count.
      }
    };

    fetchState();
    return () => {
      cancelled = true;
    };
  }, [projectId, currentUserId, persistedStarred]);

  const handleToggle = (e) => {
    // Star buttons frequently live inside clickable cards/links; never let the
    // toggle trigger navigation.
    e.preventDefault();
    e.stopPropagation();

    if (!currentUserId) return;

    if (starred) {
      dispatch(unstarProject(projectId));
      setStarred(false);
      setCount((c) => Math.max(0, c - 1));
      if (onToggle) onToggle(projectId, false);
    } else {
      dispatch(starProject(projectId));
      setStarred(true);
      setCount((c) => c + 1);
      if (onToggle) onToggle(projectId, true);
    }
  };

  const openStargazers = (e) => {
    e.preventDefault();
    e.stopPropagation();
    navigate(`/projects/${projectId}/stars`);
  };

  const toggleTitle = !currentUserId
    ? t("stars.loginToStar")
    : starred
    ? t("stars.unstar")
    : t("stars.star");

  // A GitHub-style split button: the star toggle and the count are joined into
  // one outlined control, divided by a shared border. The star toggles; the
  // count navigates to the stargazers page. Custom (rather than PrimeReact's
  // SplitButton, which is a button + dropdown menu).
  const segment = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: "transparent",
    border: "none",
    padding: "0.3rem 0.45rem",
    fontSize: "0.8rem",
    lineHeight: 1,
  };

  return (
    <span
      className={`inline-flex ${className || ""}`}
      style={{
        border: "1px solid #6c757d",
        borderRadius: "6px",
        overflow: "hidden",
        alignItems: "stretch",
      }}
    >
      <button
        type="button"
        onClick={handleToggle}
        disabled={!currentUserId}
        title={toggleTitle}
        aria-pressed={starred}
        aria-label={toggleTitle}
        style={{
          ...segment,
          borderRight: "1px solid #6c757d",
          color: starred ? "#f5c518" : "#c0c0c0",
          cursor: currentUserId ? "pointer" : "default",
        }}
      >
        <i
          className={`pi ${starred ? "pi-star-fill" : "pi-star"}`}
          style={{ display: "block", fontSize: "0.8rem" }}
        />
      </button>
      <button
        type="button"
        onClick={openStargazers}
        title={t("stars.viewStargazers")}
        aria-label={t("stars.viewStargazers")}
        style={{
          ...segment,
          color: "#c0c0c0",
          fontWeight: 700,
          cursor: "pointer",
        }}
      >
        {count}
      </button>
    </span>
  );
}
