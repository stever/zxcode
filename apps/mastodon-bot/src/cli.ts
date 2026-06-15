import { readFile, writeFile } from 'fs/promises';
import { basicToMedia } from './media.js';

// Local end-to-end test of the BASIC -> MP4 chain without any Mastodon account.
// Usage:
//   GIF_SERVICE_URL=http://localhost:5001 npm run cli -- program.bas
//   echo '10 PRINT "HI"' | GIF_SERVICE_URL=http://localhost:5001 npm run cli

async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
    const fileArg = process.argv[2];
    const code = fileArg ? await readFile(fileArg, 'utf8') : await readStdin();
    if (!code.trim()) {
        console.error('No BASIC source provided (pass a file path or pipe via stdin)');
        process.exit(1);
    }

    const result = await basicToMedia(code);
    if (!result.ok) {
        console.error('Error:', result.error);
        process.exit(1);
    }

    const out = process.env.OUT ?? result.filename;
    await writeFile(out, result.data);
    console.log(`Wrote ${out} (${result.data.length} bytes)`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
