import React, { useState } from "react";
import { useDispatch } from "react-redux";
import { InputSwitch } from "primereact/inputswitch";
import { Button } from "primereact/button";
import { Dialog } from "primereact/dialog";
import { Message } from "primereact/message";
import gql from "graphql-tag";
import { gqlFetch } from "../graphql_fetch";

const UPDATE_PROJECT_VISIBILITY = gql`
  mutation ($project_id: uuid!, $is_public: Boolean!) {
    update_project_by_pk(
      pk_columns: { project_id: $project_id }
      _set: { is_public: $is_public }
    ) {
      project_id
      is_public
      slug
      user {
        slug
      }
    }
  }
`;

export default function ProjectVisibilityToggle({ project, userId }) {
  const [isPublic, setIsPublic] = useState(project?.is_public || false);
  const [showDialog, setShowDialog] = useState(false);
  const [shareUrl, setShareUrl] = useState("");
  const [updating, setUpdating] = useState(false);
  const [copied, setCopied] = useState(false);

  const dispatch = useDispatch();

  const handleToggle = async (value) => {
    if (value && !isPublic) {
      // Show confirmation dialog when making public
      setShowDialog(true);
    } else {
      await updateVisibility(value);
    }
  };

  const updateVisibility = async (makePublic) => {
    setUpdating(true);
    try {
      const response = await gqlFetch(userId, UPDATE_PROJECT_VISIBILITY, {
        project_id: project.project_id,
        is_public: makePublic,
      });

      if (response?.data?.update_project_by_pk) {
        setIsPublic(makePublic);
        const updatedProject = response.data.update_project_by_pk;

        if (makePublic && updatedProject.slug && updatedProject.user?.slug) {
          // Generate the shareable URL
          const url = `${window.location.origin}/u/${updatedProject.user.slug}/${updatedProject.slug}`;
          setShareUrl(url);
        }
      }
    } catch (error) {
      console.error("Failed to update project visibility:", error);
    } finally {
      setUpdating(false);
      setShowDialog(false);
    }
  };

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error("Failed to copy URL:", error);
    }
  };

  const dialogFooter = (
    <div>
      <Button
        label="Cancel"
        icon="pi pi-times"
        onClick={() => setShowDialog(false)}
        className="p-button-text"
      />
      <Button
        label="Make Public"
        icon="pi pi-globe"
        onClick={() => updateVisibility(true)}
        loading={updating}
        className="p-button-warning"
      />
    </div>
  );

  return (
    <div className="flex align-items-center gap-3">
      <div className="flex align-items-center gap-2">
        <i className={isPublic ? "pi pi-globe" : "pi pi-lock"} />
        <span>{isPublic ? "Public" : "Private"}</span>
        <InputSwitch
          checked={isPublic}
          onChange={(e) => handleToggle(e.value)}
          disabled={updating}
        />
      </div>

      {isPublic && shareUrl && (
        <div className="flex align-items-center gap-2">
          <Button
            icon={copied ? "pi pi-check" : "pi pi-copy"}
            label={copied ? "Copied!" : "Copy Link"}
            onClick={copyToClipboard}
            className="p-button-sm p-button-outlined"
          />
        </div>
      )}

      <Dialog
        header="Make Project Public?"
        visible={showDialog}
        style={{ width: "450px" }}
        footer={dialogFooter}
        onHide={() => setShowDialog(false)}
      >
        <div className="mb-3">
          <Message
            severity="warn"
            text="Making your project public will allow anyone to view and run your code."
          />
        </div>
        <p>
          Once public, your project will be accessible via a shareable link. You
          can make it private again at any time.
        </p>
        <p className="text-xs text-color-secondary mt-2">
          Your project will be visible on your public profile if your profile is
          also public.
        </p>
      </Dialog>
    </div>
  );
}
