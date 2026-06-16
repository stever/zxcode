import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Titled } from "react-titled";
import { Card } from "primereact/card";
import { Avatar } from "primereact/avatar";
import { ProgressSpinner } from "primereact/progressspinner";
import { Message } from "primereact/message";
import { Paginator } from "primereact/paginator";
import gql from "graphql-tag";
import { gqlFetch } from "../graphql_fetch";
import { sep } from "../constants";
import { formatDistanceToNow } from "date-fns";
import { generateRetroAvatar } from "../lib/avatar";

const GET_PUBLIC_PROFILES = gql`
  query GetPublicProfiles($limit: Int!, $offset: Int!) {
    user_aggregate(where: { profile_is_public: { _eq: true } }) {
      aggregate {
        count
      }
    }
    user(
      where: { profile_is_public: { _eq: true } }
      order_by: { created_at: desc }
      limit: $limit
      offset: $offset
    ) {
      user_id
      greeting_name
      slug
      bio
      created_at
      avatar_variant
      custom_avatar_data
      followers_aggregate {
        aggregate {
          count
        }
      }
    }
  }
`;

function ProfileCard({ user }) {
  return (
    <Link to={`/u/${user.slug || user.user_id}`} className="no-underline">
      <Card
        className="h-full hover:shadow-5 transition-all transition-duration-200 cursor-pointer card-bg-dark"
        style={{ border: "none" }}
      >
        <div className="flex align-items-center">
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
          <div className="flex-1">
            <h4 className="m-0 mb-1 text-white">{user.greeting_name}</h4>
            <p className="text-500 m-0 text-sm">@{user.slug}</p>
            {user.bio && (
              <p className="text-400 m-0 mt-2 text-sm">{user.bio}</p>
            )}
            <div className="text-400 text-sm mt-2">
              <span>
                {user.followers_aggregate?.aggregate?.count || 0} followers
              </span>
              <span className="mx-2">·</span>
              <span>
                Joined{" "}
                {formatDistanceToNow(new Date(user.created_at), {
                  addSuffix: true,
                })}
              </span>
            </div>
          </div>
        </div>
      </Card>
    </Link>
  );
}

export default function PublicProfiles() {
  const [profiles, setProfiles] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const pageSize = 20;

  useEffect(() => {
    const fetchProfiles = async () => {
      try {
        setLoading(true);
        const response = await gqlFetch(null, GET_PUBLIC_PROFILES, {
          limit: pageSize,
          offset: page * pageSize,
        });
        setProfiles(response?.data?.user || []);
        setTotalCount(
          response?.data?.user_aggregate?.aggregate?.count || 0
        );
      } catch (err) {
        console.error("Failed to fetch public profiles:", err);
      } finally {
        setLoading(false);
      }
    };

    fetchProfiles();
  }, [page]);

  if (loading) {
    return (
      <div className="flex justify-content-center align-items-center spinner-container-centered">
        <ProgressSpinner />
      </div>
    );
  }

  return (
    <Titled title={(s) => `Public Profiles ${sep} ${s}`}>
      <div className="m-2">
        <Card title="Public Profiles">
          <p className="text-500 mb-4">
            Browse public profiles on ZX Play
            {totalCount > 0 && (
              <span className="ml-2">
                (showing {page * pageSize + 1} -{" "}
                {Math.min((page + 1) * pageSize, totalCount)} of {totalCount})
              </span>
            )}
          </p>

          {profiles.length > 0 ? (
            <>
              <div className="grid">
                {profiles.map((user) => (
                  <div key={user.user_id} className="col-12 md:col-6">
                    <ProfileCard user={user} />
                  </div>
                ))}
              </div>

              {totalCount > pageSize && (
                <Paginator
                  first={page * pageSize}
                  rows={pageSize}
                  totalRecords={totalCount}
                  onPageChange={(e) => setPage(e.page)}
                  className="mt-3"
                />
              )}
            </>
          ) : (
            <div className="text-center py-4">
              <i className="pi pi-users text-4xl text-300 mb-3" />
              <p className="text-500">No public profiles yet</p>
            </div>
          )}
        </Card>
      </div>
    </Titled>
  );
}
