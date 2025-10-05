import React, { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useSelector, useDispatch } from "react-redux";
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
import {
  followUser,
  unfollowUser,
  setFollowingStatus,
  setFollowCounts,
} from "../redux/social/actions";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
} from "@dnd-kit/sortable";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { getLanguageLabel } from "../lib/lang";
import { generateRetroAvatar } from "../lib/avatar";
import { generateRetroSpriteAvatar } from "../lib/retroSpriteAvatar";
import AvatarSelector from "./AvatarSelector";

const UPDATE_PROJECT_ORDER = gql`
  mutation UpdateProjectOrder($projectId: uuid!, $displayOrder: Int!) {
    update_project_by_pk(
      pk_columns: { project_id: $projectId }
      _set: { display_order: $displayOrder }
    ) {
      project_id
      display_order
    }
  }
`;

const UPDATE_USER_AVATAR = gql`
  mutation UpdateUserAvatar($user_id: uuid!, $avatar_variant: Int, $custom_avatar_data: jsonb) {
    update_user_by_pk(
      pk_columns: { user_id: $user_id }
      _set: { avatar_variant: $avatar_variant, custom_avatar_data: $custom_avatar_data }
    ) {
      user_id
      avatar_variant
      custom_avatar_data
    }
  }
`;

const GET_USER_BY_SLUG = gql`
  query GetUserBySlug($slug: String!) {
    user(where: { slug: { _eq: $slug } }, limit: 1) {
      user_id
      greeting_name
      bio
      created_at
      profile_is_public
      slug
      avatar_variant
      custom_avatar_data
      projects(
        where: { is_public: { _eq: true } }
        order_by: [{ display_order: asc }, { updated_at: desc }]
      ) {
        project_id
        title
        slug
        lang
        updated_at
        created_at
        display_order
      }
      followers {
        follower_id
      }
      following {
        following_id
      }
      followers {
        follower_id
      }
    }
  }
`;

const GET_USER_BY_ID = gql`
  query GetUserById($user_id: uuid!) {
    user_by_pk(user_id: $user_id) {
      user_id
      greeting_name
      bio
      created_at
      profile_is_public
      slug
      avatar_variant
      custom_avatar_data
      projects(
        where: { is_public: { _eq: true } }
        order_by: [{ display_order: asc }, { updated_at: desc }]
      ) {
        project_id
        title
        slug
        lang
        updated_at
        created_at
        display_order
      }
      followers {
        follower_id
      }
      following {
        following_id
      }
      followers {
        follower_id
      }
    }
  }
`;

// Sortable project card component for drag and drop
function SortableProjectCard({ project, projectUrl, isDragging }) {
  const navigate = useNavigate();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging: isSortableDragging,
  } = useSortable({ id: project.project_id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    flexBasis: "448px",
    flexGrow: 0,
    flexShrink: 0,
    opacity: isSortableDragging ? 0.5 : 1,
  };

  const handleCardClick = (e) => {
    // Don't navigate if clicking on the drag handle
    if (e.target.closest('[data-drag-handle="true"]')) {
      return;
    }
    navigate(projectUrl);
  };

  return (
    <div ref={setNodeRef} style={style}>
      <Card
        className="h-full hover:shadow-5 transition-all transition-duration-200 cursor-pointer card-bg-dark"
        style={{
          border: "none",
          position: "relative",
          overflow: "visible",
        }}
        onClick={handleCardClick}
      >
        {/* Drag handle in absolute top-right corner */}
        <div
          {...attributes}
          {...listeners}
          data-drag-handle="true"
          className="absolute"
          style={{
            top: "-10px",
            right: "-10px",
            cursor: isSortableDragging ? "grabbing" : "grab",
            backgroundColor: "#1a1a1a",
            borderRadius: "50%",
            width: "28px",
            height: "28px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 10,
            border: "2px solid #3a3a3a",
          }}
          title="Drag to reorder"
          onClick={(e) => e.stopPropagation()}
        >
          <i
            className="pi pi-arrows-alt"
            style={{ fontSize: "12px", color: "#aaa" }}
          />
        </div>
        <div className="flex flex-column h-full relative">
          <div
            className="absolute"
            style={{
              top: "-5px",
              right: "-5px",
              width: "120px",
              height: "120px",
              background: "#000",
              borderRadius: "20px",
              transform: "rotate(12deg)",
              overflow: "hidden",
              opacity: 0.7,
            }}
          >
            <img
              src="/assets/images/zx-square.png"
              alt=""
              style={{
                width: "94%",
                height: "94%",
                objectFit: "cover",
                margin: "3%",
              }}
            />
          </div>

          <h3 className="mb-2 text-white relative z-1">{project.title}</h3>

          <Tag
            value={getLanguageLabel(project.lang)}
            severity={getLanguageColor(project.lang)}
            className="align-self-start mb-3 relative z-1"
          />

          <div className="mt-auto text-400 text-sm relative z-1">
            Updated{" "}
            {formatDistanceToNow(new Date(project.updated_at), {
              addSuffix: true,
            })}
          </div>
        </div>
      </Card>
    </div>
  );
}

