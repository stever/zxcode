import React from "react";
import { Link } from "react-router-dom";
import { Card } from "primereact/card";
import { Tag } from "primereact/tag";
import { formatDistanceToNow } from "date-fns";
import { getLanguageLabel } from "../lib/lang";
import ProjectThumbnail from "./ProjectThumbnail";
import StarButton from "./StarButton";
import { useTranslation, useDateFnsLocale } from "@zxplay/i18n";

function getLanguageColor(lang) {
  const colors = {
    asm: "purple",
    basic: "blue",
    bas2tap: "blue",
    c: "orange",
    forth: "yellow",
    pascal: "cyan",
    sdcc: "orange",
    sjasmplus: "purple",
    zmac: "purple",
    zxbasic: "green",
  };
  return colors[lang] || "gray";
}

// Badge text for the project's target machine. Only the non-default machines
// get a badge — a plain 48K card stays as it was — so the label is a short
// model name rather than the full selector labels ("Spectrum 128K"), which
// would crowd the tag row. Machine names are proper nouns; like the language
// labels above they aren't translated.
function getMachineBadge(machine) {
  const badges = {
    128: "128K",
    next: "Next",
  };
  return badges[machine] || null;
}

// The inner card content (thumbnail, language tag + star, title, metadata).
// Shared by every project card so the structure stays identical regardless of
// how the surrounding wrapper navigates: ProjectCard wraps it in a Link, while
// the profile's SortableProjectCard wraps it with drag-and-drop behaviour. The
// author line is optional and passed in pre-formatted, so callers can supply
// whatever author shape their query returns ("@slug" on the feed, greeting name
// on profiles). showPublic adds a "Public" badge — only meaningful on the
// owner's own project browser, where public is the exception; feed/profile
// cards are all public so they don't pass it. onMenuClick, when given, adds a
// "..." button to the tag row (the browser's rename/copy/delete menu).
export function ProjectCardBody({ project, author, onStarToggle, showPublic, onMenuClick }) {
  const { t } = useTranslation();
  const locale = useDateFnsLocale();
  const machineBadge = getMachineBadge(project.machine);

  return (
    <div className="flex flex-column h-full relative" style={{ minHeight: "160px" }}>
      <ProjectThumbnail
        projectId={project.project_id}
        updatedAt={project.updated_at}
      />

      <div
        className="flex align-items-stretch gap-2 mb-2 align-self-start relative z-1"
        style={{ marginTop: "-0.5rem" }}
      >
        <Tag
          value={getLanguageLabel(project.lang)}
          severity={getLanguageColor(project.lang)}
          className="lang-tag"
        />
        {machineBadge && <Tag value={machineBadge} className="machine-tag" />}
        {showPublic && project.is_public && (
          <Tag
            value={t("projectList.public")}
            icon="pi pi-globe"
            className="machine-tag"
          />
        )}
        <StarButton projectId={project.project_id} onToggle={onStarToggle} />
        {onMenuClick && (
          <button
            type="button"
            onClick={(e) => {
              // Cards are wrapped in a Link; the menu must not navigate.
              e.preventDefault();
              e.stopPropagation();
              onMenuClick(e, project);
            }}
            title={t("projectList.actions")}
            aria-label={t("projectList.actions")}
            aria-haspopup="menu"
            style={{
              // Match the StarButton's outlined-chip look, including the
              // card-surface fill that keeps it readable over the thumbnail.
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              background: "var(--zx-surface)",
              border: "1px solid #6c757d",
              borderRadius: "6px",
              padding: "0.3rem 0.45rem",
              color: "#c0c0c0",
              cursor: "pointer",
            }}
          >
            <i
              className="pi pi-ellipsis-h"
              style={{ display: "block", fontSize: "0.8rem" }}
            />
          </button>
        )}
      </div>

      <h3 className="mb-2 text-white relative z-1">{project.title}</h3>

      <div className="mt-auto text-400 text-sm relative z-1">
        {author && (
          <div className="mb-1">
            {t("feed.by")} {author}
          </div>
        )}
        <div>
          {t("feed.updated")}{" "}
          {formatDistanceToNow(new Date(project.updated_at), {
            addSuffix: true,
            locale,
          })}
        </div>
      </div>
    </div>
  );
}

// Read-only project card shared by the activity feed, the public profile
// (other users' public projects and starred projects) and the owner's own
// project browser (which passes showPublic).
export default function ProjectCard({ project, projectUrl, author, onStarToggle, showPublic, onMenuClick }) {
  return (
    <div style={{ flexBasis: "400px", flexGrow: 0, flexShrink: 0 }}>
      <Link to={projectUrl} className="no-underline">
        <Card
          className="h-full hover:shadow-5 transition-all transition-duration-200 cursor-pointer overflow-hidden card-bg-dark project-card"
          style={{ border: "none" }}
        >
          <ProjectCardBody
            project={project}
            author={author}
            onStarToggle={onStarToggle}
            showPublic={showPublic}
            onMenuClick={onMenuClick}
          />
        </Card>
      </Link>
    </div>
  );
}
