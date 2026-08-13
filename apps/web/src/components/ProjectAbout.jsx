import React, { useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { Button } from "primereact/button";
import { Dialog } from "primereact/dialog";
import { InputTextarea } from "primereact/inputtextarea";
import ReactMarkdown from "react-markdown";
import gql from "graphql-tag";
import { gqlFetch } from "../graphql_fetch";
import { setProjectInstructions } from "../redux/project/actions";
import { useTranslation } from "@zxplay/i18n";

const UPDATE_PROJECT_INSTRUCTIONS = gql`
  mutation ($project_id: uuid!, $instructions: String!) {
    update_project_by_pk(
      pk_columns: { project_id: $project_id }
      _set: { instructions: $instructions }
    ) {
      project_id
    }
  }
`;

// Matches the project_instructions_check constraint in the database.
const MAX_LENGTH = 10000;

// "About this program" (#218): one markdown field per project holding the
// owner's instructions and commentary. The owner edits it in a dialog from
// the toolbar; everyone else gets the same button — rendered markdown —
// whenever there is something to read. It saves through its own mutation,
// independent of the code draft, so writing notes never entangles with the
// explicit Save of source changes.
export default function ProjectAbout() {
  const { t } = useTranslation();
  const dispatch = useDispatch();

  const userId = useSelector((state) => state?.identity.userId);
  const ownerId = useSelector((state) => state?.project.ownerId);
  const projectId = useSelector((state) => state?.project.id);
  const instructions = useSelector((state) => state?.project.instructions);
  const isOwner = Boolean(userId && ownerId && userId === ownerId);

  const [visible, setVisible] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  // Readers only see the button when there is something behind it.
  if (!projectId || (!isOwner && !instructions)) {
    return null;
  }

  const open = () => {
    setDraft(instructions || "");
    setVisible(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const response = await gqlFetch(userId, UPDATE_PROJECT_INSTRUCTIONS, {
        project_id: projectId,
        instructions: draft,
      });
      if (response?.data?.update_project_by_pk) {
        dispatch(setProjectInstructions(draft));
        setVisible(false);
      }
    } catch (error) {
      console.error("Failed to save project instructions:", error);
    } finally {
      setSaving(false);
    }
  };

  const ownerFooter = (
    <>
      <Button
        label={t("actions.cancel")}
        icon="pi pi-times"
        onClick={() => setVisible(false)}
        className="p-button-text"
      />
      <Button
        label={t("actions.save")}
        icon="pi pi-save"
        onClick={save}
        loading={saving}
        autoFocus
      />
    </>
  );

  return (
    <>
      <Button
        label={t("projectAbout.button")}
        icon="pi pi-info-circle"
        className="p-button-outlined"
        onClick={open}
      />
      <Dialog
        header={t("projectAbout.title")}
        visible={visible}
        className="editor-dialog-50vw"
        onHide={() => setVisible(false)}
        footer={isOwner ? ownerFooter : undefined}
      >
        {isOwner ? (
          <div className="flex flex-column gap-2">
            <InputTextarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={12}
              autoResize={false}
              className="w-full"
              maxLength={MAX_LENGTH}
              placeholder={t("projectAbout.placeholder")}
              autoFocus
            />
            <small>{t("projectAbout.hint")}</small>
          </div>
        ) : (
          <div className="project-about-content">
            <ReactMarkdown>{instructions}</ReactMarkdown>
          </div>
        )}
      </Dialog>
    </>
  );
}
