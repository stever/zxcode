import express from 'express';
import tapeRoutes from './routes/tape.js';

const app = express();
const PORT = process.env.PORT || 5001;

app.use(express.json());
app.use('/api', tapeRoutes);

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

app.listen(PORT, () => {
    console.log(`GIF service listening on port ${PORT}`);
});
