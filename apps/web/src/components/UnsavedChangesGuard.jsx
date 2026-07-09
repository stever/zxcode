import React, { useEffect, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { Button } from "primereact/button";
import { Dialog } from "primereact/dialog";
import { history } from "../redux/store";
import { saveCodeChanges, revertUnsavedChanges } from "../redux/project/actions";
import { selectHasUnsavedChanges } from "../redux/project/selectors";
import { useTranslation } from "@zxplay/i18n";

// Mirrors the route table in App.jsx. While a dirty draft only lives in the
// store, the sole navigations that destroy it are those that load a different
// project (/projects/:id, /u/:user/:slug) or lead to creating one (/new/*).
// Every other page leaves project state alone, so the draft survives and is
// restored on return (see redux/project reducers/sagas).
function destroysDraft(pathname, { id, slug, ownerSlug }) {
  if (pathname.startsWith("/new/")) {
    return true;
  }
  const byId = pathname.match(/^\/projects\/([^/]+)$/);
  if (byId) {
    return byId[1] !== id;
  }
  const bySlug = pathname.match(/^\/u\/([^/]+)\/([^/]+)$/);
  if (bySlug) {
    // These /u/:x/:y routes are not project pages.
    if (["projects", "followers", "following"].includes(bySlug[2])) {
      return false;
    }
    return !(bySlug[1] === ownerSlug && bySlug[2] === slug);
  }
  return false;
}

// Blocks navigation that would destroy unsaved project changes and offers
// save/discard/stay. Mounted once in App so the guard also covers leaving
// from pages the user wandered to while the draft sat in the store (e.g.
// picking another project from the projects list).
export default function UnsavedChangesGuard() {
  const { t } = useTranslation();
  const dispatch = useDispatch();

  const id = useSelector((state) => state?.project.id);
  const slug = useSelector((state) => state?.project.slug);
  const ownerSlug = useSelector((state) => state?.project.ownerSlug);
  const ownerId = useSelector((state) => state?.project.ownerId);
  const userId = useSelector((state) => state?.identity.userId);
  const dirty = useSelector(
    (state) => Boolean(state?.project.id) && selectHasUnsavedChanges(state)
  );

  const isOwner = Boolean(userId && ownerId && userId === ownerId);

  const [pendingTx, setPendingTx] = useState(null);

  useEffect(() => {
    if (!dirty) {
      return undefined;
    }
    let unblock;
    let unlisten;
    const block = () => {
      unblock = history.block((tx) => {
        if (!destroysDraft(tx.location.pathname, { id, slug, ownerSlug })) {
          // Safe destination: let it through, then re-arm once the retried
          // transition has applied. Re-arming synchronously would intercept
          // the retry itself for POP (browser back), where retry() is
          // asynchronous, and loop.
          unblock();
          unlisten = history.listen(() => {
            unlisten();
            unlisten = undefined;
            block();
          });
          tx.retry();
          return;
        }
        setPendingTx(tx);
      });
    };
    block();
    return () => {
      if (unlisten) {
        unlisten();
      }
      unblock();
    };
  }, [dirty, id, slug, ownerSlug]);

  // Save and Discard both make the state clean, which removes the block
  // above; the deferred navigation can then complete. A failed save leaves
  // the state dirty and the dialog open.
  useEffect(() => {
    if (pendingTx && !dirty) {
      pendingTx.retry();
      setPendingTx(null);
    }
  }, [pendingTx, dirty]);

  return (
    <Dialog
      header={t("editor.unsavedTitle")}
      visible={Boolean(pendingTx)}
      modal
      className="editor-dialog-50vw"
      onHide={() => setPendingTx(null)}
      footer={
        <>
          <Button
            label={t("actions.cancel")}
            icon="pi pi-times"
            className="p-button-text"
            onClick={() => setPendingTx(null)}
          />
          <Button
            label={t("editor.discard")}
            icon="pi pi-trash"
            className="p-button-outlined p-button-danger"
            onClick={() => dispatch(revertUnsavedChanges())}
          />
          {isOwner && (
            <Button
              label={t("actions.save")}
              icon="pi pi-save"
              autoFocus
              onClick={() => dispatch(saveCodeChanges())}
            />
          )}
        </>
      }
    >
      <p className="m-0">
        {isOwner ? t("editor.unsavedMessage") : t("editor.unsavedMessageNoSave")}
      </p>
    </Dialog>
  );
}
