import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Titled } from "react-titled";
import { useTranslation, useDateFnsLocale } from "@zxplay/i18n";
import { Card } from "primereact/card";
import { Avatar } from "primereact/avatar";
import { Dropdown } from "primereact/dropdown";
import { InputSwitch } from "primereact/inputswitch";
import { ProgressSpinner } from "primereact/progressspinner";
import { Paginator } from "primereact/paginator";
import gql from "graphql-tag";
import { gqlFetch } from "../graphql_fetch";
import { sep } from "../constants";
import { formatDistanceToNow } from "date-fns";
import { generateRetroAvatar } from "../lib/avatar";

const GET_PUBLIC_PROFILES = gql`
  query GetPublicProfiles(
    $where: user_bool_exp!
    $orderBy: [user_order_by!]!
    $limit: Int!
    $offset: Int!
  ) {
    user_aggregate(where: $where) {
      aggregate {
        count
      }
    }
    user(where: $where, order_by: $orderBy, limit: $limit, offset: $offset) {
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
      following_aggregate {
        aggregate {
          count
        }
      }
      projects_aggregate(where: { is_public: { _eq: true } }) {
        aggregate {
          count
        }
      }
    }
  }
`;

const SORT_OPTIONS = [
  {
    label: "Recent activity",
    value: "recent",
    orderBy: [{ projects_aggregate: { max: { updated_at: "desc_nulls_last" } } }],
  },
  {
    label: "Most public projects",
    value: "projects",
    orderBy: [{ projects_aggregate: { count: "desc" } }],
  },
  {
    label: "Most followers",
    value: "followers",
    orderBy: [{ followers_aggregate: { count: "desc" } }],
  },
  {
    label: "Newest",
    value: "newest",
    orderBy: [{ created_at: "desc" }],
  },
];

function ProfileCard({ user }) {
  const { t } = useTranslation();
  const locale = useDateFnsLocale();
  const projectCount = user.projects_aggregate?.aggregate?.count || 0;
  const followerCount = user.followers_aggregate?.aggregate?.count || 0;
  const followingCount = user.following_aggregate?.aggregate?.count || 0;

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
            <h4 className="m-0 mb-1 text-white">
              {user.greeting_name || `@${user.slug}`}
            </h4>
            <p className="text-500 m-0 text-sm">@{user.slug}</p>
            {user.bio && (
              <p className="text-400 m-0 mt-2 text-sm">{user.bio}</p>
            )}
            <div className="text-400 text-sm mt-2">
              <span>{t("profiles.projectsCount", { count: projectCount })}</span>
              <span className="mx-2">·</span>
              <span>{t("profiles.followersCount", { count: followerCount })}</span>
              <span className="mx-2">·</span>
              <span>{t("profiles.followingCount", { count: followingCount })}</span>
              <span className="mx-2">·</span>
              <span>
                {t("follow.joined", {
                  when: formatDistanceToNow(new Date(user.created_at), {
                    addSuffix: true,
                    locale,
                  }),
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
  const { t } = useTranslation();
  const [profiles, setProfiles] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState("recent");
  const [hideEmpty, setHideEmpty] = useState(true);
  const [loading, setLoading] = useState(true);
  const pageSize = 20;

  useEffect(() => {
    const fetchProfiles = async () => {
      try {
        setLoading(true);

        const where = { profile_is_public: { _eq: true } };
        if (hideEmpty) {
          where.projects = { is_public: { _eq: true } };
        }

        const orderBy =
          SORT_OPTIONS.find((o) => o.value === sort)?.orderBy ||
          SORT_OPTIONS[0].orderBy;

        const response = await gqlFetch(null, GET_PUBLIC_PROFILES, {
          where,
          orderBy,
          limit: pageSize,
          offset: page * pageSize,
        });
        setProfiles(response?.data?.user || []);
        setTotalCount(response?.data?.user_aggregate?.aggregate?.count || 0);
      } catch (err) {
        console.error("Failed to fetch public profiles:", err);
      } finally {
        setLoading(false);
      }
    };

    fetchProfiles();
  }, [page, sort, hideEmpty]);

  return (
    <Titled title={(s) => `${t("profiles.title")} ${sep} ${s}`}>
      <div className="m-2">
        <Card title={t("profiles.title")}>
          <div className="flex flex-wrap align-items-center justify-content-between gap-3 mb-4">
            <p className="text-500 m-0">
              Browse public profiles on ZX Play
              {totalCount > 0 && (
                <span className="ml-2">
                  (showing {page * pageSize + 1} -{" "}
                  {Math.min((page + 1) * pageSize, totalCount)} of {totalCount})
                </span>
              )}
            </p>
            <div className="flex align-items-center gap-3">
              <div className="flex align-items-center gap-2">
                <InputSwitch
                  inputId="hideEmpty"
                  checked={hideEmpty}
                  onChange={(e) => {
                    setHideEmpty(e.value);
                    setPage(0);
                  }}
                />
                <label htmlFor="hideEmpty" className="text-500 text-sm">
                  Only with public projects
                </label>
              </div>
              <Dropdown
                value={sort}
                options={SORT_OPTIONS}
                style={{ width: "16rem" }}
                onChange={(e) => {
                  setSort(e.value);
                  setPage(0);
                }}
              />
            </div>
          </div>

          {loading ? (
            <div className="flex justify-content-center align-items-center py-6">
              <ProgressSpinner />
            </div>
          ) : profiles.length > 0 ? (
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
              <p className="text-500">{t("profiles.none")}</p>
            </div>
          )}
        </Card>
      </div>
    </Titled>
  );
}
