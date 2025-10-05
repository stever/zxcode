import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useSelector, useDispatch } from "react-redux";
import { Titled } from "react-titled";
import { Card } from "primereact/card";
import { InputText } from "primereact/inputtext";
import { InputTextarea } from "primereact/inputtextarea";
import { InputSwitch } from "primereact/inputswitch";
import { Button } from "primereact/button";
import { Message } from "primereact/message";
import { ProgressSpinner } from "primereact/progressspinner";
import { Divider } from "primereact/divider";
import gql from "graphql-tag";
import { gqlFetch } from "../graphql_fetch";
import { sep } from "../constants";
import { generateSlug, isValidSlug, isReservedSlug } from "../utils/slug";
import { getUserInfo } from "../redux/identity/actions";

const GET_USER_PROFILE = gql`
  query GetUserProfile($user_id: uuid!) {
    user_by_pk(user_id: $user_id) {
      user_id
      greeting_name
      full_name
      email_address
      bio
      profile_is_public
      slug
    }
  }
`;

const UPDATE_USER_PROFILE = gql`
  mutation UpdateUserProfile(
    $user_id: uuid!
    $greeting_name: String
    $full_name: String
    $email_address: String
    $bio: String
    $profile_is_public: Boolean!
    $slug: String!
  ) {
    update_user_by_pk(
      pk_columns: { user_id: $user_id }
      _set: {
        greeting_name: $greeting_name
        full_name: $full_name
        email_address: $email_address
        bio: $bio
        profile_is_public: $profile_is_public
        slug: $slug
      }
    ) {
      user_id
      slug
    }
  }
`;

const CHECK_SLUG_AVAILABILITY = gql`
  query CheckSlugAvailability($slug: String!, $user_id: uuid!) {
    user(
      where: {
        slug: { _eq: $slug },
        user_id: { _neq: $user_id }
      }
    ) {
      user_id
    }
  }
`;

