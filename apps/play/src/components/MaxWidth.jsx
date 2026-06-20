import React from "react";

export default function MaxWidth(props) {
    return (
        <div style={{maxWidth: '1024px', margin: 'auto'}}>
            {props.children}
        </div>
    )
}
