import express from 'express';
import tapeRoutes from './routes/tape.js';
import basicRoutes from './routes/basic.js';
import projectRoutes from './routes/project.js';
import sourceRoutes from './routes/source.js';
import screenshotRoutes from './routes/screenshot.js';
import ogRoutes from './routes/og.js';

// Prefix every Node-side log line with a UTC timestamp. The Go core's slog
// output is already timestamped; this brings the JS logs in line so render
// timings (capture vs encode) are readable straight from `docker logs`.
for (const level of ['log', 'warn', 'error'] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => orig(new Date().toISOString(), ...args);
}

// Safety net: a single bad render must never take down the whole service. Log
// and keep serving rather than letting an unhandled error exit the process
// (each request is independent and stateless).
process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));

const app = express();
const PORT = process.env.PORT || 5001;

app.use(express.json({ limit: '256kb' }));
app.use(express.text({ type: 'text/plain', limit: '256kb' }));
app.use('/api', tapeRoutes);
app.use('/api', basicRoutes);
app.use('/api', projectRoutes);
app.use('/api', sourceRoutes);
// Public, read-only screenshots (only this path is exposed via the proxy).
app.use('/screenshots', screenshotRoutes);
// OpenGraph cards for /u/* and /projects/* — the proxy routes only social
// crawlers here; real users get the SPA.
app.use(ogRoutes);

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

app.listen(PORT, () => {
    console.log(`GIF service listening on port ${PORT}`);
});
