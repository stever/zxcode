import React, { useState, useEffect } from "react";
import { Dialog } from "primereact/dialog";
import { Button } from "primereact/button";
import { TabView, TabPanel } from "primereact/tabview";
import { generateRetroSpriteAvatar } from "../lib/retroSpriteAvatar";
import AvatarPixelEditor from "./AvatarPixelEditor";

export default function AvatarSelector({
  visible,
  onHide,
  identifier,
  onSelect,
}) {
  const [selectedVariant, setSelectedVariant] = useState(0);
  const [avatars, setAvatars] = useState([]);
  const [currentPage, setCurrentPage] = useState(0);
  const [randomOffset, setRandomOffset] = useState(0);
  const [activeTab, setActiveTab] = useState(0);
  const [customAvatarUrl, setCustomAvatarUrl] = useState(null);

  const avatarsPerPage = 12;
  const totalPages = 16; // 16 pages x 12 avatars = 192 total variants (with transformations)
  const totalVariants = totalPages * avatarsPerPage;

  useEffect(() => {
    if (visible && identifier) {
      generateAvatarsForPage(currentPage);
      // Always start with the Selection tab when opening
      setActiveTab(0);
    }
  }, [visible, identifier, currentPage, randomOffset]);

  const generateAvatarsForPage = (page) => {
    const newAvatars = [];
    const startIdx = page * avatarsPerPage;

    for (let i = 0; i < avatarsPerPage; i++) {
      // Apply random offset to cycle through all possible variants
      const variant = (startIdx + i + randomOffset) % totalVariants;
      newAvatars.push({
        variant,
        url: generateRetroSpriteAvatar(identifier, 80, variant),
      });
    }
    setAvatars(newAvatars);
  };

  const handleSelect = (variant) => {
    setSelectedVariant(variant);
  };

  const handleConfirm = () => {
    if (activeTab === 1 && customAvatarUrl) {
      // Custom avatar from editor
      onSelect("custom");
    } else {
      // Selected from gallery
      onSelect(selectedVariant);
    }
    onHide();
  };

  const handleCustomAvatarSave = (variant, dataUri) => {
    setCustomAvatarUrl(dataUri);
    onSelect("custom");
    onHide();
  };

  const handleRandomize = () => {
    // Shuffle all avatars by applying a random offset
    const newOffset = Math.floor(Math.random() * totalVariants);
    setRandomOffset(newOffset);
    // Reset to first page to show the new selection
    setCurrentPage(0);
    // Select the first avatar in the new shuffled set
    setSelectedVariant(newOffset % totalVariants);
  };

  const footer =
    activeTab === 0 ? (
      <div className="flex justify-content-between align-items-center">
        <div className="flex gap-1 align-items-center">
          <Button
            icon="pi pi-chevron-left"
            className="p-button-text p-button-sm"
            onClick={() => setCurrentPage(Math.max(0, currentPage - 1))}
            disabled={currentPage === 0}
          />
          <span
            className="text-sm px-1 avatar-button-min-80"
          >
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
            icon="pi pi-refresh"
            className="p-button-outlined p-button-sm"
            onClick={handleRandomize}
          />
          <Button
            label="Cancel"
            className="p-button-text p-button-sm"
            onClick={onHide}
          />
          <Button
            label="Select"
            icon="pi pi-check"
            className="p-button-sm"
            onClick={handleConfirm}
          />
        </div>
      </div>
    ) : null;

  return (
    <Dialog
      header="Choose Your Avatar"
      visible={visible}
      onHide={onHide}
      footer={footer}
      className="avatar-selector-dialog"
    >
      <TabView
        activeIndex={activeTab}
        onTabChange={(e) => setActiveTab(e.index)}
      >
        <TabPanel header="Selection">
          <div className="text-center mb-5 mt-3">
            <p className="text-500">Each pattern is unique to your username.</p>
          </div>

          <div className="grid">
            {avatars.map((avatar) => (
              <div key={avatar.variant} className="col-3 p-2">
                <div
                  className={`avatar-option cursor-pointer border-round p-2 ${
                    selectedVariant === avatar.variant
                      ? "border-primary border-3"
                      : "border-1 border-transparent hover:border-300"
                  }`}
                  onClick={() => handleSelect(avatar.variant)}
                  style={{
                    transition: "all 0.2s",
                    backgroundColor:
                      selectedVariant === avatar.variant
                        ? "var(--primary-color-alpha-10)"
                        : "transparent",
                    boxShadow:
                      selectedVariant === avatar.variant
                        ? "0 0 0 2px var(--primary-color-alpha-20)"
                        : "none",
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

          <div className="text-center mt-2 avatar-preview-centered">
            <small className="text-500">
              Tip: Use arrow buttons to browse more patterns, or click Randomize
              for a surprise!
            </small>
          </div>
        </TabPanel>

        <TabPanel header="Create Your Own">
          <AvatarPixelEditor
            identifier={identifier}
            onSave={handleCustomAvatarSave}
            onCancel={onHide}
          />
        </TabPanel>
      </TabView>
    </Dialog>
  );
}
