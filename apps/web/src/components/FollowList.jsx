import React, { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useSelector, useDispatch } from "react-redux";
import { Titled } from "react-titled";
import { Card } from "primereact/card";
import { Button } from "primereact/button";
import { Avatar } from "primereact/avatar";
import { ProgressSpinner } from "primereact/progressspinner";
import { Message } from "primereact/message";
import { TabView, TabPanel } from "primereact/tabview";
import { Paginator } from "primereact/paginator";
import gql from "graphql-tag";
import { gqlFetch } from "../graphql_fetch";
import { sep } from "../constants";
import { formatDistanceToNow } from "date-fns";
import { followUser, unfollowUser } from "../redux/social/actions";
import { generateRetroAvatar } from "../lib/avatar";

const GET_USER_WITH_FOLLOWS = gql`
  query GetUserWithFollows(
    $slug: String!
    $followersLimit: Int!
    $followersOffset: Int!
    $followingLimit: Int!
    $followingOffset: Int!
  ) {
    user(where: { slug: { _eq: $slug } }, limit: 1) {
      user_id
      greeting_name
      slug
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
      followers(
        limit: $followersLimit
        offset: $followersOffset
        order_by: { created_at: desc }
      ) {
        follower {
          user_id
          greeting_name
          slug
          bio
          created_at
        }
      }
      following(
        limit: $followingLimit
        offset: $followingOffset
        order_by: { created_at: desc }
      ) {
        following {
          user_id
          greeting_name
          slug
          bio
          created_at
        }
      }
    }
  }
`;

const CHECK_FOLLOWING_STATUS = gql`
  query CheckFollowingStatus($follower_id: uuid!, $user_ids: [uuid!]) {
    user_follows(
      where: {
        follower_id: { _eq: $follower_id }
        following_id: { _in: $user_ids }
      }
    ) {
      following_id
    }
  }
`;

function UserCard({ user, isFollowing, onFollowToggle, currentUserId }) {
  const navigate = useNavigate();
  const isOwnProfile = currentUserId === user.user_id;

  return (
    <Card className="mb-3" style={{ backgroundColor: "#2c2c2c" }}>
      <div className="flex align-items-center justify-content-between">
        <div className="flex align-items-center">
          <Avatar
            image={generateRetroAvatar(user.slug || user.user_id, 64)}
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
            <Link to={`/u/${user.slug}`} className="no-underline">
              <h4 className="m-0 mb-1">{user.greeting_name}</h4>
            </Link>
            <p className="text-500 m-0 text-sm">@{user.slug}</p>
            {user.bio && (
              <p className="text-400 m-0 mt-2 text-sm">{user.bio}</p>
            )}
          </div>
        </div>
        <div className="flex flex-column align-items-end">
          {!isOwnProfile && currentUserId && (
            <Button
              label={isFollowing ? "Unfollow" : "Follow"}
              icon={isFollowing ? "pi pi-user-minus" : "pi pi-user-plus"}
              onClick={() => onFollowToggle(user.user_id)}
              severity={isFollowing ? "secondary" : "primary"}
              outlined={isFollowing}
              size="small"
              style={
                isFollowing ? { color: "#6c757d", borderColor: "#6c757d" } : {}
              }
            />
          )}
          <span className="text-400 text-sm mt-2">
            Joined{" "}
            {formatDistanceToNow(new Date(user.created_at), {
              addSuffix: true,
            })}
          </span>
        </div>
      </div>
    </Card>
  );
}

