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
    sdcc: "orange",
    zmac: "purple",
    zxbasic: "green",
  };
  return colors[lang] || "gray";
}

// The inner card content (thumbnail, language tag + star, title, metadata).
// Shared by every project card so the structure stays identical regardless of
// how the surrounding wrapper navigates: ProjectCard wraps it in a Link, while
// the profile's SortableProjectCard wraps it with drag-and-drop behaviour. The
// author line is optional and passed in pre-formatted, so callers can supply
// whatever author shape their query returns ("@slug" on the feed, greeting name
// on profiles).
export function ProjectCardBody({ project, author, onStarToggle }) {
  const { t } = useTranslation();
  const locale = useDateFnsLocale();

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
        <StarButton projectId={project.project_id} onToggle={onStarToggle} />
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

// Read-only project card shared by the activity feed and the public profile
// (other users' public projects and starred projects).
export default function ProjectCard({ project, projectUrl, author, onStarToggle }) {
  return (
    <div style={{ flexBasis: "400px", flexGrow: 0, flexShrink: 0 }}>
      <Link to={projectUrl} className="no-underline">
        <Card
          className="h-full hover:shadow-5 transition-all transition-duration-200 cursor-pointer overflow-hidden card-bg-dark"
          style={{ border: "none" }}
        >
          <ProjectCardBody
            project={project}
            author={author}
            onStarToggle={onStarToggle}
          />
        </Card>
      </Link>
    </div>
  );
}
