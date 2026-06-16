import React, { useState } from "react";

// Corner thumbnail for a project card. Shows a rendered screenshot of the
// project (with the ZX rainbow ribbon baked into a corner by gif-service);
// falls back to the static cartridge graphic when there's no screenshot yet,
// the project isn't public, or the render failed.
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
        overflow: "hidden",
        // Screenshots read cleaner upright and opaque; the cartridge fallback
        // keeps its original tilted, translucent look.
        transform: showShot ? "none" : "rotate(12deg)",
        opacity: showShot ? 1 : 0.7,
      }}
    >
      {showShot ? (
        <img
          src={`/screenshots/${projectId}.png?v=${version}`}
          alt=""
          onError={() => setFailed(true)}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        <img
          src="/assets/images/zx-square.png"
          alt=""
          style={{ width: "94%", height: "94%", objectFit: "cover", margin: "3%" }}
        />
      )}
    </div>
  );
}
