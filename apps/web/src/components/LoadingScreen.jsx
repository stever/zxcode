import React from "react";
import {ProgressSpinner} from "primereact/progressspinner";

export default function LoadingScreen() {
    return (
        <div className="dashboard-loading-screen">
            <ProgressSpinner/>
        </div>
    )
}
