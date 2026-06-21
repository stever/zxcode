import React, { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useSelector } from "react-redux";
import { Titled } from "react-titled";
import { Card } from "primereact/card";
import { Button } from "primereact/button";
import { Avatar } from "primereact/avatar";
import { ProgressSpinner } from "primereact/progressspinner";
import { Message } from "primereact/message";
import { Paginator } from "primereact/paginator";
import gql from "graphql-tag";
import { gqlFetch } from "../graphql_fetch";
import { sep } from "../constants";
import { formatDistanceToNow } from "date-fns";
import { generateRetroAvatar } from "../lib/avatar";
import { useTranslation, useDateFnsLocale } from "@zxplay/i18n";

// Public list of who starred a project. RLS hides stars on private projects from
// everyone but the owner, so this returns nothing for a private project viewed
// by others, and the project itself resolves to null.
const GET_STARGAZERS = gql`
  query GetProjectStargazers(
    $project_id: uuid!
    $limit: Int!
    $offset: Int!
  ) {
    project_by_pk(project_id: $project_id) {
      project_id
      title
      slug
      is_public
      user {
        slug
        greeting_name
      }
    }
    project_star_aggregate(where: { project_id: { _eq: $project_id } }) {
      aggregate {
        count
      }
    }
    project_star(
      where: { project_id: { _eq: $project_id } }
      order_by: { created_at: desc }
      limit: $limit
      offset: $offset
    ) {
      created_at
      user {
        user_id
        greeting_name
        slug
        bio
        avatar_variant
        custom_avatar_data
        created_at
      }
    }
  }
`;

const ROWS_PER_PAGE = 10;

function StargazerCard({ user }) {
  const { t } = useTranslation();
  const locale = useDateFnsLocale();
  const profileUrl = `/u/${user.slug || user.user_id}`;

  return (
    <Card className="mb-3 card-bg-dark">
      <Link
        to={profileUrl}
        className="flex align-items-center no-underline cursor-pointer"
        style={{ color: "inherit" }}
      >
        <Avatar
          image={generateRetroAvatar(user.slug || user.user_id, 64, user)}
          size="large"
          shape="square"
          className="mr-3"
          style={{
            width: "64px",
            height: "64px",
            imageRendering: "pixelated",
          }}
        />
        <div>
          <h4 className="m-0 mb-1">{user.greeting_name}</h4>
          <p className="text-500 m-0 text-sm">@{user.slug}</p>
          <span className="text-400 text-sm">
            {t("follow.joined", {
              when: formatDistanceToNow(new Date(user.created_at), {
                addSuffix: true,
                locale,
              }),
            })}
          </span>
        </div>
      </Link>
    </Card>
  );
}

export default function Stargazers() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const [loading, setLoading] = useState(true);
  const [project, setProject] = useState(null);
  const [users, setUsers] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);

  const currentUserId = useSelector((state) => state?.identity.userId);

  useEffect(() => {
    if (currentUserId === undefined) return; // wait until auth state is known
    let cancelled = false;

    const fetchData = async () => {
      try {
        setLoading(true);
        const response = await gqlFetch(currentUserId || null, GET_STARGAZERS, {
          project_id: id,
          limit: ROWS_PER_PAGE,
          offset: page * ROWS_PER_PAGE,
        });
        if (cancelled) return;
        setProject(response?.data?.project_by_pk || null);
        setUsers(
          (response?.data?.project_star || [])
            .map((s) => s.user)
            .filter(Boolean)
        );
        setTotal(response?.data?.project_star_aggregate?.aggregate?.count || 0);
      } catch (err) {
        if (!cancelled) {
          setProject(null);
          setUsers([]);
          setTotal(0);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchData();
    return () => {
      cancelled = true;
    };
  }, [id, currentUserId, page]);

  if (loading) {
    return (
      <div className="flex justify-content-center align-items-center spinner-container-centered">
        <ProgressSpinner />
      </div>
    );
  }

  if (!project) {
    return (
      <Card className="m-2">
        <Message severity="warn" text={t("stars.projectNotFound")} />
      </Card>
    );
  }

  const projectUrl =
    project.slug && project.user?.slug
      ? `/u/${project.user.slug}/${project.slug}`
      : `/projects/${project.project_id}`;

  return (
    <Titled
      title={(s) => `${t("stars.stargazers")} ${sep} ${project.title} ${sep} ${s}`}
    >
      <div className="m-2">
        <Card>
          <div className="mb-4">
            <Link to={projectUrl} className="no-underline">
              <Button
                label={t("stars.backToProject")}
                icon="pi pi-arrow-left"
                severity="secondary"
                text
              />
            </Link>
          </div>

          <h2 className="mb-1">{t("stars.stargazers")}</h2>
          <p className="text-500 mb-4">{project.title}</p>

          {users.length > 0 ? (
            <>
              {users.map((user) => (
                <StargazerCard key={user.user_id} user={user} />
              ))}
              {total > ROWS_PER_PAGE && (
                <Paginator
                  first={page * ROWS_PER_PAGE}
                  rows={ROWS_PER_PAGE}
                  totalRecords={total}
                  onPageChange={(e) => setPage(e.page)}
                  className="mt-3"
                />
              )}
            </>
          ) : (
            <div className="text-center py-4">
              <i className="pi pi-star text-4xl text-300 mb-3" />
              <p className="text-500">{t("stars.noStargazers")}</p>
            </div>
          )}
        </Card>
      </div>
    </Titled>
  );
}
