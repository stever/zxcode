import React, { useState } from "react";
import PropTypes from "prop-types";
import { useDispatch } from "react-redux";
import { Titled } from "react-titled";
import { Card } from "primereact/card";
import { InputText } from "primereact/inputtext";
import { Button } from "primereact/button";
import { createNewProject } from "../redux/project/actions";
import { getLanguageLabel } from "../lib/lang";
import { sep } from "../constants";

NewProjectPage.propTypes = {
  type: PropTypes.string.isRequired,
};

export default function NewProjectPage(props) {
  const dispatch = useDispatch();
  const [title, setTitle] = useState("");
  const lang = getLanguageLabel(props.type);

  return (
    <Titled title={(s) => `New Project ${sep} ${s}`}>
      <Card className="m-2">
        <h1>New {lang} Project</h1>
        <h3>Project Name</h3>
        <div className="field">
          <InputText
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus={true}
            onKeyDown={(e) => {
              if (e.code === "Enter") {
                dispatch(createNewProject(props.type, title));
              }
            }}
          />
        </div>
        <Button
          label="Create Project"
          onClick={() => dispatch(createNewProject(props.type, title))}
        />
      </Card>
    </Titled>
  );
}