export default function FollowList() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const dispatch = useDispatch();

  // Determine the type from the URL path
  const type = window.location.pathname.includes("/following")
    ? "following"
    : "followers";

  const [user, setUser] = useState(null);
  const [followers, setFollowers] = useState([]);
  const [following, setFollowing] = useState([]);
  const [followingStatus, setFollowingStatus] = useState({});
  const [loading, setLoading] = useState(true);
  const [activeIndex, setActiveIndex] = useState(type === "following" ? 1 : 0);

  // Pagination states
  const [followersPage, setFollowersPage] = useState(0);
  const [followingPage, setFollowingPage] = useState(0);
  const [totalFollowers, setTotalFollowers] = useState(0);
  const [totalFollowing, setTotalFollowing] = useState(0);
  const rowsPerPage = 10;

  const currentUserId = useSelector((state) => state?.identity.userId);

  // Update activeIndex when type changes
  useEffect(() => {
    setActiveIndex(type === "following" ? 1 : 0);
  }, [type]);

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);

        // Fetch user with followers and following
        const response = await gqlFetch(null, GET_USER_WITH_FOLLOWS, {
          slug,
          followersLimit: rowsPerPage,
          followersOffset: followersPage * rowsPerPage,
          followingLimit: rowsPerPage,
          followingOffset: followingPage * rowsPerPage,
        });
        const userData = response?.data?.user?.[0];

        if (!userData) {
          setUser(null);
          return;
        }

        setUser(userData);
        setFollowers(userData.followers?.map((f) => f.follower) || []);
        setFollowing(userData.following?.map((f) => f.following) || []);
        setTotalFollowers(userData.followers_aggregate?.aggregate?.count || 0);
        setTotalFollowing(userData.following_aggregate?.aggregate?.count || 0);

        // Check following status for all users if logged in
        if (currentUserId) {
          const allUserIds = [
            ...(userData.followers?.map((f) => f.follower.user_id) || []),
            ...(userData.following?.map((f) => f.following.user_id) || []),
          ];

          if (allUserIds.length > 0) {
            const statusResponse = await gqlFetch(
              currentUserId,
              CHECK_FOLLOWING_STATUS,
              {
                follower_id: currentUserId,
                user_ids: [...new Set(allUserIds)],
              }
            );

            const followingIds =
              statusResponse?.data?.user_follows?.map((f) => f.following_id) ||
              [];
            const statusMap = {};
            followingIds.forEach((id) => {
              statusMap[id] = true;
            });
            setFollowingStatus(statusMap);
          }
        }
      } catch (err) {
        console.error("Failed to fetch follow data:", err);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [slug, currentUserId, followersPage, followingPage]);

  const handleFollowToggle = async (userId) => {
    if (!currentUserId) return;

    const isCurrentlyFollowing = followingStatus[userId];

    // Optimistic update
    setFollowingStatus((prev) => ({
      ...prev,
      [userId]: !isCurrentlyFollowing,
    }));

    // Dispatch action
    if (isCurrentlyFollowing) {
      dispatch(unfollowUser(userId));
    } else {
      dispatch(followUser(userId));
    }
  };

  const handleTabChange = (e) => {
    setActiveIndex(e.index);
    const newType = e.index === 0 ? "followers" : "following";
    navigate(`/u/${slug}/${newType}`, { replace: true });
  };

  if (loading) {
    return (
      <div
        className="flex justify-content-center align-items-center"
        style={{ minHeight: "400px" }}
      >
        <ProgressSpinner />
      </div>
    );
  }

  if (!user) {
    return (
      <Card className="m-2">
        <Message severity="warn" text="User not found" />
      </Card>
    );
  }

  const displayName = user.greeting_name || "User";

  return (
    <Titled
      title={(s) => `${displayName}'s ${type || "Followers"} ${sep} ${s}`}
    >
      <div className="m-2">
        <Card>
          <div className="mb-4">
            <Link to={`/u/${slug}`} className="no-underline">
              <Button
                label="Back to Profile"
                icon="pi pi-arrow-left"
                severity="secondary"
                text
              />
            </Link>
          </div>

          <h2 className="mb-4">{displayName}'s Network</h2>

          <TabView activeIndex={activeIndex} onTabChange={handleTabChange}>
            <TabPanel
              header={`Followers (${totalFollowers})`}
              leftIcon="pi pi-users"
            >
              {followers.length > 0 ? (
                <>
                  <div className="mt-2">
                    {followers.map((follower) => (
                      <UserCard
                        key={follower.user_id}
                        user={follower}
                        isFollowing={followingStatus[follower.user_id] || false}
                        onFollowToggle={handleFollowToggle}
                        currentUserId={currentUserId}
                      />
                    ))}
                  </div>
                  {totalFollowers > rowsPerPage && (
                    <Paginator
                      first={followersPage * rowsPerPage}
                      rows={rowsPerPage}
                      totalRecords={totalFollowers}
                      onPageChange={(e) => setFollowersPage(e.page)}
                      className="mt-3"
                    />
                  )}
                </>
              ) : (
                <div className="text-center py-4 mt-2">
                  <i className="pi pi-users text-4xl text-300 mb-3" />
                  <p className="text-500">No followers yet</p>
                </div>
              )}
            </TabPanel>

            <TabPanel
              header={`Following (${totalFollowing})`}
              leftIcon="pi pi-user-plus"
            >
              {following.length > 0 ? (
                <>
                  <div className="mt-2">
                    {following.map((followedUser) => (
                      <UserCard
                        key={followedUser.user_id}
                        user={followedUser}
                        isFollowing={
                          followingStatus[followedUser.user_id] || false
                        }
                        onFollowToggle={handleFollowToggle}
                        currentUserId={currentUserId}
                      />
                    ))}
                  </div>
                  {totalFollowing > rowsPerPage && (
                    <Paginator
                      first={followingPage * rowsPerPage}
                      rows={rowsPerPage}
                      totalRecords={totalFollowing}
                      onPageChange={(e) => setFollowingPage(e.page)}
                      className="mt-3"
                    />
                  )}
                </>
              ) : (
                <div className="text-center py-4 mt-2">
                  <i className="pi pi-user-plus text-4xl text-300 mb-3" />
                  <p className="text-500">Not following anyone yet</p>
                </div>
              )}
            </TabPanel>
          </TabView>
        </Card>
      </div>
    </Titled>
  );
}
