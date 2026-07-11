declare module 'txt2bas' {
    export interface File2BasOptions {
        filename?: string;
        format?: '3dos' | 'tap';
        validate?: boolean;
        bank?: boolean;
    }

    /**
     * Tokenise NextBASIC source into a PLUS3DOS program or a program TAP.
     * Throws an Error (message includes the offending line) on parse errors.
     */
    export function file2bas(
        source: string,
        options?: File2BasOptions | string,
        format?: string,
    ): Uint8Array;
}
