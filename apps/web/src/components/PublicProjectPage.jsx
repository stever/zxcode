import React, { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useDispatch, useSelector } from "react-redux";
import { ProgressSpinner } from "primereact/progressspinner";
import { Message } from "primereact/message";
import { Card } from "primereact/card";
import gql from "graphql-tag";
import { gqlFetch } from "../graphql_fetch";
import { loadProject } from "../redux/project/actions";

const GET_PROJECT_BY_SLUGS = gql`
  query GetProjectBySlugs($userSlug: String!, $projectSlug: String!) {
    user(where: { slug: { _eq: $userSlug } }, limit: 1) {
      user_id
      slug
      profile_is_public
      projects(where: { slug: { _eq: $projectSlug } }, limit: 1) {
        project_id
        title
        slug
        is_public
        lang
        code
      }
    }
  }
`;

export default function PublicProjectPage() {
  const { userSlug, projectSlug } = useParams();
  const navigate = useNavigate();
  const dispatch = useDispatch();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const currentUserId = useSelector(state => state?.identity.userId);

  useEffect(() => {
    fetchProject();
  }, [userSlug, projectSlug]);

  const fetchProject = async () => {
    try {
      setLoading(true);
      setError(null);

      const response = await gqlFetch(null, GET_PROJECT_BY_SLUGS, {
        userSlug,
        projectSlug
      });

      const user = response?.data?.user?.[0];
      const project = user?.projects?.[0];

      if (!user) {
        setError("User not found");
        return;
      }

      if (!project) {
        setError("Project not found");
        return;
      }

      // Check if project is public or user owns it
      const isOwner = currentUserId && user.user_id === currentUserId;
      if (!project.is_public && !isOwner) {
        setError("This project is private");
        return;
      }

      // Redirect to the main project page which will load the project
      // This ensures all the project functionality works correctly
      dispatch(loadProject(project.project_id));
      navigate(`/projects/${project.project_id}`, { replace: true });

    } catch (err) {
      console.error("Failed to fetch project:", err);
      setError("Failed to load project");
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-content-center align-items-center" style={{ minHeight: "400px" }}>
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

  return null; // Will redirect before reaching here
}