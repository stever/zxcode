import React, { useEffect } from "react";
import { useSelector, useDispatch } from "react-redux";
import { Link } from "react-router-dom";
import { Titled } from "react-titled";
import { Card } from "primereact/card";
import { Tag } from "primereact/tag";
import { ProgressSpinner } from "primereact/progressspinner";
import { Message } from "primereact/message";
import { Paginator } from "primereact/paginator";
import { formatDistanceToNow } from "date-fns";
import { fetchActivityFeed } from "../redux/social/actions";
import { getLanguageLabel } from "../lib/lang";
import { sep } from "../constants";

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

export default function ActivityFeed() {
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
        <Message
          severity="info"
          text="Please log in to view your activity feed"
        />
      </Card>
    );
  }

  if (feedLoading) {
    return (
      <div
        className="flex justify-content-center align-items-center min-height-400"
      >
        <ProgressSpinner />
      </div>
    );
  }

  return (
    <Titled title={(s) => `Feed ${sep} ${s}`}>
      <div className="m-2">
        <Card title="Feed">
          <p className="text-500 mb-4">
            Recent projects from users you follow
            {feedTotalCount > 0 && (
              <span className="ml-2">
                (showing {feedPage * feedPageSize + 1} -{" "}
                {Math.min((feedPage + 1) * feedPageSize, feedTotalCount)} of{" "}
                {feedTotalCount})
              </span>
            )}
          </p>

          {activityFeed.length > 0 ? (
            <>
              <div className="flex flex-wrap gap-3">
                {activityFeed.map((project) => {
                  const userSlug = project.owner?.slug;
                  const projectUrl =
                    project.slug && userSlug
                      ? `/u/${userSlug}/${project.slug}`
                      : `/projects/${project.project_id}`;

                  return (
                    <div
                      key={project.project_id}
                      style={{
                        flexBasis: "448px",
                        flexGrow: 0,
                        flexShrink: 0,
                      }}
                    >
                      <Link to={projectUrl} className="no-underline">
                        <Card
                          className="h-full hover:shadow-5 transition-all transition-duration-200 cursor-pointer overflow-hidden card-bg-dark"
                          style={{
                            border: "none",
                          }}
                        >
                          <div className="flex flex-column h-full relative">
                            {/* Background icon in corner */}
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
                                opacity: 0.7,
                              }}
                            >
                              <img
                                src="/assets/images/zx-square.png"
                                alt=""
                                style={{
                                  width: "94%",
                                  height: "94%",
                                  objectFit: "cover",
                                  margin: "3%",
                                }}
                              />
                            </div>

                            <h3 className="mb-2 text-white relative z-1">
                              {project.title}
                            </h3>

                            <Tag
                              value={getLanguageLabel(project.lang)}
                              severity={getLanguageColor(project.lang)}
                              className="align-self-start mb-3 relative z-1"
                            />

                            <div className="mt-auto text-400 text-sm relative z-1">
                              <div>
                                by @
                                {userSlug ||
                                  project.owner?.greeting_name ||
                                  "unknown"}
                              </div>
                              <div>
                                Updated{" "}
                                {formatDistanceToNow(
                                  new Date(project.updated_at),
                                  { addSuffix: true }
                                )}
                              </div>
                            </div>
                          </div>
                        </Card>
                      </Link>
                    </div>
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
              <p className="text-500">No activity yet</p>
              <p className="text-sm">
                Follow other users to see their public projects here
              </p>
            </div>
          )}
        </Card>
      </div>
    </Titled>
  );
}