export default function UserProfileSettings() {
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const userId = useSelector(state => state?.identity.userId);

  const [loading, setLoading] = useState(true);
  const [authChecked, setAuthChecked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [profile, setProfile] = useState({
    greeting_name: "",
    full_name: "",
    email_address: "",
    bio: "",
    profile_is_public: true,
    slug: ""
  });
  const [originalProfile, setOriginalProfile] = useState(null);
  const [slugError, setSlugError] = useState("");
  const [saveMessage, setSaveMessage] = useState(null);

  useEffect(() => {
    // Give auth time to load on page refresh
    const timer = setTimeout(() => {
      setAuthChecked(true);
    }, 1000);

    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (userId) {
      fetchProfile();
    } else if (authChecked && !userId) {
      // Only redirect after we've given auth time to load
      navigate("/");
    }
  }, [userId, authChecked]);

  const fetchProfile = async () => {
    try {
      setLoading(true);
      const response = await gqlFetch(userId, GET_USER_PROFILE, { user_id: userId });

      if (response?.data?.user_by_pk) {
        const userData = response.data.user_by_pk;
        const profileData = {
          greeting_name: userData.greeting_name || "",
          full_name: userData.full_name || "",
          email_address: userData.email_address || "",
          bio: userData.bio || "",
          profile_is_public: userData.profile_is_public,
          slug: userData.slug || ""
        };
        setProfile(profileData);
        setOriginalProfile(profileData);
      }
    } catch (error) {
      console.error("Failed to fetch profile:", error);
    } finally {
      setLoading(false);
    }
  };

  const validateSlug = async (slug) => {
    if (!slug) {
      setSlugError("URL slug is required");
      return false;
    }

    if (!isValidSlug(slug)) {
      setSlugError("Slug must be 3+ characters, lowercase letters, numbers, and hyphens only");
      return false;
    }

    if (isReservedSlug(slug)) {
      setSlugError("This URL is reserved and cannot be used");
      return false;
    }

    // Check if slug is available
    try {
      const response = await gqlFetch(userId, CHECK_SLUG_AVAILABILITY, {
        slug,
        user_id: userId
      });

      if (response?.data?.user?.length > 0) {
        setSlugError("This URL is already taken");
        return false;
      }
    } catch (error) {
      console.error("Failed to check slug availability:", error);
      setSlugError("Failed to verify URL availability");
      return false;
    }

    setSlugError("");
    return true;
  };

  const handleSlugChange = (value) => {
    const slug = generateSlug(value);
    setProfile({ ...profile, slug });
    setSlugError(""); // Clear error on change
  };

  const handleSave = async () => {
    // Validate slug if it changed
    if (profile.slug !== originalProfile.slug) {
      const isValid = await validateSlug(profile.slug);
      if (!isValid) return;
    }

    setSaving(true);
    setSaveMessage(null);

    try {
      const response = await gqlFetch(userId, UPDATE_USER_PROFILE, {
        user_id: userId,
        greeting_name: profile.greeting_name || null,
        full_name: profile.full_name || null,
        email_address: profile.email_address || null,
        bio: profile.bio || null,
        profile_is_public: profile.profile_is_public,
        slug: profile.slug
      });

      if (response?.data?.update_user_by_pk) {
        setOriginalProfile(profile);
        setSaveMessage({ severity: "success", text: "Profile updated successfully!" });

        // Refresh user info in Redux store to update navigation
        // Add small delay to ensure database update is complete
        setTimeout(() => {
          dispatch(getUserInfo());
        }, 500);

        // Clear success message after 3 seconds
        setTimeout(() => setSaveMessage(null), 3000);
      }
    } catch (error) {
      console.error("Failed to save profile:", error);
      setSaveMessage({ severity: "error", text: "Failed to save profile changes" });
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setProfile(originalProfile);
    setSlugError("");
    navigate(-1);
  };

  const hasChanges = JSON.stringify(profile) !== JSON.stringify(originalProfile);

  if (loading) {
    return (
      <div className="flex justify-content-center align-items-center min-height-400">
        <ProgressSpinner />
      </div>
    );
  }

  return (
    <Titled title={s => `Profile Settings ${sep} ${s}`}>
      <Card className="m-2">
        <h1>Profile Settings</h1>

        {saveMessage && (
          <Message
            severity={saveMessage.severity}
            text={saveMessage.text}
            className="mb-3 w-full"
          />
        )}

        <div className="p-fluid">
          <div className="field">
            <label htmlFor="greeting_name">Display Name</label>
            <InputText
              id="greeting_name"
              value={profile.greeting_name}
              onChange={(e) => setProfile({ ...profile, greeting_name: e.target.value })}
              placeholder="How you want to be greeted"
            />
            <small className="block mt-1">This is how you'll be addressed in the app</small>
          </div>

          <div className="field">
            <label htmlFor="full_name">Full Name</label>
            <InputText
              id="full_name"
              value={profile.full_name}
              onChange={(e) => setProfile({ ...profile, full_name: e.target.value })}
              placeholder="Your full name (optional)"
            />
          </div>

          <div className="field">
            <label htmlFor="email_address">Email Address</label>
            <InputText
              id="email_address"
              type="email"
              value={profile.email_address}
              onChange={(e) => setProfile({ ...profile, email_address: e.target.value })}
              placeholder="your@email.com (optional)"
            />
          </div>

          <div className="field">
            <label htmlFor="bio">Bio</label>
            <InputTextarea
              id="bio"
              value={profile.bio}
              onChange={(e) => setProfile({ ...profile, bio: e.target.value })}
              rows={4}
              maxLength={500}
              placeholder="Tell us about yourself..."
            />
            <small className="block mt-1">
              {profile.bio.length}/500 characters
            </small>
          </div>

          <Divider />

          <div className="field">
            <label htmlFor="slug">Profile URL</label>
            <div className="p-inputgroup">
              <span className="p-inputgroup-addon">{window.location.origin}/u/</span>
              <InputText
                id="slug"
                value={profile.slug}
                onChange={(e) => handleSlugChange(e.target.value)}
                className={slugError ? "p-invalid" : ""}
                placeholder="your-unique-url"
              />
            </div>
            {slugError && (
              <small className="p-error block mt-1">{slugError}</small>
            )}
            {!slugError && profile.slug && (
              <small className="block mt-1">
                Your profile will be at: {window.location.origin}/u/{profile.slug}
              </small>
            )}
          </div>

          <div className="field">
            <label htmlFor="profile_is_public">Public Profile</label>
            <div className="flex align-items-center gap-3">
              <InputSwitch
                id="profile_is_public"
                checked={profile.profile_is_public}
                onChange={(e) => setProfile({ ...profile, profile_is_public: e.value })}
              />
              <span>{profile.profile_is_public ? "Public" : "Private"}</span>
            </div>
            <small className="block mt-2">
              {profile.profile_is_public
                ? "Your profile and public projects are visible to everyone"
                : "Your profile is hidden from public view"}
            </small>
          </div>

          <Divider />

          <div className="flex justify-content-between align-items-center">
            <div>
              {profile.slug && (
                <Button
                  label="View Public Profile"
                  icon="pi pi-external-link"
                  className="p-button-text"
                  onClick={() => window.open(`/u/${profile.slug}`, "_blank")}
                />
              )}
            </div>
            <div className="flex gap-2">
              <Button
                label="Cancel"
                icon="pi pi-times"
                className="p-button-outlined"
                onClick={handleCancel}
              />
              <Button
                label="Save Changes"
                icon="pi pi-check"
                disabled={!hasChanges || !!slugError}
                loading={saving}
                onClick={handleSave}
                className="text-nowrap-min-160"
              />
            </div>
          </div>
        </div>
      </Card>
    </Titled>
  );
}