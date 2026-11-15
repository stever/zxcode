import React from "react";
import PropTypes from "prop-types";
import { Message } from "primereact/message";
import { useTranslation } from "@zxplay/i18n";

// Stands in for the emulator on a project stored for the ZX Spectrum Next,
// which the site no longer runs. The code stays viewable; the owner is told
// how to retarget the project (the toolbar's machine toggle), which brings
// the emulator back.
NextUnsupportedPanel.propTypes = {
  width: PropTypes.number,
  height: PropTypes.number,
  isOwner: PropTypes.bool,
};

export default function NextUnsupportedPanel({ width, height, isOwner }) {
  const { t } = useTranslation();
  return (
    <div
      className="flex align-items-center justify-content-center p-3"
      style={{ width: width ? `${width}px` : undefined, minHeight: height ? `${height}px` : undefined }}
    >
      <Message
        severity="warn"
        text={t(isOwner ? "editor.nextUnsupportedOwner" : "editor.nextUnsupported")}
      />
    </div>
  );
}
