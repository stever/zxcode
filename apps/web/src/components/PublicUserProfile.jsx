import React, { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useSelector } from "react-redux";
import { Titled } from "react-titled";
import { Card } from "primereact/card";
import { Avatar } from "primereact/avatar";
import { Button } from "primereact/button";
import { Divider } from "primereact/divider";
import { Tag } from "primereact/tag";
import { ProgressSpinner } from "primereact/progressspinner";
import { Message } from "primereact/message";
import gql from "graphql-tag";
import { gqlFetch } from "../graphql_fetch";
import { sep } from "../constants";
import { formatDistanceToNow } from "date-fns";

const GET_USER_BY_SLUG = gql`
  query GetUserBySlug($slug: String!) {
    user(where: { slug: { _eq: $slug } }, limit: 1) {
      user_id
      username
      greeting_name
      bio
      created_at
      profile_is_public
      slug
      projects(
        where: { is_public: { _eq: true } }
        order_by: { updated_at: desc }
      ) {
        project_id
        title
        slug
        lang
        updated_at
        created_at
      }
    }
  }
`;

const GET_USER_BY_ID = gql`
  query GetUserById($user_id: uuid!) {
    user_by_pk(user_id: $user_id) {
      user_id
      username
      greeting_name
      bio
      created_at
      profile_is_public
      slug
      projects(
        where: { is_public: { _eq: true } }
        order_by: { updated_at: desc }
      ) {
        project_id
        title
        slug
        lang
        updated_at
        created_at
      }
    }
  }
`;

function getLanguageLabel(lang) {
  const labels = {
    'asm': 'Z80 Assembly',
    'basic': 'Sinclair BASIC',
    'bas2tap': 'Sinclair BASIC',
    'c': 'C (z88dk)',
    'sdcc': 'SDCC',
    'zmac': 'Z80 (zmac)',
    'zxbasic': 'Boriel ZX BASIC'
  };
  return labels[lang] || lang;
}

function getLanguageColor(lang) {
  const colors = {
    'asm': 'purple',
    'basic': 'blue',
    'bas2tap': 'blue',
    'c': 'orange',
    'sdcc': 'orange',
    'zmac': 'purple',
    'zxbasic': 'green'
  };
  return colors[lang] || 'gray';
}

export default function PublicUserProfile() {
  const { id } = useParams(); // This could be either slug or UUID
  const navigate = useNavigate();

  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const currentUserId = useSelector(state => state?.identity.userId);
  const isOwnProfile = currentUserId && user?.user_id === currentUserId;

  useEffect(() => {
    fetchUserProfile();
  }, [id]);

  const fetchUserProfile = async () => {
    try {
      setLoading(true);
      setError(null);

      // Determine if ID is a UUID or slug
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

      let response;
      if (isUuid) {
        response = await gqlFetch(null, GET_USER_BY_ID, { user_id: id });
        const userData = response?.data?.user_by_pk;
        setUser(userData);

        // If we have a slug, redirect to the slug-based URL
        if (userData?.slug) {
          navigate(`/u/${userData.slug}`, { replace: true });
        }
      } else {
        response = await gqlFetch(null, GET_USER_BY_SLUG, { slug: id });
        setUser(response?.data?.user?.[0] || null);
      }
    } catch (err) {
      console.error("Failed to fetch user profile:", err);
      setError("Failed to load user profile");
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

  if (!user) {
    return (
      <Card className="m-2">
        <Message severity="warn" text="User not found" />
      </Card>
    );
  }

  if (!user.profile_is_public && !isOwnProfile) {
    return (
      <Card className="m-2">
        <Message severity="info" text="This profile is private" />
      </Card>
    );
  }

  const displayName = user.greeting_name || user.username;
  const memberSince = formatDistanceToNow(new Date(user.created_at), { addSuffix: true });

  return (
    <Titled title={s => `${displayName} ${sep} ${s}`}>
      <div className="grid m-2">
        <div className="col-12 lg:col-3">
          <Card>
            <div className="flex flex-column align-items-center text-center">
              <Avatar
                label={displayName[0].toUpperCase()}
                size="xlarge"
                shape="circle"
                className="mb-3"
                style={{ backgroundColor: '#6366f1', color: 'white', fontSize: '2rem' }}
              />
              <h2 className="m-0">{displayName}</h2>
              <p className="text-500 mb-3">@{user.username}</p>

              {user.bio && (
                <p className="line-height-3">{user.bio}</p>
              )}

              <Divider />

              <div className="w-full">
                <div className="flex justify-content-between mb-2">
                  <span className="text-500">Member since:</span>
                  <span>{memberSince}</span>
                </div>
                <div className="flex justify-content-between mb-2">
                  <span className="text-500">Public projects:</span>
                  <span>{user.projects?.length || 0}</span>
                </div>
              </div>

              {isOwnProfile && (
                <>
                  <Divider />
                  <div className="w-full">
                    <Button
                      label="Edit Profile"
                      icon="pi pi-pencil"
                      className="w-full mb-2"
                      onClick={() => navigate('/settings/profile')}
                    />
                    {!user.profile_is_public && (
                      <Message
                        severity="warn"
                        text="Your profile is currently private"
                        className="w-full text-left"
                      />
                    )}
                  </div>
                </>
              )}
            </div>
          </Card>
        </div>

        <div className="col-12 lg:col-9">
          <Card title="Public Projects">
            {user.projects && user.projects.length > 0 ? (
              <div className="grid">
                {user.projects.map(project => {
                  const projectUrl = project.slug
                    ? `/u/${user.slug}/${project.slug}`
                    : `/projects/${project.project_id}`;

                  return (
                    <div key={project.project_id} className="col-12 md:col-6 lg:col-4">
                      <Card className="h-full hover:shadow-3 transition-all transition-duration-200">
                        <div className="flex flex-column h-full">
                          <h4 className="mb-2">
                            <Link
                              to={projectUrl}
                              className="text-color no-underline hover:text-primary"
                            >
                              {project.title}
                            </Link>
                          </h4>

                          <Tag
                            value={getLanguageLabel(project.lang)}
                            severity={getLanguageColor(project.lang)}
                            className="align-self-start mb-3"
                          />

                          <div className="mt-auto text-500 text-sm">
                            Updated {formatDistanceToNow(new Date(project.updated_at), { addSuffix: true })}
                          </div>
                        </div>
                      </Card>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-center py-4">
                <i className="pi pi-inbox text-4xl text-300 mb-3" />
                <p className="text-500">No public projects yet</p>
                {isOwnProfile && (
                  <p className="text-sm">
                    Make your projects public to display them here
                  </p>
                )}
              </div>
            )}
          </Card>
        </div>
      </div>
    </Titled>
  );
}