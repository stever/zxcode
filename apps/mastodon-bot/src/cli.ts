import { readFile, writeFile } from 'fs/promises';
import { basicToGif } from './gif.js';

// Local end-to-end test of the BASIC -> GIF chain without any Mastodon account.
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

    const result = await basicToGif(code);
    if (!result.ok) {
        console.error('Error:', result.error);
        process.exit(1);
    }

    const out = process.env.OUT ?? 'program.gif';
    await writeFile(out, result.gif);
    console.log(`Wrote ${out} (${result.gif.length} bytes)`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
