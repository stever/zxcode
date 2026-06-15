import express from 'express';
import tapeRoutes from './routes/tape.js';
import basicRoutes from './routes/basic.js';
import projectRoutes from './routes/project.js';

const app = express();
const PORT = process.env.PORT || 5001;

app.use(express.json({ limit: '256kb' }));
app.use(express.text({ type: 'text/plain', limit: '256kb' }));
app.use('/api', tapeRoutes);
app.use('/api', basicRoutes);
app.use('/api', projectRoutes);

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

app.listen(PORT, () => {
    console.log(`GIF service listening on port ${PORT}`);
});
