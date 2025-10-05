import React, { useState, useEffect } from "react";
import { Dialog } from "primereact/dialog";
import { Button } from "primereact/button";
import { generateRetroPatternAvatar } from "../lib/retroPatternAvatar";

export default function AvatarSelector({
  visible,
  onHide,
  identifier,
  onSelect,
}) {
  const [selectedVariant, setSelectedVariant] = useState(0);
  const [avatars, setAvatars] = useState([]);
  const [currentPage, setCurrentPage] = useState(0);

  const avatarsPerPage = 12;
  const totalPages = 10; // 10 pages x 12 avatars = 120 total variants

  useEffect(() => {
    if (visible && identifier) {
      generateAvatarsForPage(currentPage);
    }
  }, [visible, identifier, currentPage]);

  const generateAvatarsForPage = (page) => {
    const newAvatars = [];
    const startIdx = page * avatarsPerPage;

    for (let i = 0; i < avatarsPerPage; i++) {
      const variant = startIdx + i;
      newAvatars.push({
        variant,
        url: generateRetroPatternAvatar(identifier, 80, variant),
      });
    }
    setAvatars(newAvatars);
  };

  const handleSelect = (variant) => {
    setSelectedVariant(variant);
  };

  const handleConfirm = () => {
    onSelect(selectedVariant);
    onHide();
  };

  const handleRandomize = () => {
    // Jump to a random page and select a random avatar
    const randomPage = Math.floor(Math.random() * totalPages);
    const randomIndex = Math.floor(Math.random() * avatarsPerPage);
    setCurrentPage(randomPage);
    setSelectedVariant(randomPage * avatarsPerPage + randomIndex);
  };

  const footer = (
    <div className="flex justify-content-between align-items-center">
      <div className="flex gap-1 align-items-center">
        <Button
          icon="pi pi-chevron-left"
          className="p-button-text p-button-sm"
          onClick={() => setCurrentPage(Math.max(0, currentPage - 1))}
          disabled={currentPage === 0}
        />
        <span className="text-sm px-1" style={{ minWidth: '80px', textAlign: 'center' }}>
          Page {currentPage + 1}/{totalPages}
        </span>
        <Button
          icon="pi pi-chevron-right"
          className="p-button-text p-button-sm"
          onClick={() =>
            setCurrentPage(Math.min(totalPages - 1, currentPage + 1))
          }
          disabled={currentPage === totalPages - 1}
        />
      </div>
      <div className="flex gap-2">
        <Button
          label="Randomize"
          icon="pi pi-shuffle"
          className="p-button-outlined p-button-sm"
          onClick={handleRandomize}
        />
        <Button label="Cancel" className="p-button-text p-button-sm" onClick={onHide} />
        <Button label="Select" icon="pi pi-check" className="p-button-sm" onClick={handleConfirm} />
      </div>
    </div>
  );

  return (
    <Dialog
      header="Choose Your Avatar"
      visible={visible}
      onHide={onHide}
      footer={footer}
      style={{ width: "600px" }}
      className="avatar-selector-dialog"
    >
      <div className="text-center mb-3">
        <p className="text-500">Each pattern is unique to your username.</p>
      </div>

      <div className="grid">
        {avatars.map((avatar) => (
          <div key={avatar.variant} className="col-3 p-2">
            <div
              className={`avatar-option cursor-pointer border-round p-2 hover:surface-hover ${
                selectedVariant === avatar.variant
                  ? "border-primary border-2"
                  : "border-1 border-300"
              }`}
              onClick={() => handleSelect(avatar.variant)}
              style={{
                transition: "all 0.2s",
                backgroundColor:
                  selectedVariant === avatar.variant
                    ? "var(--primary-100)"
                    : "transparent",
              }}
            >
              <img
                src={avatar.url}
                alt={`Avatar variant ${avatar.variant}`}
                className="w-full"
                style={{
                  imageRendering: "pixelated", // Keeps pixels crisp
                  width: "100%",
                  height: "auto",
                }}
              />
            </div>
          </div>
        ))}
      </div>

      <div className="text-center mt-3">
        <small className="text-500">
          Tip: Use arrow buttons to browse more patterns, or click Randomize for
          a surprise!
        </small>
      </div>
    </Dialog>
  );
}
