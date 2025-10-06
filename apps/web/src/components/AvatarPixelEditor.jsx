import React, { useState, useEffect } from "react";
import { Button } from "primereact/button";

// ZX Spectrum color palette
const SPECTRUM_COLORS = [
  { name: "Black", value: "#000000" },
  { name: "Blue", value: "#0000D7" },
  { name: "Red", value: "#D70000" },
  { name: "Magenta", value: "#D700D7" },
  { name: "Green", value: "#00D700" },
  { name: "Cyan", value: "#00D7D7" },
  { name: "Yellow", value: "#D7D700" },
  { name: "White", value: "#D7D7D7" },
  { name: "Bright Blue", value: "#0000FF" },
  { name: "Bright Red", value: "#FF0000" },
  { name: "Bright Magenta", value: "#FF00FF" },
  { name: "Bright Green", value: "#00FF00" },
  { name: "Bright Cyan", value: "#00FFFF" },
  { name: "Bright Yellow", value: "#FFFF00" },
  { name: "Bright White", value: "#FFFFFF" },
];

export default function AvatarPixelEditor({ identifier, onSave, onCancel, customAvatarData }) {
  const [grid, setGrid] = useState(() => {
    // Initialize empty 8x8 grid
    return Array(8)
      .fill(null)
      .map(() => Array(8).fill(0));
  });

  const [selectedColor, setSelectedColor] = useState(7); // Start with white
  const [isDrawing, setIsDrawing] = useState(false);
  const [tool, setTool] = useState("paint"); // 'paint' or 'erase'

  // Load saved custom avatar if exists
  useEffect(() => {
    try {
      // First try to load from customAvatarData (from database)
      if (customAvatarData) {
        setGrid(customAvatarData);
        // Also save to localStorage for offline access
        localStorage.setItem(`custom_avatar_${identifier}`, JSON.stringify(customAvatarData));
      } else {
        // Fall back to localStorage if no database data
        const saved = localStorage.getItem(`custom_avatar_${identifier}`);
        if (saved) {
          const savedGrid = JSON.parse(saved);
          setGrid(savedGrid);
        }
      }
    } catch (e) {
      console.error("Failed to load saved avatar:", e);
    }
  }, [identifier, customAvatarData]);

  const handlePixelClick = (row, col) => {
    const newGrid = [...grid];
    if (tool === "erase") {
      newGrid[row][col] = 0; // Black/transparent
    } else {
      newGrid[row][col] = selectedColor;
    }
    setGrid(newGrid);
  };

  const handleMouseDown = (row, col) => {
    setIsDrawing(true);
    handlePixelClick(row, col);
  };

  const handleMouseEnter = (row, col) => {
    if (isDrawing) {
      handlePixelClick(row, col);
    }
  };

  const handleMouseUp = () => {
    setIsDrawing(false);
  };

  const clearGrid = (e) => {
    e.currentTarget.blur();
    setGrid(
      Array(8)
        .fill(null)
        .map(() => Array(8).fill(0))
    );
  };

  const fillGrid = (e) => {
    e.currentTarget.blur();
    setGrid(
      Array(8)
        .fill(null)
        .map(() => Array(8).fill(selectedColor))
    );
  };

  const flipHorizontal = (e) => {
    e.currentTarget.blur();
    const newGrid = grid.map((row) => [...row].reverse());
    setGrid(newGrid);
  };

  const flipVertical = (e) => {
    e.currentTarget.blur();
    const newGrid = [...grid].reverse();
    setGrid(newGrid);
  };

  const generateSvgDataUri = () => {
    const size = 80;
    const pixelSize = size / 8;

    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`;
    svg += `<rect width="${size}" height="${size}" fill="${SPECTRUM_COLORS[0].value}"/>`;

    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const colorIndex = grid[row][col];
        if (colorIndex > 0) {
          const color = SPECTRUM_COLORS[colorIndex].value;
          svg += `<rect x="${col * pixelSize}" y="${
            row * pixelSize
          }" width="${pixelSize}" height="${pixelSize}" fill="${color}"/>`;
        }
      }
    }

    svg += "</svg>";
    const encoded = btoa(unescape(encodeURIComponent(svg)));
    return `data:image/svg+xml;base64,${encoded}`;
  };

  const handleSave = () => {
    try {
      // Save grid to localStorage
      localStorage.setItem(`custom_avatar_${identifier}`, JSON.stringify(grid));

      // Generate data URI and pass to parent
      const dataUri = generateSvgDataUri();
      onSave("custom", dataUri);
    } catch (e) {
      console.error("Failed to save avatar:", e);
    }
  };

  return (
    <div className="pixel-editor">
      <div className="flex gap-3">
        {/* Left side - Drawing canvas */}
        <div className="flex-grow-1">
          <div className="mb-2">
            <h4 className="m-1">Draw Your Avatar</h4>
          </div>

          <div
            className="pixel-canvas user-select-none"
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            style={{
              display: "inline-block",
              border: "2px solid #3a3a3a",
              borderRadius: "4px",
              backgroundColor: "#1a1a1a",
              padding: "8px",
            }}
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(8, 32px)",
                gridTemplateRows: "repeat(8, 32px)",
                gap: "1px",
                backgroundColor: "#3a3a3a",
              }}
            >
              {grid.map((row, rowIndex) =>
                row.map((colorIndex, colIndex) => (
                  <div
                    key={`${rowIndex}-${colIndex}`}
                    style={{
                      width: "32px",
                      height: "32px",
                      backgroundColor: SPECTRUM_COLORS[colorIndex].value,
                      cursor: tool === "erase" ? "crosshair" : "pointer",
                      imageRendering: "pixelated",
                    }}
                    onMouseDown={() => handleMouseDown(rowIndex, colIndex)}
                    onMouseEnter={() => handleMouseEnter(rowIndex, colIndex)}
                  />
                ))
              )}
            </div>
          </div>

          {/* Tools */}
          <div className="mt-3 flex gap-2">
            <Button
              label="Clear"
              icon="pi pi-trash"
              className="p-button-sm p-button-outlined"
              onClick={clearGrid}
            />
            <Button
              label="Fill"
              icon="pi pi-stop"
              className="p-button-sm p-button-outlined"
              onClick={fillGrid}
            />
            <Button
              label="Flip"
              icon="pi pi-arrows-h"
              className="p-button-sm p-button-outlined"
              onClick={flipHorizontal}
            />
            <Button
              label="Flip"
              icon="pi pi-arrows-v"
              className="p-button-sm p-button-outlined"
              onClick={flipVertical}
            />
          </div>
        </div>

        {/* Right side - Color palette and preview */}
        <div style={{ width: "200px" }}>
          <h4 className="m-0 mb-2">Colors</h4>

          {/* Tool selection */}
          <div className="flex gap-1 mb-2">
            <Button
              icon="pi pi-pencil"
              className={`p-button-sm ${
                tool === "paint" ? "" : "p-button-outlined"
              }`}
              onClick={() => setTool("paint")}
            />
            <Button
              icon="pi pi-eraser"
              className={`p-button-sm ${
                tool === "erase" ? "" : "p-button-outlined"
              }`}
              onClick={() => setTool("erase")}
            />
          </div>

          {/* Color palette */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: "4px",
            }}
          >
            {SPECTRUM_COLORS.map((color, index) => (
              <div
                key={index}
                style={{
                  width: "100%",
                  aspectRatio: "1",
                  backgroundColor: color.value,
                  border:
                    selectedColor === index && tool === "paint"
                      ? "3px solid white"
                      : "1px solid #3a3a3a",
                  borderRadius: "4px",
                  cursor: "pointer",
                  boxSizing: "border-box",
                }}
                onClick={() => {
                  setSelectedColor(index);
                  setTool("paint");
                }}
                title={color.name}
              />
            ))}
          </div>

          {/* Preview */}
          <h4 className="mt-3 mb-2">Preview</h4>
          <div
            style={{
              padding: "8px",
              backgroundColor: "#1a1a1a",
              borderRadius: "4px",
              textAlign: "center",
            }}
          >
            <img
              src={generateSvgDataUri()}
              alt="Avatar preview"
              style={{
                width: "80px",
                height: "80px",
                imageRendering: "pixelated",
              }}
            />
          </div>
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex justify-content-end gap-2 mt-3">
        <Button
          label="Cancel"
          className="p-button-text p-button-sm"
          onClick={onCancel}
        />
        <Button
          label="Use This Avatar"
          icon="pi pi-check"
          className="p-button-sm"
          onClick={handleSave}
        />
      </div>
    </div>
  );
}
