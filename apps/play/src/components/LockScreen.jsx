import React from "react";

export default function LockScreen() {
    return (
        <React.Fragment>
            <div className="dashboard-lock-screen" style={styles.fullPage}/>
            <div className="dashboard-lock-screen" style={styles.contentBlanker}/>
            <div className="dashboard-lock-screen" style={styles.container}>
                <div className="center-screen">

                </div>
            </div>
        </React.Fragment>
    )
}

const styles = {
    fullPage: {
        position: 'absolute',
        top: 0,
        left: 0,
        margin: 0,
        padding: 0,
        zIndex: 99999,
        width: '100%',
        height: '100vh',
        display: 'none',
        userSelect: 'none'
    },
    contentBlanker: {
        position: 'fixed',
        top: 0,
        left: 0,
        margin: 0,
        padding: 0,
        zIndex: 99999,
        width: '100%',
        height: '100vh',
        backgroundColor: 'black',
        opacity: 0.05,
        display: 'none',
        userSelect: 'none'
    },
    container: {
        position: 'absolute',
        top: 0,
        left: 0,
        margin: 0,
        padding: 0,
        zIndex: 99999,
        width: '100%',
        height: '100vh',
        display: 'none',
        userSelect: 'none'
    }
};
