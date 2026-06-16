import React, { useState } from "react";

// Tilted corner thumbnail for a project card. Shows a rendered screenshot of
// the project (a square, border-padded PNG from gif-service); falls back to the
// static cartridge graphic when there's no screenshot yet, the project isn't
// public, or it can't be rendered (e.g. zmac/sdcc).
export default function ProjectThumbnail({ projectId, updatedAt }) {
  const [failed, setFailed] = useState(false);
  const version = updatedAt ? Date.parse(updatedAt) || 0 : 0;
  const showShot = Boolean(projectId) && !failed;

  return (
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
        // Screenshots are the real content, so show them opaque; the cartridge
        // fallback keeps its original faded decoration look.
        opacity: showShot ? 1 : 0.7,
      }}
    >
      <img
        src={showShot ? `/screenshots/${projectId}.png?v=${version}` : "/assets/images/zx-square.png"}
        alt=""
        onError={showShot ? () => setFailed(true) : undefined}
        style={{ width: "94%", height: "94%", objectFit: "cover", margin: "3%" }}
      />
    </div>
  );
}
