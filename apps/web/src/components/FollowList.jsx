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
import gql from "graphql-tag";
import { gqlFetch } from "../graphql_fetch";
import { sep } from "../constants";
import { formatDistanceToNow } from "date-fns";
import { followUser, unfollowUser } from "../redux/social/actions";

const GET_USER_WITH_FOLLOWS = gql`
  query GetUserWithFollows($slug: String!) {
    user(where: { slug: { _eq: $slug } }, limit: 1) {
      user_id
      greeting_name
      slug
      followers {
        follower {
          user_id
          greeting_name
          slug
          bio
          created_at
        }
      }
      following {
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
    user_follows(where: {
      follower_id: {_eq: $follower_id},
      following_id: {_in: $user_ids}
    }) {
      following_id
    }
  }
`;

function UserCard({ user, isFollowing, onFollowToggle, currentUserId }) {
  const navigate = useNavigate();
  const isOwnProfile = currentUserId === user.user_id;

  return (
    <Card className="mb-3">
      <div className="flex align-items-center justify-content-between">
        <div className="flex align-items-center">
          <Avatar
            label={user.greeting_name?.[0]?.toUpperCase() || "?"}
            size="large"
            shape="circle"
            className="mr-3"
            style={{
              backgroundColor: "#6366f1",
              color: "white",
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
              size="small"
            />
          )}
          <span className="text-400 text-sm mt-2">
            Joined {formatDistanceToNow(new Date(user.created_at), { addSuffix: true })}
          </span>
        </div>
      </div>
    </Card>
  );
}

export default function FollowList() {
  const { slug, type } = useParams();
  const navigate = useNavigate();
  const dispatch = useDispatch();

  const [user, setUser] = useState(null);
  const [followers, setFollowers] = useState([]);
  const [following, setFollowing] = useState([]);
  const [followingStatus, setFollowingStatus] = useState({});
  const [loading, setLoading] = useState(true);
  const [activeIndex, setActiveIndex] = useState(type === "following" ? 1 : 0);

  const currentUserId = useSelector((state) => state?.identity.userId);

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);

        // Fetch user with followers and following
        const response = await gqlFetch(null, GET_USER_WITH_FOLLOWS, { slug });
        const userData = response?.data?.user?.[0];

        if (!userData) {
          setUser(null);
          return;
        }

        setUser(userData);
        setFollowers(userData.followers?.map(f => f.follower) || []);
        setFollowing(userData.following?.map(f => f.following) || []);

        // Check following status for all users if logged in
        if (currentUserId) {
          const allUserIds = [
            ...userData.followers?.map(f => f.follower.user_id) || [],
            ...userData.following?.map(f => f.following.user_id) || []
          ];

          if (allUserIds.length > 0) {
            const statusResponse = await gqlFetch(
              currentUserId,
              CHECK_FOLLOWING_STATUS,
              {
                follower_id: currentUserId,
                user_ids: [...new Set(allUserIds)]
              }
            );

            const followingIds = statusResponse?.data?.user_follows?.map(f => f.following_id) || [];
            const statusMap = {};
            followingIds.forEach(id => {
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
  }, [slug, currentUserId]);

  const handleFollowToggle = async (userId) => {
    if (!currentUserId) return;

    const isCurrentlyFollowing = followingStatus[userId];

    // Optimistic update
    setFollowingStatus(prev => ({
      ...prev,
      [userId]: !isCurrentlyFollowing
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
    <Titled title={(s) => `${displayName}'s ${type || 'Followers'} ${sep} ${s}`}>
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
              header={`Followers (${followers.length})`}
              leftIcon="pi pi-users"
            >
              {followers.length > 0 ? (
                <div>
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
              ) : (
                <div className="text-center py-4">
                  <i className="pi pi-users text-4xl text-300 mb-3" />
                  <p className="text-500">No followers yet</p>
                </div>
              )}
            </TabPanel>

            <TabPanel
              header={`Following (${following.length})`}
              leftIcon="pi pi-user-plus"
            >
              {following.length > 0 ? (
                <div>
                  {following.map((followedUser) => (
                    <UserCard
                      key={followedUser.user_id}
                      user={followedUser}
                      isFollowing={followingStatus[followedUser.user_id] || false}
                      onFollowToggle={handleFollowToggle}
                      currentUserId={currentUserId}
                    />
                  ))}
                </div>
              ) : (
                <div className="text-center py-4">
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