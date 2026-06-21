import React, { useEffect } from "react";
import { useSelector, useDispatch } from "react-redux";
import { Titled } from "react-titled";
import { Card } from "primereact/card";
import { ProgressSpinner } from "primereact/progressspinner";
import { Message } from "primereact/message";
import { Paginator } from "primereact/paginator";
import { fetchActivityFeed } from "../redux/social/actions";
import ProjectCard from "./ProjectCard";
import { useTranslation } from "@zxplay/i18n";
import { sep } from "../constants";

export default function ActivityFeed() {
  const { t } = useTranslation();
  const dispatch = useDispatch();

  const currentUserId = useSelector((state) => state?.identity.userId);
  const activityFeed = useSelector((state) => state?.social.activityFeed || []);
  const feedLoading = useSelector((state) => state?.social.feedLoading);
  const feedPage = useSelector((state) => state?.social.feedPage || 0);
  const feedTotalCount = useSelector(
    (state) => state?.social.feedTotalCount || 0
  );
  const feedPageSize = useSelector((state) => state?.social.feedPageSize || 20);

  useEffect(() => {
    if (currentUserId) {
      dispatch(fetchActivityFeed(feedPage));
    }
  }, [currentUserId, feedPage, dispatch]);

  const handlePageChange = (event) => {
    dispatch(fetchActivityFeed(event.page));
  };

  if (!currentUserId) {
    return (
      <Card className="m-2">
        <Message severity="info" text={t("feed.loginPrompt")} />
      </Card>
    );
  }

  if (feedLoading) {
    return (
      <div className="flex justify-content-center align-items-center spinner-container-centered">
        <ProgressSpinner />
      </div>
    );
  }

  return (
    <Titled title={(s) => `${t("nav.feed")} ${sep} ${s}`}>
      <div className="m-2">
        <Card title={t("nav.feed")}>
          <p className="text-500 mb-4">
            {t("feed.subtitle")}
            {feedTotalCount > 0 && (
              <span className="ml-2">
                {t("feed.showing", {
                  first: feedPage * feedPageSize + 1,
                  last: Math.min(
                    (feedPage + 1) * feedPageSize,
                    feedTotalCount
                  ),
                  total: feedTotalCount,
                })}
              </span>
            )}
          </p>

          {activityFeed.length > 0 ? (
            <>
              <div className="flex flex-wrap gap-3 align-items-start">
                {activityFeed.map((project) => {
                  const userSlug = project.owner?.slug;
                  const projectUrl =
                    project.slug && userSlug
                      ? `/u/${userSlug}/${project.slug}`
                      : `/projects/${project.project_id}`;

                  return (
                    <ProjectCard
                      key={project.project_id}
                      project={project}
                      projectUrl={projectUrl}
                      author={`@${
                        userSlug || project.owner?.greeting_name || "unknown"
                      }`}
                    />
                  );
                })}
              </div>

              {feedTotalCount > feedPageSize && (
                <Paginator
                  first={feedPage * feedPageSize}
                  rows={feedPageSize}
                  totalRecords={feedTotalCount}
                  onPageChange={handlePageChange}
                  className="mt-3"
                />
              )}
            </>
          ) : (
            <div className="text-center py-4">
              <i className="pi pi-inbox text-4xl text-300 mb-3" />
              <p className="text-500">{t("feed.none")}</p>
              <p className="text-sm">{t("feed.followHint")}</p>
            </div>
          )}
        </Card>
      </div>
    </Titled>
  );
}