function getLanguageColor(lang) {
  const colors = {
    asm: "purple",
    basic: "blue",
    bas2tap: "blue",
    c: "orange",
    sdcc: "orange",
    zmac: "purple",
    zxbasic: "green",
  };
  return colors[lang] || "gray";
}

export default function PublicUserProfile() {
  const { id } = useParams(); // This could be either slug or UUID
  const navigate = useNavigate();
  const dispatch = useDispatch();

  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isFollowing, setIsFollowing] = useState(false);
  const [followersCount, setFollowersCount] = useState(0);
  const [followingCount, setFollowingCount] = useState(0);
  const [projects, setProjects] = useState([]);
  const [isSaving, setIsSaving] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState(null);
  const [showAvatarSelector, setShowAvatarSelector] = useState(false);

  const currentUserId = useSelector((state) => state?.identity.userId);
  const currentUserSlug = useSelector((state) => state?.identity.userSlug);
  const isOwnProfile = currentUserId && user?.user_id === currentUserId;

  // Drag and drop sensors
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  useEffect(() => {
    // Clear old data when ID changes or when current user's slug updates
    setUser(null);
    setError(null);

    const fetchUserProfile = async () => {
      try {
        setLoading(true);
        setError(null);

        // Determine if ID is a UUID or slug
        const isUuid =
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            id
          );

        let response;
        if (isUuid) {
          response = await gqlFetch(null, GET_USER_BY_ID, {
            user_id: id,
          });
          const userData = response?.data?.user_by_pk;
          setUser(userData);
          setProjects(userData?.projects || []);

          // Set follow status and counts
          if (userData) {
            const isCurrentUserFollowing =
              userData.followers?.some(
                (f) => f.follower_id === currentUserId
              ) || false;
            setIsFollowing(isCurrentUserFollowing);
            setFollowersCount(userData.followers?.length || 0);
            setFollowingCount(userData.following?.length || 0);
          }

          // If we have a slug, redirect to the slug-based URL
          if (userData?.slug) {
            navigate(`/u/${userData.slug}`, { replace: true });
          }
        } else {
          response = await gqlFetch(null, GET_USER_BY_SLUG, {
            slug: id,
          });
          const userData = response?.data?.user?.[0] || null;
          setUser(userData);
          setProjects(userData?.projects || []);

          // Set follow status and counts
          if (userData) {
            const isCurrentUserFollowing =
              userData.followers?.some(
                (f) => f.follower_id === currentUserId
              ) || false;
            setIsFollowing(isCurrentUserFollowing);
            setFollowersCount(userData.followers?.length || 0);
            setFollowingCount(userData.following?.length || 0);
          }

          // If viewing own profile with outdated slug, redirect to new slug
          if (
            userData &&
            currentUserId === userData.user_id &&
            currentUserSlug &&
            currentUserSlug !== id
          ) {
            navigate(`/u/${currentUserSlug}`, { replace: true });
          }
        }
      } catch (err) {
        console.error("Failed to fetch user profile:", err);
        setError("Failed to load user profile");
      } finally {
        setLoading(false);
      }
    };

    fetchUserProfile();
  }, [id, currentUserSlug, currentUserId, navigate]);

  // Generate avatar URL when user data changes
  useEffect(() => {
    if (user) {
      const identifier = user.slug || user.user_id;
      setAvatarUrl(generateRetroAvatar(identifier, 120, user));
    }
  }, [user]);

  const handleAvatarSelect = async (variant) => {
    if (user) {
      const identifier = user.slug || user.user_id;

      if (variant === 'custom') {
        // Load custom avatar from localStorage
        try {
          const saved = localStorage.getItem(`custom_avatar_${identifier}`);
          if (saved) {
            const grid = JSON.parse(saved);
            // Generate SVG from saved grid
            const size = 120;
            const pixelSize = size / 8;
            const COLORS = [
              '#000000', '#0000D7', '#D70000', '#D700D7',
              '#00D700', '#00D7D7', '#D7D700', '#D7D7D7',
              '#0000FF', '#FF0000', '#FF00FF', '#00FF00',
              '#00FFFF', '#FFFF00', '#FFFFFF'
            ];

            let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`;
            svg += `<rect width="${size}" height="${size}" fill="${COLORS[0]}"/>`;

            for (let row = 0; row < 8; row++) {
              for (let col = 0; col < 8; col++) {
                const colorIndex = grid[row][col];
                if (colorIndex > 0) {
                  const color = COLORS[colorIndex];
                  svg += `<rect x="${col * pixelSize}" y="${row * pixelSize}" width="${pixelSize}" height="${pixelSize}" fill="${color}"/>`;
                }
              }
            }

            svg += '</svg>';
            const encoded = btoa(unescape(encodeURIComponent(svg)));
            const newAvatar = `data:image/svg+xml;base64,${encoded}`;
            setAvatarUrl(newAvatar);

            // Save to database with variant -1 for custom
            try {
              await gqlFetch(currentUserId, UPDATE_USER_AVATAR, {
                user_id: user.user_id,
                avatar_variant: -1,
                custom_avatar_data: grid
              });
              // Update local user state
              setUser({...user, avatar_variant: -1, custom_avatar_data: grid});
            } catch (error) {
              console.error('Failed to save custom avatar to database:', error);
            }
          }
        } catch (e) {
          console.error('Failed to load custom avatar:', e);
        }
      } else {
        // Generate new avatar with selected variant
        const newAvatar = generateRetroSpriteAvatar(identifier, 120, variant);
        setAvatarUrl(newAvatar);

        // Save to database
        try {
          await gqlFetch(currentUserId, UPDATE_USER_AVATAR, {
            user_id: user.user_id,
            avatar_variant: variant,
            custom_avatar_data: null
          });
          // Update local user state
          setUser({...user, avatar_variant: variant, custom_avatar_data: null});
        } catch (error) {
          console.error('Failed to save avatar to database:', error);
        }
      }
    }
  };

  const handleFollowToggle = () => {
    if (!currentUserId || !user) return;

    if (isFollowing) {
      dispatch(unfollowUser(user.user_id));
      setIsFollowing(false);
      setFollowersCount((prev) => Math.max(0, prev - 1));
    } else {
      dispatch(followUser(user.user_id));
      setIsFollowing(true);
      setFollowersCount((prev) => prev + 1);
    }
  };

  const handleDragEnd = async (event) => {
    const { active, over } = event;

    if (active.id !== over.id) {
      const oldIndex = projects.findIndex((p) => p.project_id === active.id);
      const newIndex = projects.findIndex((p) => p.project_id === over.id);

      const newProjects = arrayMove(projects, oldIndex, newIndex);

      // Update local state immediately for responsiveness
      setProjects(newProjects);

      try {
        setIsSaving(true);
        // Update each project's display order
        const updatePromises = newProjects.map((project, index) =>
          gqlFetch(currentUserId, UPDATE_PROJECT_ORDER, {
            projectId: project.project_id,
            displayOrder: index,
          })
        );
        await Promise.all(updatePromises);
      } catch (error) {
        console.error("Failed to update project order:", error);
        // Revert on error
        setProjects(projects);
      } finally {
        setIsSaving(false);
      }
    }
  };

  if (loading) {
    return (
      <div
        className="flex justify-content-center align-items-center min-height-400"
      >
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

  const displayName = user.greeting_name || "User";
  const memberSince = formatDistanceToNow(new Date(user.created_at), {
    addSuffix: true,
  });

  return (
    <Titled title={(s) => `${displayName} ${sep} ${s}`}>
      <div className="grid m-0">
        <div className="col-12 lg:col-3 pr-0">
          <Card>
            <div className="flex flex-column align-items-center text-center">
              <div className="relative">
                <Avatar
                  image={avatarUrl}
                  size="xlarge"
                  shape="square"
                  className="mb-3"
                  style={{
                    width: '120px',
                    height: '120px',
                    imageRendering: 'pixelated'
                  }}
                />
                {isOwnProfile && (
                  <div
                    className="absolute cursor-pointer"
                    style={{
                      top: '0',
                      left: '128px',
                      backgroundColor: '#1a1a1a',
                      borderRadius: '50%',
                      width: '28px',
                      height: '28px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      border: '2px solid #3a3a3a',
                    }}
                    onClick={() => setShowAvatarSelector(true)}
                    title="Change avatar"
                  >
                    <i
                      className="pi pi-cog"
                      style={{ fontSize: '12px', color: '#aaa' }}
                    />
                  </div>
                )}
              </div>
              <h2 className="m-0">{displayName}</h2>
              <p className="text-500 mb-3">@{user.slug}</p>

              {user.bio && <p className="line-height-3">{user.bio}</p>}

              <Divider />

              <div className="w-full">
                <div className="flex justify-content-between mb-2">
                  <span className="text-500">Member since:</span>
                  <span>{memberSince}</span>
                </div>
              </div>

              {!isOwnProfile && currentUserId && (
                <>
                  <Button
                    label={isFollowing ? "Unfollow" : "Follow"}
                    icon={isFollowing ? "pi pi-user-minus" : "pi pi-user-plus"}
                    className="w-full mb-2 mt-4"
                    onClick={handleFollowToggle}
                    severity={isFollowing ? "secondary" : "primary"}
                    outlined={isFollowing}
                    style={
                      isFollowing
                        ? { color: "#6c757d", borderColor: "#6c757d" }
                        : {}
                    }
                  />
                </>
              )}

              <div className="flex gap-2 mt-4">
                <button
                  className="flex-1 p-button p-component p-button-outlined p-button-secondary p-button-sm flex flex-column align-items-center py-2"
                  onClick={() => navigate(`/u/${user.slug}/followers`)}
                >
                  <i className="pi pi-users mb-1"></i>
                  <span className="font-bold text-lg">{followersCount}</span>
                  <span className="text-sm">Followers</span>
                </button>
                <button
                  className="flex-1 p-button p-component p-button-outlined p-button-secondary p-button-sm flex flex-column align-items-center py-2"
                  onClick={() => navigate(`/u/${user.slug}/following`)}
                >
                  <i className="pi pi-user-plus mb-1"></i>
                  <span className="font-bold text-lg">{followingCount}</span>
                  <span className="text-sm">Following</span>
                </button>
              </div>

              {isOwnProfile && (
                <>
                  <Divider />
                  <div className="w-full">
                    <Button
                      label="Edit Profile"
                      icon="pi pi-pencil"
                      className="w-full mb-2"
                      onClick={() => navigate("/settings/profile")}
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

        <div className="col-12 lg:col-9 pt-2">
          <Card
            title={
              <div className="flex align-items-center justify-content-between">
                <span>Public Projects ({projects?.length || 0})</span>
                {isOwnProfile && isSaving && (
                  <Tag
                    severity="info"
                    value="Saving order..."
                    icon="pi pi-spin pi-spinner"
                  />
                )}
              </div>
            }
          >
            {projects && projects.length > 0 ? (
              isOwnProfile ? (
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleDragEnd}
                >
                  <SortableContext
                    items={projects.map((p) => p.project_id)}
                    strategy={rectSortingStrategy}
                  >
                    <div className="flex flex-wrap gap-3">
                      {projects.map((project) => {
                        const projectUrl = project.slug
                          ? `/u/${user.slug}/${project.slug}`
                          : `/projects/${project.project_id}`;
                        return (
                          <SortableProjectCard
                            key={project.project_id}
                            project={project}
                            projectUrl={projectUrl}
                            isDragging={false}
                          />
                        );
                      })}
                    </div>
                  </SortableContext>
                </DndContext>
              ) : (
                <div className="flex flex-wrap gap-3">
                  {projects.map((project) => {
                    const projectUrl = project.slug
                      ? `/u/${user.slug}/${project.slug}`
                      : `/projects/${project.project_id}`;

                    return (
                      <div
                        key={project.project_id}
                        style={{
                          flexBasis: "448px",
                          flexGrow: 0,
                          flexShrink: 0,
                        }}
                      >
                        <Link to={projectUrl} className="no-underline">
                          <Card
                            className="h-full hover:shadow-5 transition-all transition-duration-200 cursor-pointer overflow-hidden card-bg-dark"
                            style={{
                              border: "none",
                            }}
                          >
                            <div className="flex flex-column h-full relative">
                              {/* Background icon in corner */}
                              <div
                                className="absolute"
                                style={{
                                  top: "-5px",
                                  right: "-5px",
                                  width: "120px",
                                  height: "120px",
                                  background: "#000",
                                  borderRadius: "20px",
                                  transform: "rotate(12deg)",
                                  overflow: "hidden",
                                  opacity: 0.7,
                                }}
                              >
                                <img
                                  src="/assets/images/zx-square.png"
                                  alt=""
                                  style={{
                                    width: "94%",
                                    height: "94%",
                                    objectFit: "cover",
                                    margin: "3%",
                                  }}
                                />
                              </div>

                              <h3 className="mb-2 text-white relative z-1">
                                {project.title}
                              </h3>

                              <Tag
                                value={getLanguageLabel(project.lang)}
                                severity={getLanguageColor(project.lang)}
                                className="align-self-start mb-3 relative z-1"
                              />

                              <div className="mt-auto text-400 text-sm relative z-1">
                                Updated{" "}
                                {formatDistanceToNow(
                                  new Date(project.updated_at),
                                  { addSuffix: true }
                                )}
                              </div>
                            </div>
                          </Card>
                        </Link>
                      </div>
                    );
                  })}
                </div>
              )
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

      {isOwnProfile && (
        <AvatarSelector
          visible={showAvatarSelector}
          onHide={() => setShowAvatarSelector(false)}
          identifier={user?.slug || user?.user_id}
          onSelect={handleAvatarSelect}
        />
      )}
    </Titled>
  );
}
