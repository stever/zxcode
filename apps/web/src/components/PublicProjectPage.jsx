import React, { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useDispatch, useSelector } from "react-redux";
import { ProgressSpinner } from "primereact/progressspinner";
import { Message } from "primereact/message";
import { Card } from "primereact/card";
import gql from "graphql-tag";
import { gqlFetch } from "../graphql_fetch";
import { loadProject } from "../redux/project/actions";
import ProjectPage from "./ProjectPage";

// Simple query to get project by slug
// Hasura's RLS will handle filtering to only show projects the current user can access
const GET_PROJECT_BY_SLUG = gql`
  query GetProjectBySlug($projectSlug: String!) {
    project(where: { slug: { _eq: $projectSlug } }, limit: 1) {
      project_id
      title
      slug
      is_public
      lang
      code
    }
  }
`;

export default function PublicProjectPage() {
  const { userSlug, projectSlug } = useParams();
  const navigate = useNavigate();
  const dispatch = useDispatch();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [projectId, setProjectId] = useState(null);

  const currentUserId = useSelector(state => state?.identity.userId);

  useEffect(() => {
    // Wait a moment for auth to initialize if needed
    if (currentUserId === undefined) {
      const timer = setTimeout(() => {
        fetchProject();
      }, 500);
      return () => clearTimeout(timer);
    } else {
      fetchProject();
    }
  }, [userSlug, projectSlug, currentUserId]);

  const fetchProject = async () => {
    try {
      setLoading(true);
      setError(null);

      // Fetch the specific project by slug
      const response = await gqlFetch(currentUserId || null, GET_PROJECT_BY_SLUG, {
        projectSlug
      });

      const project = response?.data?.project?.[0];

      if (!project) {
        if (!currentUserId) {
          setError("Please log in to view this project");
        } else {
          setError("Project not found");
        }
        return;
      }

      // Load the project with owner's slug from URL
      dispatch(loadProject(project.project_id, userSlug));
      setProjectId(project.project_id);

    } catch (err) {
      console.error("Failed to fetch project:", err);
      setError("Failed to load project");
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-content-center align-items-center min-height-400">
        <ProgressSpinner />
      </div>
    );
  }

  if (error) {
    return (
      <Card className="m-2">
        <Message severity="error" text={error} />
      </Card>
    );
  }

  // Render the ProjectPage with the loaded project ID
  if (projectId) {
    return <ProjectPage projectId={projectId} />;
  }

  return null;
}