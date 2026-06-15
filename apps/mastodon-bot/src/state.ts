import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { config } from './config.js';

export interface BotState {
    lastNotificationId: string | null;
}

export async function loadState(): Promise<BotState> {
    try {
        const raw = await readFile(config.stateFile, 'utf8');
        const parsed = JSON.parse(raw) as Partial<BotState>;
        return { lastNotificationId: parsed.lastNotificationId ?? null };
    } catch {
        return { lastNotificationId: null };
    }
}

export async function saveState(state: BotState): Promise<void> {
    await mkdir(dirname(config.stateFile), { recursive: true }).catch(() => undefined);
    await writeFile(config.stateFile, JSON.stringify(state), 'utf8');
}
