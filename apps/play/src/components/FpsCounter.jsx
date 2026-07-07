import React, {useEffect, useState} from "react";

// Discreet emulated-frames-per-second readout, bottom-right. The zxgo engine
// publishes window.__zxgoFps once per second (frames EXECUTED, so 50 means
// full speed on any display refresh rate); under the jsspeccy engine the
// value is absent and the counter renders nothing.
export default function FpsCounter() {
    const [fps, setFps] = useState(null);

    useEffect(() => {
        const t = setInterval(() => {
            setFps(typeof window.__zxgoFps === 'number' ? window.__zxgoFps : null);
        }, 1000);
        return () => clearInterval(t);
    }, []);

    if (fps === null) return null;

    return (
        <div style={{
            position: 'fixed',
            right: '6px',
            bottom: '4px',
            font: '11px monospace',
            color: '#889',
            opacity: 0.65,
            pointerEvents: 'none',
            zIndex: 1000,
        }}>
            {fps} fps
        </div>
    );
}
