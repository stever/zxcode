import React, { useState } from "react";

// Size of the ZX rainbow ribbon baked into the bottom-right corner of a
// screenshot thumbnail (square, so the diagonal stays at 45deg). Tweak here.
const RIBBON_SIZE = "44px";

// Tilted corner thumbnail for a project card. The box is 4:3 to match the
// Spectrum screenshot's aspect, so the rendered PNG from gif-service fills it
// exactly with no crop (only the tilt trims the corners). Screenshots get a
// small diagonal rainbow ribbon in the corner (the same one the cartridge
// shows full-size). Falls back to the static cartridge graphic when there's no
// screenshot yet, the project isn't public, or it can't be rendered (e.g.
// zmac/sdcc) — that already carries the ribbon, so no overlay is added.
export default function ProjectThumbnail({ projectId, updatedAt }) {
  const [failed, setFailed] = useState(false);
  const version = updatedAt ? Date.parse(updatedAt) || 0 : 0;
  const showShot = Boolean(projectId) && !failed;

  return (
    <div
      className="absolute"
      style={{
        // Vertically centred so the padding around the (tilted) screenshot stays
        // balanced regardless of card height, keeping cards of differing content
        // lengths visually consistent.
        top: "50%",
        right: "-5px",
        width: "160px",
        height: "120px",
        background: "#000",
        borderRadius: "20px",
        transform: "translateY(-50%) rotate(12deg)",
        overflow: "hidden",
        // Screenshots are the real content, so show them opaque; the cartridge
        // fallback keeps its original faded decoration look.
        opacity: showShot ? 1 : 0.7,
      }}
    >
      <img
        src={showShot ? `/screenshots/${projectId}.png?v=${version}` : "/assets/images/zx-card.png"}
        alt=""
        onError={showShot ? () => setFailed(true) : undefined}
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />
      {showShot && (
        <img
          src="/assets/images/zx-ribbon.png"
          alt=""
          aria-hidden="true"
          style={{
            position: "absolute",
            right: 0,
            bottom: 0,
            width: RIBBON_SIZE,
            height: RIBBON_SIZE,
            pointerEvents: "none",
          }}
        />
      )}
    </div>
  );
}
